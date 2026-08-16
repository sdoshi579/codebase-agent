import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { readRepoFile } from "./files";

let repoRoot: string;

beforeEach(async () => {
  // Real filesystem, not mocked -- this function's entire job is path
  // resolution and traversal rejection, which is exactly the kind of logic
  // that's easy to get subtly wrong and where a mock would hide the bug.
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-agent-test-"));
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test Repo\nSetup instructions here.");
  await fs.mkdir(path.join(repoRoot, "src"));
  await fs.writeFile(
    path.join(repoRoot, "src", "main.go"),
    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
  );
  // A file genuinely outside the repo root, to prove traversal actually
  // reaches something real if the guard fails -- not just a hypothetical.
  await fs.writeFile(path.join(os.tmpdir(), "codebase-agent-test-secret.txt"), "should never be readable");
});

afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  await fs.rm(path.join(os.tmpdir(), "codebase-agent-test-secret.txt"), { force: true });
});

describe("readRepoFile", () => {
  it("reads an existing file's content", async () => {
    const result = await readRepoFile(repoRoot, "README.md");
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Setup instructions here.");
  });

  it("reads a file in a subdirectory", async () => {
    const result = await readRepoFile(repoRoot, "src/main.go");
    expect(result.error).toBeUndefined();
    expect(result.content).toContain("line 1");
  });

  it("rejects ../ path traversal out of the repo root", async () => {
    const result = await readRepoFile(repoRoot, "../codebase-agent-test-secret.txt");
    expect(result.error).toBe("Path escapes the repository root.");
    expect(result.content).toBeUndefined();
  });

  it("rejects deeply nested ../../../ traversal attempts", async () => {
    const result = await readRepoFile(repoRoot, "../../../../../../etc/passwd");
    expect(result.error).toBe("Path escapes the repository root.");
  });

  it("neutralizes a leading-slash absolute path into a repo-relative one, rather than rejecting it", async () => {
    // /etc/passwd never actually reaches path.resolve as an absolute path --
    // readRepoFile strips leading slashes first (see the `cleanRel` line),
    // so this becomes "etc/passwd" resolved *inside* repoRoot, not a real
    // escape attempt. It correctly 404s because <repoRoot>/etc/passwd
    // doesn't exist in the test fixture, not because traversal was detected.
    // (Original version of this test asserted the traversal-rejection
    // message here, which was wrong -- that's not the code path this input
    // actually takes.)
    const result = await readRepoFile(repoRoot, "/etc/passwd");
    expect(result.error).toBe("File not found in this repo.");
  });

  it("rejects traversal disguised inside a subdirectory-looking path", async () => {
    const result = await readRepoFile(repoRoot, "src/../../codebase-agent-test-secret.txt");
    expect(result.error).toBe("Path escapes the repository root.");
  });

  it("allows a path that resolves to exactly the repo root", async () => {
    // Edge case in the boundary check itself: resolved === root should be
    // allowed (though readRepoFile will then correctly reject it for a
    // different reason -- it's a directory, not a file).
    const result = await readRepoFile(repoRoot, ".");
    expect(result.error).toBe("Not a file (directory or special file).");
  });

  it("rejects a blocklisted binary extension", async () => {
    await fs.writeFile(path.join(repoRoot, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await readRepoFile(repoRoot, "image.png");
    expect(result.error).toBe("Binary file type, not readable as text.");
  });

  it("returns an error for a nonexistent file rather than throwing", async () => {
    const result = await readRepoFile(repoRoot, "does-not-exist.txt");
    expect(result.error).toBe("File not found in this repo.");
  });

  it("returns an error for a directory path", async () => {
    const result = await readRepoFile(repoRoot, "src");
    expect(result.error).toBe("Not a file (directory or special file).");
  });

  it("returns an error for an empty path", async () => {
    const result = await readRepoFile(repoRoot, "");
    expect(result.error).toBe("path is required.");
  });

  it("slices to a line range with padding when startLine is given", async () => {
    const result = await readRepoFile(repoRoot, "src/main.go", 10);
    expect(result.error).toBeUndefined();
    expect(result.linesShown).toBe("7-13"); // 10 -/+ 3 padding, clamped to file bounds
    expect(result.content).toContain("line 10");
    expect(result.content).not.toContain("line 1\n"); // line 1 shouldn't be in this window
  });

  it("clamps the line-range padding to the file's actual bounds", async () => {
    const result = await readRepoFile(repoRoot, "src/main.go", 1);
    expect(result.error).toBeUndefined();
    expect(result.linesShown).toBe("1-4"); // can't pad below line 1
  });

  it("respects an explicit startLine/endLine range", async () => {
    const result = await readRepoFile(repoRoot, "src/main.go", 5, 8);
    expect(result.linesShown).toBe("2-11"); // 5-3 .. 8+3
    expect(result.content).toContain("line 5");
    expect(result.content).toContain("line 8");
  });

  it("truncates content larger than the read cap", async () => {
    const bigContent = "x".repeat(20_000);
    await fs.writeFile(path.join(repoRoot, "big.txt"), bigContent);
    const result = await readRepoFile(repoRoot, "big.txt");
    expect(result.truncated).toBe(true);
    expect(result.content?.length).toBeLessThan(bigContent.length);
  });
});