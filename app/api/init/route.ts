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

  // graphify runs in the background, not awaited by this response -- it's
  // the slow, CPU-bound part (AST parsing every file), and read_file already
  // works on the cloned repo alone without it. session.graphStatus tracks
  // this separately (see lib/sessions.ts); query_graph reports "still
  // indexing" while it's in flight rather than failing.
  //
  // Deliberately a bare fire-and-forget promise, not Next's after() -- this
  // app runs as a persistent `next start` process (see the hosting guide),
  // not per-request serverless functions, so the Node event loop keeps this
  // running to completion regardless of the response having already
  // returned below. If this is ever deployed serverless instead, this call
  // needs revisiting (after(), or a real job queue). The logging below
  // exists so silence is diagnosable: if "[init] starting background
  // graphify" never prints, the call site itself isn't being reached.
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
      // Keeps the header from showing a stale "Indexing..." placeholder
      // next to a "failed" badge -- only the success path used to update
      // summary, so failure left it stuck at its initial placeholder text.
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