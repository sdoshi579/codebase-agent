import { NextRequest } from "next/server";
import { streamText, tool } from "ai";
import { z } from "zod";
import { getOpenAiModel, getOpenRouterModel, hasOpenRouterFallback, isOpenAiProvider } from "@/lib/llm";
import { isGeminiProvider, streamInteraction } from "@/lib/geminiInteractions";
import { buildSystemPrompt } from "@/lib/systemPrompt";
import {
  getExpiresAt,
  getSession,
  setGenerating,
  setLastInteractionId,
  setLastOpenAiResponseId,
  touchSession,
  type Session,
} from "@/lib/sessions";
import { loadGraph, queryGraph, getGraphOverview, type Graph } from "@/lib/graph";
import { readRepoFile } from "@/lib/files";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_AGENT_STEPS = 6;

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseQueryGraphArgs(raw: unknown): { nodeName: string; edgeType?: string } {
  const args = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nodeName = typeof args.nodeName === "string" ? args.nodeName.trim() : "";
  const edgeType = typeof args.edgeType === "string" ? args.edgeType : undefined;
  return { nodeName, edgeType };
}

// graphStatus is threaded in alongside graph itself: with graphify now
// running in the background (see app/api/init/route.ts), a session can be
// live for chat well before graph.json exists at all. Calling query_graph
// during that window should say so plainly, not silently return an empty
// graph (indistinguishable from "this repo really has no matches") or crash
// on a missing file.
function runQueryGraph(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  args: unknown,
  emit: (chunk: Uint8Array) => void
) {
  if (graphStatus === "pending") {
    return {
      error:
        "Code graph is still indexing in the background. Try again shortly, or use read_file for docs/config in the meantime.",
    };
  }
  if (graphStatus === "failed") {
    return { error: `Code graph indexing failed for this repo${graphError ? `: ${graphError}` : "."} Use read_file instead.` };
  }

  const { nodeName, edgeType } = parseQueryGraphArgs(args);
  if (!nodeName) {
    return { error: "nodeName is required." };
  }

  const result = queryGraph(graph, { nodeName, edgeType });
  emit(sseEncode("tool_call", { nodeName, edgeType, matches: result.matchedNodes.length }));
  return {
    matchedNodes: result.matchedNodes.slice(0, 15),
    edges: result.edges.slice(0, 30).map((e) => ({
      type: e.edge.type,
      direction: e.direction,
      neighbor: e.neighbor
        ? { name: e.neighbor.name ?? e.neighbor.id, file: e.neighbor.file ?? "" }
        : null,
    })),
  };
}

function runGraphOverview(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  args: unknown,
  emit: (chunk: Uint8Array) => void
) {
  if (graphStatus === "pending") {
    return { error: "Code graph is still indexing in the background. Try again shortly." };
  }
  if (graphStatus === "failed") {
    return { error: `Code graph indexing failed for this repo${graphError ? `: ${graphError}` : "."}` };
  }
  const limitRaw = args && typeof args === "object" ? (args as Record<string, unknown>).limit : undefined;
  const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.min(limitRaw, 25) : 10;
  const overview = getGraphOverview(graph, limit);
  emit(sseEncode("tool_call", { graphOverview: true, mostConnectedCount: overview.mostConnected.length }));
  return overview;
}

async function runReadFile(
  repoRoot: string,
  args: unknown,
  emit: (chunk: Uint8Array) => void
) {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const filePath = a.path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { error: "path is required." };
  }
  const startLine = typeof a.startLine === "number" ? a.startLine : undefined;
  const endLine = typeof a.endLine === "number" ? a.endLine : undefined;
  const result = await readRepoFile(repoRoot, filePath, startLine, endLine);
  emit(sseEncode("tool_call", { path: filePath, lines: result.linesShown, found: !result.error }));
  return result;
}

