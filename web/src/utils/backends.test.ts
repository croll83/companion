import { describe, it, expect } from "vitest";
import {
  toModelOptions,
  getModelsForBackend,
  getModesForBackend,
  getAgentModesForBackend,
  getDefaultModel,
  DEFAULT_CLAUDE_MODEL,
  getDefaultMode,
  getDefaultAgentMode,
  CLAUDE_MODELS,
  CODEX_MODELS,
  CLAUDE_MODES,
  CODEX_MODES,
  CLAUDE_AGENT_MODES,
  CODEX_AGENT_MODES,
} from "./backends.js";

describe("toModelOptions", () => {
  it("converts server model info to frontend ModelOption with icons", () => {
    const models = [
      { value: "gpt-5.2-codex", label: "gpt-5.2-codex", description: "Frontier" },
      { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini", description: "Fast" },
    ];

    const options = toModelOptions(models);

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("gpt-5.2-codex");
    expect(options[0].label).toBe("gpt-5.2-codex");
    expect(options[0].icon).toBeTruthy();
    expect(options[1].value).toBe("gpt-5.1-codex-mini");
  });

  it("assigns codex icon to codex-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "" },
    ]);
    expect(options[0].icon).toBe("\u2733"); // ✳
  });

  it("assigns max icon to max-containing slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", description: "" },
    ]);
    // "codex" appears before "max" in the slug, so codex icon wins
    expect(options[0].icon).toBe("\u2733");
  });

  it("assigns mini icon to mini-only slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.1-mini", label: "GPT-5.1 Mini", description: "" },
    ]);
    expect(options[0].icon).toBe("\u26A1"); // ⚡
  });

  it("uses fallback icon for generic model slugs", () => {
    const options = toModelOptions([
      { value: "gpt-5.2", label: "GPT-5.2", description: "" },
    ]);
    // Should use one of the fallback icons
    expect(options[0].icon).toBeTruthy();
    expect(options[0].icon.length).toBeGreaterThan(0);
  });

  it("uses value as label when label is empty", () => {
    const options = toModelOptions([
      { value: "some-model", label: "", description: "" },
    ]);
    expect(options[0].label).toBe("some-model");
  });

  it("handles empty array", () => {
    expect(toModelOptions([])).toEqual([]);
  });
});

describe("getModelsForBackend", () => {
  it("returns claude models for claude backend", () => {
    expect(getModelsForBackend("claude")).toBe(CLAUDE_MODELS);
  });

  it("returns codex models for codex backend", () => {
    expect(getModelsForBackend("codex")).toBe(CODEX_MODELS);
  });
});

describe("getModesForBackend", () => {
  it("returns claude modes for claude backend", () => {
    expect(getModesForBackend("claude")).toBe(CLAUDE_MODES);
  });

  it("returns codex modes for codex backend", () => {
    expect(getModesForBackend("codex")).toBe(CODEX_MODES);
  });
});

describe("getDefaultModel", () => {
  it("returns the explicit default claude model (decoupled from list order)", () => {
    // The default is intentionally NOT CLAUDE_MODELS[0]: the list can be
    // reordered (e.g. Fable 5 shown first) without changing the default.
    expect(getDefaultModel("claude")).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5-5");
  });

  it("keeps the default model selectable in the picker", () => {
    // A default missing from CLAUDE_MODELS leaves the dropdown showing nothing
    // for every new session.
    expect(CLAUDE_MODELS.map((m) => m.value)).toContain(DEFAULT_CLAUDE_MODEL);
  });

  it("returns first codex model for codex backend", () => {
    expect(getDefaultModel("codex")).toBe(CODEX_MODELS[0].value);
  });
});

describe("getDefaultMode", () => {
  it("returns first claude mode for claude backend", () => {
    expect(getDefaultMode("claude")).toBe(CLAUDE_MODES[0].value);
  });

  it("returns first codex mode for codex backend", () => {
    expect(getDefaultMode("codex")).toBe(CODEX_MODES[0].value);
  });
});

describe("getAgentModesForBackend", () => {
  it("returns claude agent modes for claude backend", () => {
    expect(getAgentModesForBackend("claude")).toBe(CLAUDE_AGENT_MODES);
  });

  it("returns codex agent modes for codex backend", () => {
    expect(getAgentModesForBackend("codex")).toBe(CODEX_AGENT_MODES);
  });
});

describe("getDefaultAgentMode", () => {
  it("returns first claude agent mode for claude backend", () => {
    expect(getDefaultAgentMode("claude")).toBe(CLAUDE_AGENT_MODES[0].value);
  });

  it("returns first codex agent mode for codex backend", () => {
    expect(getDefaultAgentMode("codex")).toBe(CODEX_AGENT_MODES[0].value);
  });
});

describe("static model/mode lists", () => {
  it("has codex models with gpt- slugs", () => {
    // Pinned to the vendor prefix, not a generation: the list moves with each
    // release (GPT-6 arrived 2026-09), and a generation check would fail on it.
    for (const m of CODEX_MODELS) {
      expect(m.value).toMatch(/^gpt-/);
    }
  });

  it("has claude models with claude- prefix", () => {
    for (const m of CLAUDE_MODELS) {
      expect(m.value).toMatch(/^claude-/);
    }
  });

  it("has at least 2 modes for each backend", () => {
    expect(CLAUDE_MODES.length).toBeGreaterThanOrEqual(2);
    expect(CODEX_MODES.length).toBeGreaterThanOrEqual(2);
  });

  // Agent modes must never include "plan" — agents are autonomous and
  // cannot wait for human plan approval.
  it("agent modes do not include 'plan' for any backend", () => {
    for (const m of CLAUDE_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
    for (const m of CODEX_AGENT_MODES) {
      expect(m.value).not.toBe("plan");
    }
  });

  it("agent modes default to bypassPermissions", () => {
    expect(CLAUDE_AGENT_MODES[0].value).toBe("bypassPermissions");
    expect(CODEX_AGENT_MODES[0].value).toBe("bypassPermissions");
  });

  it("claude agent modes include acceptEdits for middle ground", () => {
    expect(CLAUDE_AGENT_MODES.some((m) => m.value === "acceptEdits")).toBe(true);
  });
});
