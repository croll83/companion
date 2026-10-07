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
  it("exposes every level either backend can use, with high as default", () => {
    // `ultra` exists only on Codex models (astra/sol/terra); no Claude model
    // lists it, so widening the union must not widen any Claude level set.
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(DEFAULT_EFFORT).toBe("high");
  });

  it("never offers `ultra` to a Claude model", () => {
    for (const m of ["claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
      expect(getEffortLevels(m)).not.toContain("ultra");
    }
  });

  it("gives fable-5 and Opus 4.8/4.7 all five levels", () => {
    for (const m of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(getEffortLevels(m)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
  });

  it("gives Haiku 5.5 all five levels, unlike Haiku 4.5", () => {
    // Haiku 5.5 is the first Haiku that accepts --effort (low..max; verified
    // against CLI 2.1.293). Haiku 4.5 must keep receiving no flag at all.
    expect(getEffortLevels("claude-haiku-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getEffortLevels("claude-haiku-5-5")).not.toContain("ultra");
  });

  it("keeps effort for retired picker models so running sessions keep their flag", () => {
    // Opus 5 left the picker, but sessions already on it still need --effort.
    expect(getEffortLevels("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
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
