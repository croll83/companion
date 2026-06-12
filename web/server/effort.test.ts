import { describe, it, expect } from "vitest";
import {
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  getEffortLevels,
  modelSupportsEffort,
  isValidEffort,
} from "./effort.js";

// The effort matrix mirrors the Claude Code CLI's per-model gating. These tests
// lock in the exact level sets so a wrong entry can't silently pass an invalid
// `--effort` to a model (which the API rejects).
describe("effort capability matrix", () => {
  it("exposes the 5 canonical levels with high as default", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(DEFAULT_EFFORT).toBe("high");
  });

  it("gives fable-5 and Opus 4.8/4.7 all five levels", () => {
    for (const m of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(getEffortLevels(m)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("gives Opus 4.6 max but NOT xhigh (matches CLI gating)", () => {
    expect(getEffortLevels("claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
  });

  it("reports no effort for non-supporting models", () => {
    for (const m of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "gpt-5.3-codex"]) {
      expect(getEffortLevels(m)).toEqual([]);
      expect(modelSupportsEffort(m)).toBe(false);
    }
  });

  it("treats undefined/null/empty model as effort-incapable", () => {
    expect(modelSupportsEffort(undefined)).toBe(false);
    expect(modelSupportsEffort(null)).toBe(false);
    expect(modelSupportsEffort("")).toBe(false);
  });

  it("validates effort against the model's actual level set", () => {
    expect(isValidEffort("claude-fable-5", "max")).toBe(true);
    expect(isValidEffort("claude-fable-5", "xhigh")).toBe(true);
    // Opus 4.6 rejects xhigh — the key guard against a 400 from the API.
    expect(isValidEffort("claude-opus-4-6", "xhigh")).toBe(false);
    expect(isValidEffort("claude-opus-4-6", "max")).toBe(true);
    // Non-supporting model rejects everything.
    expect(isValidEffort("claude-sonnet-4-6", "high")).toBe(false);
    // Garbage / empty values are rejected.
    expect(isValidEffort("claude-fable-5", "ultra")).toBe(false);
    expect(isValidEffort("claude-fable-5", "")).toBe(false);
    expect(isValidEffort("claude-fable-5", undefined)).toBe(false);
  });
});
