# codebase-agent

Chat with the execution flow of any public GitHub repo. `graphifyy` parses the
repo's AST into `graph.json`; the LLM only answers by querying that graph, and
renders flow diagrams as Mermaid.

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Vercel AI SDK (`ai`) for the streaming tool-calling loop — OpenAI
  `gpt-4o-mini` or Gemini `1.5-flash`, switchable via `LLM_PROVIDER`
- In-memory sessions + `/tmp/sessions/{id}` clones, no database
- SSE for streaming (`text/event-stream`, no WebSocket infra needed)

## Setup

```bash
npm install
cp .env.example .env.local   # fill in one provider's API key
```

Host requirements (not npm-installable, must exist on the box running this):

```bash
python3 --version   # 3.10+
pip install graphifyy
git --version
```

```bash
npm run dev
```

## How a session works

1. `POST /api/init` — validates the URL against GitHub's API (public, non-empty,
   under a size ceiling) *before* touching `child_process`, shallow-clones it
   into `/tmp/sessions/{uuid}`, runs `graphify .`, registers the session in
   the in-memory `Map`.
2. `POST /api/chat` — loads that session's `graph.json` (cached in memory
   per-session), runs `streamText` with a single `query_graph` tool, streams
   tokens back over SSE. One request in flight per session
   (`isGenerating` lock → `429`), plus a 20-req/15-min IP limiter.
3. A background sweep (`lib/sessions.ts`) runs every minute and deletes any
   session idle past 15 minutes — both the in-memory entry and its cloned
   directory. A chat request against a reaped session gets a `404`, which the
   frontend turns into the "session expired" modal.

## Design notes

- **Why one tool, not several.** `query_graph(nodeName, edgeType)` is
  deliberately narrow. It keeps each tool round-trip's payload small (the
  route caps results to 15 nodes / 30 edges per call), which is most of the
  actual token-cost lever — "Caveman Mode" terse prompting in
  `lib/systemPrompt.ts` does the rest.
- **Why `execFile`, not `exec`.** Both `git clone` and `graphify` run with an
  argv array, not a shell string, so a malicious `repoUrl` can't break out
  into shell injection even though it's also pre-validated by regex + the
  GitHub API check.
- **Why SSE over the AI SDK's default data-stream response.** The spec calls
  for SSE explicitly; `app/api/chat/route.ts` hand-rolls a small `ReadableStream`
  emitting `token`, `tool_call`, `done`, and `error` events so the frontend's
  fetch-based reader stays simple and framework-agnostic.

## Known gaps / things to adapt to your real `graphifyy` output

- `lib/graph.ts` assumes `graph.json` looks like
  `{ nodes: [{id, name, type, file, line}], edges: [{source, target, type}] }`.
  If your installed `graphifyy` emits a different shape, adjust the types and
  `queryGraph()` there — everything downstream (the tool, the summary counts
  in `/api/init`) reads through that one module.
- No auth, no persistence, by design — this mirrors the ephemeral requirement.
  Don't put this behind anything that assumes chat history survives a refresh.
- Rate limiting and the session map are both process-local `Map`s. Fine for a
  single instance; move both to a shared store before running >1 replica.
