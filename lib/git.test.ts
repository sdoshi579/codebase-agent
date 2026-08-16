import { describe, it, expect } from "vitest";
import { parseGithubUrl, RepoError } from "./git";

describe("parseGithubUrl", () => {
  it("parses a plain owner/repo URL", () => {
    expect(parseGithubUrl("https://github.com/facebook/react")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("strips a trailing .git suffix", () => {
    expect(parseGithubUrl("https://github.com/facebook/react.git")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("strips a trailing slash", () => {
    expect(parseGithubUrl("https://github.com/facebook/react/")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseGithubUrl("  https://github.com/facebook/react  ")).toEqual({
      owner: "facebook",
      repo: "react",
    });
  });

  it("handles owner/repo names with dots, dashes, and underscores", () => {
    expect(parseGithubUrl("https://github.com/my-org/my_repo.js")).toEqual({
      owner: "my-org",
      repo: "my_repo.js",
    });
  });

  it("rejects a URL with extra path segments (not just owner/repo)", () => {
    // e.g. a link to a specific file or branch, not the repo root -- this
    // app only supports cloning the repo itself.
    expect(() => parseGithubUrl("https://github.com/facebook/react/tree/main")).toThrow(RepoError);
  });

  it("rejects plain http:// (not https)", () => {
    expect(() => parseGithubUrl("http://github.com/facebook/react")).toThrow(RepoError);
  });

  it("rejects a non-GitHub URL", () => {
    expect(() => parseGithubUrl("https://gitlab.com/facebook/react")).toThrow(RepoError);
  });

  it("rejects a URL missing the repo segment", () => {
    expect(() => parseGithubUrl("https://github.com/facebook")).toThrow(RepoError);
  });

  it("rejects garbage input entirely", () => {
    expect(() => parseGithubUrl("not a url at all")).toThrow(RepoError);
  });

  it("throws a RepoError with code INVALID_URL specifically", () => {
    try {
      parseGithubUrl("not a url");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RepoError);
      expect((err as RepoError).code).toBe("INVALID_URL");
    }
  });
});