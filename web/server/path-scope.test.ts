import { describe, it, expect } from "vitest";
import { dedupeFolders, isPathWithin, normalizeFolderPath } from "./path-scope.js";

/** Folder scoping shared by saved prompts and env profiles. */
describe("path-scope", () => {
  it("normalizes trailing separators but keeps the root", () => {
    expect(normalizeFolderPath("/repo/")).toBe("/repo");
    expect(normalizeFolderPath("/repo//")).toBe("/repo");
    expect(normalizeFolderPath("/")).toBe("/");
    expect(normalizeFolderPath("/a/../b")).toBe("/b");
  });

  // Matching is by path segment so /repo never captures /repository.
  it("matches a folder and its descendants only", () => {
    expect(isPathWithin("/repo", "/repo")).toBe(true);
    expect(isPathWithin("/repo/src/x", "/repo/")).toBe(true);
    expect(isPathWithin("/repository", "/repo")).toBe(false);
    expect(isPathWithin("/re", "/repo")).toBe(false);
    expect(isPathWithin("/anything", "/")).toBe(true);
  });

  it("dedupes after normalization and drops blank entries", () => {
    expect(dedupeFolders(["/a/", " /a ", "", "  ", "/b"])).toEqual(["/a", "/b"]);
  });
});
