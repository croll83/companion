import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The effort of agent runs, for both backends. Validates: Claude levels come
 * from the static table and default to Companion's "high"; Codex levels and
 * default come from its catalogue (mocked here: the real one lives under the
 * user's home and changes with every Codex release), an empty Codex model
 * being the catalogue's first model; save-time errors say what the model
 * takes; and a run always gets an explicit level when the model has one.
 */

const h = vi.hoisted(() => ({
  catalogue: [] as { slug: string; levels: string[]; def: string | null }[],
}));
vi.mock("./codex-models.js", () => ({
  defaultCodexModel: () => h.catalogue[0]?.slug,
  getCodexEffortLevels: (model: string | undefined) => h.catalogue.find((m) => m.slug === model)?.levels ?? [],
  getCodexDefaultEffort: (model: string | undefined) => h.catalogue.find((m) => m.slug === model)?.def ?? null,
}));

import { agentEffortError, defaultEffortFor, effortLevelsFor, resolveRunEffort } from "./agent-effort.js";

beforeEach(() => {
  h.catalogue = [
    { slug: "gpt-6.1-sol", levels: ["low", "medium", "high", "xhigh", "max", "ultra"], def: "low" },
    { slug: "gpt-6-luna", levels: ["low", "medium", "high", "xhigh", "max"], def: "medium" },
  ];
});

describe("effortLevelsFor / defaultEffortFor", () => {
  it("reads Claude's static table, with Companion's default", () => {
    expect(effortLevelsFor("claude", "claude-opus-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(defaultEffortFor("claude", "claude-opus-5-5")).toBe("high");
    // No model: the CLI's own default model, whose levels Companion does not know.
    expect(effortLevelsFor("claude", "")).toEqual([]);
    expect(defaultEffortFor("claude", undefined)).toBeNull();
  });

  it("reads Codex's catalogue; an empty model is its first one", () => {
    expect(effortLevelsFor("codex", "gpt-6-luna")).not.toContain("ultra");
    expect(defaultEffortFor("codex", "gpt-6-luna")).toBe("medium");
    // Sol defaults to low: the level the consolidation runs ended up at.
    expect(defaultEffortFor("codex", "")).toBe("low");
    expect(effortLevelsFor("codex", "")).toContain("ultra");
  });
});

describe("agentEffortError", () => {
  it("accepts an absent effort, whatever the model", () => {
    for (const effort of [undefined, null, ""]) {
      expect(agentEffortError("claude", "claude-sonnet-4-6", effort)).toBeNull();
      expect(agentEffortError("codex", "unknown-model", effort)).toBeNull();
    }
  });

  it("accepts a level the model takes", () => {
    expect(agentEffortError("claude", "claude-opus-5-5", "max")).toBeNull();
    expect(agentEffortError("codex", "gpt-6.1-sol", "ultra")).toBeNull();
  });

  it("rejects an unknown level or a non-string", () => {
    expect(agentEffortError("claude", "claude-opus-5-5", "turbo")).toMatch(/effort must be one of low, medium, high, xhigh, max, ultra/);
    expect(agentEffortError("claude", "claude-opus-5-5", 3)).toMatch(/effort must be one of/);
  });

  it("names the levels the model supports when it lacks the one asked", () => {
    expect(agentEffortError("claude", "claude-opus-4-6", "xhigh")).toBe(
      'claude-opus-4-6 does not support effort "xhigh" (it supports low, medium, high, max)',
    );
    expect(agentEffortError("codex", "gpt-6-luna", "ultra")).toMatch(/gpt-6-luna does not support effort "ultra"/);
  });

  it("says when the model has no effort at all, per backend", () => {
    expect(agentEffortError("claude", "claude-sonnet-4-6", "high")).toMatch(/claude-sonnet-4-6 has no reasoning-effort setting/);
    expect(agentEffortError("claude", "", "high")).toMatch(/the CLI's default model has no reasoning-effort setting/);
    // Codex without a catalogue (never ran here): levels unknown, so refused.
    h.catalogue = [];
    expect(agentEffortError("codex", "gpt-6.1-sol", "high")).toMatch(/Codex reports no reasoning-effort levels for gpt-6.1-sol/);
  });
});

describe("resolveRunEffort", () => {
  it("passes the chosen level, or the model's default when none was chosen", () => {
    expect(resolveRunEffort("claude", "claude-opus-5-5", "max")).toEqual({ effort: "max", fallback: false });
    expect(resolveRunEffort("claude", "claude-opus-5-5", undefined)).toEqual({ effort: "high", fallback: false });
    expect(resolveRunEffort("codex", "gpt-6.1-sol", undefined)).toEqual({ effort: "low", fallback: false });
  });

  it("falls back to the default for a stored level the model no longer takes", () => {
    expect(resolveRunEffort("codex", "gpt-6-luna", "ultra")).toEqual({ effort: "medium", fallback: true });
  });

  it("passes nothing for a model without effort control", () => {
    expect(resolveRunEffort("claude", "claude-sonnet-4-6", undefined)).toEqual({ fallback: false });
  });
});
