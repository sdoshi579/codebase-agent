import { NextRequest, NextResponse, unstable_after as after } from "next/server";
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
  // This is wrapped in Next's `after()`, not a bare fire-and-forget promise.
  // A plain `runGraphify(dir).then(...)` left dangling after the response
  // returns is NOT reliably guaranteed to keep running in Next.js App
  // Router -- that's not just a serverless/Vercel caveat, it's why `after()`
  // exists as an API at all (stable in Next 15, available as
  // `unstable_after` since 14.1, which is what's imported above given this
  // project pins Next 14.2.15). A prior version of this code used a bare
  // fire-and-forget call and produced sessions that stayed "pending"
  // indefinitely with zero server logs -- total silence, meaning the work
  // never ran at all, not that graphify hung. `after()` is the fix for that
  // class of bug. The loud logging below also means silence can't happen
  // again even if this diagnosis turns out to be wrong for some case: if
  // "[init] starting background graphify" never prints, the call site itself
  // isn't being reached, which is a different, more obvious problem to chase.
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
    }
  };

  if (typeof after === "function") {
    after(startGraphify);
  } else {
    // Fallback if unstable_after isn't available in whatever Next version is
    // actually installed -- same known-unreliable pattern as before, but
    // better than throwing, and the logging above will at least make that
    // unreliability visible instead of silent.
    console.warn("[init] next/server unstable_after unavailable -- falling back to a bare fire-and-forget call.");
    void startGraphify();
  }

  setGenerating(sessionId, false);
  return NextResponse.json({
    sessionId,
    summary: session.summary || "Repo cloned. Indexing the code graph in the background -- ask away now.",
    graphStatus: "pending",
  });
}