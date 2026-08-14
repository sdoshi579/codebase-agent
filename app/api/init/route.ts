import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import {
  RepoError,
  cloneRepo,
  parseGithubUrl,
  runGraphify,
  verifyRepoIsPublic,
} from "@/lib/git";
import {
  createSession,
  destroySession,
  ensureSessionRoot,
  sessionDir,
  setGenerating,
  setGraphStatus,
  setSummary,
} from "@/lib/sessions";
import { checkRateLimit, clientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";
// Only bounds the clone step now, not clone+graphify -- see the
// fire-and-forget graphify call below. Kept modest since a shallow clone
// timing out this fast is itself a useful signal (see cloneRepo's own
// internal 300s timeout as the harder backstop).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      { status: 429 }
    );
  }

  let body: { repoUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return NextResponse.json({ error: "repoUrl is required." }, { status: 400 });
  }

  let owner: string, repo: string;
  try {
    ({ owner, repo } = parseGithubUrl(body.repoUrl));
    await verifyRepoIsPublic(owner, repo);
  } catch (err) {
    if (err instanceof RepoError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return NextResponse.json({ error: "Failed to validate repo." }, { status: 500 });
  }

  await ensureSessionRoot();
  const sessionId = uuidv4();
  const dir = sessionDir(sessionId);
  const session = createSession(sessionId, body.repoUrl);

  // Clone stays synchronous -- it's the one step the session genuinely can't
  // exist without (read_file needs files on disk). It's also normally fast:
  // a --depth 1 shallow clone, not the whole repo's history.
  try {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    await cloneRepo(cloneUrl, dir);
  } catch (err) {
    await destroySession(sessionId);
    if (err instanceof RepoError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return NextResponse.json({ error: "Unexpected error while cloning the repo." }, { status: 500 });
  }

  // graphify runs in the background, NOT awaited in the sense of blocking
  // this response -- it's the slow, CPU-bound part (AST parsing every file),
  // and there's no reason to make the user wait through it when read_file
  // already works on the cloned repo alone. query_graph checks
  // session.graphStatus and reports "still indexing" rather than failing
  // while this is in flight -- see runQueryGraph in app/api/chat/route.ts.
  //
  // This is a bare fire-and-forget promise, deliberately -- Next's after()
  // was tried here first but doesn't exist in this project's pinned Next
  // 14.2.15 (`unstable_after` was introduced later than that; a real build
  // failure confirmed this, not a guess). The risk after() protects against
  // -- a detached promise getting killed once a serverless function's
  // response is sent -- doesn't apply to how this app is actually deployed:
  // Render runs `next start` as one genuinely persistent, long-running Node
  // process (see the hosting guide), not per-request serverless functions,
  // so the Node event loop keeps this promise running to completion
  // regardless of the HTTP response having already been returned below. If
  // this project is ever deployed to a serverless platform instead (Vercel,
  // etc), this exact call would need revisiting -- either via after() once
  // available in whatever Next version is running there, or a real job
  // queue. The loud logging below means silence can't hide whether this
  // ran: if "[init] starting background graphify" never prints, the call
  // site itself isn't being reached, which is a different, more obvious
  // problem to chase than a graphify hang.
  const startGraphify = async () => {
    console.log(`[init] starting background graphify for session ${sessionId} (${dir})`);
    try {
      const graphSummary = await runGraphify(dir);
      console.log(
        `[init] graphify finished for session ${sessionId}: ${graphSummary.fileCount} files, ${graphSummary.nodeCount} nodes, ${graphSummary.edgeCount} edges`
      );
      setSummary(
        sessionId,
        `Graph generated: ${graphSummary.fileCount} files, ${graphSummary.nodeCount} nodes, ${graphSummary.edgeCount} edges.`
      );
      setGraphStatus(sessionId, "ready");
    } catch (err) {
      const message = err instanceof RepoError ? err.message : "Code graph indexing failed unexpectedly.";
      console.error("[init] background graphify failed for session", sessionId, "\n", err);
      setGraphStatus(sessionId, "failed", message);
      // Without this, session.summary stays stuck at "" forever (only the
      // success path ever wrote to it), so the header kept showing the
      // original "Repo cloned. Indexing..." placeholder text side-by-side
      // with a "failed" badge that contradicted it -- confusing regardless
      // of what actually caused the failure.
      setSummary(sessionId, "Repo cloned. Code graph indexing failed -- read_file still works for docs/config.");
    }
  };

  void startGraphify();

  setGenerating(sessionId, false);
  return NextResponse.json({
    sessionId,
    summary: session.summary || "Repo cloned. Indexing the code graph in the background -- ask away now.",
    graphStatus: "pending",
  });
}