// Google's Interactions API returns a normal HTTP error for quota/rate-limit
// exhaustion (429 / RESOURCE_EXHAUSTED), which geminiInteractions.ts surfaces
// either as a plain Error built from the HTTP status/body, or (for in-stream
// errors like quota_exceeded) from the SSE error event's message/code -- see
// the "must be checked before anything else" block in streamInteraction().
// This is a string match on that message rather than a typed error because
// geminiInteractions.ts doesn't currently distinguish error causes -- if that
// changes, prefer a real error code/class over this.
function isGeminiQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /\b429\b/.test(err.message) || /RESOURCE_EXHAUSTED/i.test(err.message) || /quota/i.test(err.message);
}

// Shared by the OpenAI and OpenRouter paths (both go through the AI SDK's
// tool() + zod), so the read_file/query_graph schemas are defined once.
function buildToolSet(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  repoRoot: string,
  emit: (chunk: Uint8Array) => void
) {
  return {
    query_graph: tool({
      description:
        "Look up a node by name in the repo's AST graph and return its edges (calls/imports/extends/etc). Use before stating any code path.",
      parameters: z.object({
        nodeName: z.string().describe("Node name to search for, e.g. a function, class, or file."),
        edgeType: z
          .string()
          .optional()
          .describe("Optional edge type filter, e.g. 'calls', 'imports', 'extends'."),
      }),
      execute: async ({ nodeName, edgeType }) =>
        runQueryGraph(graph, graphStatus, graphError, { nodeName, edgeType }, emit),
    }),
    read_file: tool({
      description:
        "Read the raw text of a file directly from the repo (README, package.json, go.mod, config, source code, etc). query_graph only sees AST metadata -- names, files, line numbers, edges -- it NEVER returns actual source code. To show a function's real implementation: first query_graph the function name to get its file and line, then call read_file with that path and startLine set to that line number to get the actual code around it.",
      parameters: z.object({
        path: z.string().describe("Path relative to the repo root, e.g. 'README.md' or 'src/handlers.go'."),
        startLine: z
          .number()
          .optional()
          .describe(
            "Optional. 1-indexed line to center on -- use the `line` field from a query_graph match here to pull just that function's region instead of the whole file."
          ),
        endLine: z
          .number()
          .optional()
          .describe("Optional. End of the range, if the region spans multiple known lines. Defaults to startLine."),
      }),
      execute: async ({ path, startLine, endLine }) => runReadFile(repoRoot, { path, startLine, endLine }, emit),
    }),
    graph_overview: tool({
      description:
        "Get whole-graph stats: total nodes/edges, counts by type, and the most-connected nodes (by in+out edge count -- a defensible proxy for 'central' or 'important'). Use this for questions like 'what's the most important file', 'what's central to this codebase', or 'give me an overview' -- query_graph can't answer these, it only looks up one named node at a time.",
      parameters: z.object({
        limit: z.number().optional().describe("How many top-connected nodes to return. Defaults to 10."),
      }),
      execute: async ({ limit }) => runGraphOverview(graph, graphStatus, graphError, { limit }, emit),
    }),
  };
}

async function runGeminiAgent(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  repoRoot: string,
  system: string,
  message: string,
  emit: (chunk: Uint8Array) => void,
  initialInteractionId: string | undefined
): Promise<string | undefined> {
  let input: string | Parameters<typeof streamInteraction>[0]["input"] = message;
  // Thread the session's last interaction id through so this turn continues
  // the same conversation server-side instead of starting fresh -- see
  // lastInteractionId in lib/sessions.ts for why this matters.
  let previousInteractionId: string | undefined = initialInteractionId;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const result = await streamInteraction({
      input,
      // Only worth (re-)sending the system instruction on a genuinely new
      // conversation thread or the first step of this turn's own tool loop --
      // once previousInteractionId carries state, the API already has it.
      systemInstruction: step === 0 && !initialInteractionId ? system : undefined,
      previousInteractionId,
      onTextDelta: (text) => emit(sseEncode("token", { text })),
    });

    previousInteractionId = result.interactionId;

    if (result.status !== "requires_action" || result.functionCalls.length === 0) {
      return previousInteractionId;
    }

    input = await Promise.all(
      result.functionCalls.map(async (call) => {
        let toolOutput: unknown = { error: `Unknown tool: ${call.name}` };
        if (call.name === "query_graph") {
          toolOutput = runQueryGraph(graph, graphStatus, graphError, call.arguments, emit);
        } else if (call.name === "read_file") {
          toolOutput = await runReadFile(repoRoot, call.arguments, emit);
        } else if (call.name === "graph_overview") {
          toolOutput = runGraphOverview(graph, graphStatus, graphError, call.arguments, emit);
        }
        return {
          type: "function_result" as const,
          name: call.name,
          call_id: call.id,
          result: {
            content: [{ type: "text" as const, text: JSON.stringify(toolOutput) }],
          },
        };
      })
    );
  }

  // Loop exhausted MAX_AGENT_STEPS while the model was still requesting more
  // tool calls (status stayed "requires_action" every iteration) -- without
  // this, the turn just ends with whatever text happened to stream before
  // the cutoff, which can be nothing at all if the model was still gathering
  // context and hadn't started composing an answer yet. Silent truncation
  // reads as a broken/empty response; this at least tells the person why.
  emit(sseEncode("token", { text: "\n\n*(Hit the tool-call limit for this turn -- try narrowing the question.)*" }));
  return previousInteractionId;
}

