import fs from "fs/promises";
import path from "path";

// Cap kept small on purpose -- this is a tool result the LLM has to read,
// same token-cost reasoning as queryGraph's 15/30 caps. A truncated README is
// still far more useful than none at all.
const MAX_READ_CHARS = 12_000;

const BINARY_EXT_BLOCKLIST = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar",
  ".gz", ".exe", ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".bin", ".class", ".jar", ".wasm",
]);

export interface ReadFileResult {
  path: string;
  content?: string;
  truncated?: boolean;
  error?: string;
  linesShown?: string; // e.g. "42-58", only set when a line range was requested
}

// graphify runs with --code-only (see lib/git.ts), which deliberately never
// puts README/package.json/config files into the AST graph -- query_graph
// has no way to see them. Without this tool the agent was answering
// setup/usage questions from generic language conventions instead of the
// repo's actual instructions (e.g. guessing "go run main.go" for a repo
// whose README said something else entirely). This reads one file's raw
// text directly off the cloned repo on disk instead.
//
// startLine/endLine (1-indexed, inclusive) let a caller who already knows
// roughly where something is -- e.g. from query_graph's `line` field on a
// matched node -- pull just that region instead of the whole file. This
// matters for two reasons: query_graph only ever returns AST metadata (name,
// file, line, edges), never the actual source text of a function body, so
// "show me the implementation of X" requires this two-step lookup to work at
// all; and without a line range, a function near the end of a large file
// could fall past MAX_READ_CHARS and never be seen. A few lines of padding
// are added on both sides so a function definition landing exactly on the
// requested line isn't cut off by an off-by-one in whatever reported it.
export async function readRepoFile(
  repoRoot: string,
  relativePath: string,
  startLine?: number,
  endLine?: number
): Promise<ReadFileResult> {
  const cleanRel = relativePath.replace(/^[/\\]+/, "").trim();
  if (!cleanRel) {
    return { path: relativePath, error: "path is required." };
  }

  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, cleanRel);

  // Reject path traversal outside the cloned repo dir regardless of how many
  // ../ segments the model tries. path.relative + checking for a leading
  // ".." is the standard idiom for this (vs. manual startsWith(root +
  // path.sep) string comparison) -- functionally equivalent here since
  // path.resolve already normalizes both sides, but this avoids relying on
  // getting the separator concatenation exactly right across platforms.
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { path: relativePath, error: "Path escapes the repository root." };
  }

  const ext = path.extname(resolved).toLowerCase();
  if (BINARY_EXT_BLOCKLIST.has(ext)) {
    return { path: relativePath, error: "Binary file type, not readable as text." };
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return { path: relativePath, error: "Not a file (directory or special file)." };
    }
    const raw = await fs.readFile(resolved, "utf-8");

    if (typeof startLine === "number") {
      const lines = raw.split("\n");
      const PADDING = 3;
      const from = Math.max(1, startLine - PADDING);
      const to = Math.min(lines.length, (endLine ?? startLine) + PADDING);
      const slice = lines.slice(from - 1, to).join("\n");
      return { path: relativePath, content: slice, linesShown: `${from}-${to}` };
    }

    if (raw.length > MAX_READ_CHARS) {
      return { path: relativePath, content: raw.slice(0, MAX_READ_CHARS), truncated: true };
    }
    return { path: relativePath, content: raw };
  } catch {
    return { path: relativePath, error: "File not found in this repo." };
  }
}