import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";

const execFileAsync = promisify(execFile);

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/;

export class RepoError extends Error {
  code: "INVALID_URL" | "NOT_FOUND" | "PRIVATE_OR_EMPTY" | "TOO_LARGE" | "GRAPH_FAILED" | "CLONE_FAILED";
  constructor(code: RepoError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function parseGithubUrl(rawUrl: string): { owner: string; repo: string } {
  const match = GITHUB_URL_RE.exec(rawUrl.trim());
  if (!match) {
    throw new RepoError(
      "INVALID_URL",
      "That doesn't look like a public GitHub repo URL (expected https://github.com/owner/repo)."
    );
  }
  const [, owner, repo] = match;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

// Confirms the repo exists and is public *before* we shell out to git clone,
// so obviously bad input never reaches child_process.
export async function verifyRepoIsPublic(owner: string, repo: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "codebase-agent" },
  });

  if (res.status === 404) {
    throw new RepoError("NOT_FOUND", "Repo not found. It may be private, misspelled, or deleted.");
  }
  if (!res.ok) {
    throw new RepoError("NOT_FOUND", `GitHub API returned ${res.status} while checking the repo.`);
  }

  const data = await res.json();
  if (data.private) {
    throw new RepoError("PRIVATE_OR_EMPTY", "This repo is private. Only public repos are supported.");
  }
  if (data.size === 0) {
    throw new RepoError("PRIVATE_OR_EMPTY", "This repo appears to be empty.");
  }
  // GitHub reports `size` in KB. Refuse anything absurd before we clone it.
  // GitHub's `size` field is the bare repo's total disk usage -- history,
  // branches, everything -- not what a --depth 1 shallow clone actually
  // pulls down (just the current HEAD tree of one branch). A repo with years
  // of accumulated history but a modest current codebase (e.g. a mature
  // monorepo) can report a huge `size` here while still shallow-cloning in
  // seconds. So this is deliberately a high sanity ceiling for pathological
  // cases only (an absurdly large working tree itself, which WOULD slow a
  // depth-1 clone), not a real predictor of clone time -- the clone's own
  // timeout in cloneRepo() below is the actual backstop for that.
  const MAX_KB = 5_000_000; // ~5GB sanity ceiling, not a clone-time estimate
  if (data.size > MAX_KB) {
    throw new RepoError("TOO_LARGE", "This repo is too large for a live shallow clone in this demo.");
  }
}

export async function cloneRepo(cloneUrl: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  try {
    // execFile (not exec) with an argv array avoids shell interpolation --
    // the URL was already validated against GITHUB_URL_RE, but this is the
    // real reason the injection surface is closed.
    // Timeout matched to runGraphify()'s 120s below rather than kept short --
    // this is the real backstop against a slow shallow clone now that the
    // pre-check above no longer tries to predict clone time from GitHub's
    // (history-inclusive) `size` field. A depth-1 clone that's still running
    // after 2 minutes is the actual signal something's wrong, not a rough
    // guess made before touching the network at all.
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--single-branch", cloneUrl, "."],
      { cwd: destDir, timeout: 120_000 }
    );
  } catch (err) {
    throw new RepoError("CLONE_FAILED", "git clone failed. The repo may be unavailable.");
  }
}

export interface GraphSummary {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

export async function runGraphify(destDir: string): Promise<GraphSummary> {
  try {
    // --code-only skips the semantic-extraction pass (docs/PDFs/images via an
    // LLM backend) entirely, so this only ever does local tree-sitter AST
    // parsing -- no API key needed, no extra host dependency, no per-repo
    // LLM cost, and no chance of a doc/config file bringing down the whole
    // run just because a semantic backend wasn't configured. This also
    // matches the original "deterministic AST extraction" framing this
    // project is built around: we want graph.json to be structural, code-only
    // facts, not LLM-inferred edges from a README.
    await execFileAsync("graphify", [".", "--code-only"], { cwd: destDir, timeout: 120_000 });
  } catch (err: any) {
    // Log the real stderr server-side so failures are debuggable -- swallowing
    // it (as this used to) meant nobody, including us, could tell a notebook
    // repo, a timeout, and a missing binary apart.
    console.error("[graphify] failed for", destDir, "\nstderr:", err?.stderr ?? err?.message ?? err);
    throw new RepoError(
      "GRAPH_FAILED",
      "Couldn't build a code map for this repo -- its structure or file mix isn't supported yet."
    );
  }

  const graphPath = `${destDir}/graphify-out/graph.json`;
  let raw: string;
  try {
    raw = await fs.readFile(graphPath, "utf-8");
  } catch {
    console.error("[graphify] exited cleanly but produced no graph.json in", destDir);
    throw new RepoError("GRAPH_FAILED", "Couldn't build a code map for this repo.");
  }

  const graph = JSON.parse(raw);
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const files = new Set(nodes.map((n: any) => n.file).filter(Boolean));

  return { fileCount: files.size, nodeCount: nodes.length, edgeCount: edges.length };
}