// Fallback-only path: OpenRouter's free router, used when Gemini itself is
// out of quota mid-session. Deliberately simpler than runOpenAiAgent -- no
// previousResponseId continuation, since OpenRouter speaks Chat Completions,
// not the Responses API. A turn served here has no memory of earlier turns.
async function runOpenRouterAgent(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  repoRoot: string,
  system: string,
  message: string,
  emit: (chunk: Uint8Array) => void
): Promise<void> {
  const result = await streamText({
    model: getOpenRouterModel(),
    system,
    prompt: message,
    maxSteps: MAX_AGENT_STEPS,
    tools: buildToolSet(graph, graphStatus, graphError, repoRoot, emit),
  });

  if (!result.textStream) {
    throw new Error("OpenRouter streamText returned no textStream.");
  }

  for await (const delta of result.textStream) {
    emit(sseEncode("token", { text: delta }));
  }
}

async function runOpenAiAgent(
  graph: Graph,
  graphStatus: Session["graphStatus"],
  graphError: string | undefined,
  repoRoot: string,
  system: string,
  message: string,
  emit: (chunk: Uint8Array) => void,
  initialResponseId: string | undefined
): Promise<string | undefined> {
  const result = await streamText({
    model: getOpenAiModel(),
    system,
    prompt: message,
    maxSteps: MAX_AGENT_STEPS,
    providerOptions: {
      openai: {
        // Continues the same server-side conversation instead of starting a
        // fresh, memory-less one each turn -- OpenAI's equivalent of Gemini's
        // previous_interaction_id. `system` above is still resent every turn
        // on purpose: unlike Gemini, previousResponseId does not carry the
        // prior instructions/system message forward.
        previousResponseId: initialResponseId,
      },
    },
    tools: buildToolSet(graph, graphStatus, graphError, repoRoot, emit),
  });

  if (!result.textStream) {
    throw new Error("OpenAI streamText returned no textStream.");
  }

  for await (const delta of result.textStream) {
    emit(sseEncode("token", { text: delta }));
  }

  // Response id for this turn arrives via providerMetadata once the stream
  // finishes -- capture it so the next turn in this session can continue the
  // conversation instead of starting cold. Named interface instead of `as
  // any` for basic type safety, but this doesn't reduce the real uncertainty
  // here: the shape below is inferred from a GitHub discussion snippet, not
  // verified against the actual installed @ai-sdk/openai version. If it's
  // wrong, responseId just comes back undefined and the next turn starts
  // fresh (same as today) rather than throwing -- log
  // JSON.stringify(await result.providerMetadata) once against a real turn
  // to confirm the real key path if this doesn't seem to be working.
  interface OpenAiProviderMetadata {
    openai?: { responseId?: string };
  }
  const metadata = (await result.providerMetadata) as OpenAiProviderMetadata | undefined;
  return metadata?.openai?.responseId;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return new Response(JSON.stringify({ error: "Too many requests." }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { sessionId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Malformed JSON body." }), { status: 400 });
  }

  const { sessionId, message } = body;
  if (!sessionId || !message) {
    return new Response(JSON.stringify({ error: "sessionId and message are required." }), {
      status: 400,
    });
  }

  const session = getSession(sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: "Session not found or expired." }), {
      status: 404,
    });
  }

  if (session.isGenerating) {
    return new Response(JSON.stringify({ error: "A response is already in progress." }), {
      status: 429,
    });
  }

  touchSession(sessionId);
  setGenerating(sessionId, true);

  // Only attempt to load graph.json when graphify has actually reported
  // "ready" -- attempting this while indexing is still "pending" would throw
  // (the file doesn't exist yet), which used to 500 the whole chat turn
  // instead of just degrading query_graph gracefully. An empty graph is a
  // safe placeholder either way, since runQueryGraph() checks graphStatus
  // before ever touching it.
  let graph: Graph = { nodes: [], edges: [] };
  if (session.graphStatus === "ready") {
    try {
      graph = await loadGraph(sessionId, session.graphPath);
    } catch {
      // Treat an unreadable graph.json the same as "failed" rather than
      // 500ing the turn -- read_file and general chat should still work.
      graph = { nodes: [], edges: [] };
    }
  }

  const system = buildSystemPrompt(session.summary, session.repoUrl);
  const useGemini = isGeminiProvider();
  const useOpenAi = isOpenAiProvider();
  if (!useGemini && !useOpenAi) {
    setGenerating(sessionId, false);
    return new Response(JSON.stringify({ error: "Unsupported LLM_PROVIDER." }), { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (chunk: Uint8Array) => controller.enqueue(chunk);
      try {
        if (useGemini) {
          try {
            const nextInteractionId = await runGeminiAgent(
              graph,
              session.graphStatus,
              session.graphError,
              session.path,
              system,
              message,
              emit,
              session.lastInteractionId
            );
            setLastInteractionId(sessionId, nextInteractionId);
          } catch (geminiErr) {
            if (isGeminiQuotaError(geminiErr) && hasOpenRouterFallback()) {
              console.warn(
                "[chat] Gemini quota hit for session",
                sessionId,
                "-- falling back to OpenRouter free router.",
                geminiErr
              );
              emit(sseEncode("token", { text: "*(Gemini quota reached -- falling back to a free model.)*\n\n" }));
              // No session interaction id to persist here: this turn didn't
              // go through Gemini, and the fallback path has no
              // conversation-continuation mechanism of its own (see
              // runOpenRouterAgent). The NEXT turn will still try Gemini
              // first and resume its own thread from session.lastInteractionId
              // as normal -- only this one turn is served differently.
              await runOpenRouterAgent(
                graph,
                session.graphStatus,
                session.graphError,
                session.path,
                system,
                message,
                emit
              );
            } else {
              throw geminiErr;
            }
          }
        } else {
          const nextResponseId = await runOpenAiAgent(
            graph,
            session.graphStatus,
            session.graphError,
            session.path,
            system,
            message,
            emit,
            session.lastOpenAiResponseId
          );
          setLastOpenAiResponseId(sessionId, nextResponseId);
        }
        emit(sseEncode("done", {}));
      } catch (err) {
        // Same lesson as runGraphify()'s stderr fix: never swallow the real
        // error into a generic message without logging it server-side first,
        // or failures become undiagnosable from the client alone.
        const errorMsg = err instanceof Error ? err.message : "Agent failed to produce a response.";
        console.error("[chat] agent failed for session", sessionId, "\n", err);
        emit(sseEncode("token", { text: "Not able to answer your question. Please try again." }));
        emit(sseEncode("error", { message: errorMsg }));
      } finally {
        setGenerating(sessionId, false);
        touchSession(sessionId);
        // Emitted after touchSession, not before -- session.lastActive is the
        // same object reference getSession() returned earlier in this
        // handler, so it already reflects the just-updated timestamp here.
        // This is what "refresh expiry every time a message is sent" is
        // actually keyed off client-side, not a guess or a separate timer.
        emit(sseEncode("session", { expiresAt: getExpiresAt(session) }));
        controller.close();
      }
    },
    cancel() {
      setGenerating(sessionId, false);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}