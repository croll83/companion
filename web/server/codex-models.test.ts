import { describe, it, expect } from "vitest";
import { codexEffortLevelsFrom, codexDefaultEffortFrom, EFFORT_LEVELS } from "./effort.js";

// Shape mirrors real entries from ~/.codex/models_cache.json (2026-09, cli 0.153.4).
const MODELS = [
  {
    slug: "gpt-6-astra",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" }, { effort: "medium" }, { effort: "high" },
      { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" },
    ],
  },
  {
    slug: "gpt-5.5",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
    ],
  },
  { slug: "gpt-5.6-sol", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
];

describe("codexEffortLevelsFrom", () => {
  it("returns each model's own levels, in Codex's order", () => {
    expect(codexEffortLevelsFrom(MODELS, "gpt-6-astra"))
      .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    // Levels genuinely differ per model — this is why Codex can't use a static table.
    expect(codexEffortLevelsFrom(MODELS, "gpt-5.5"))
      .toEqual(["low", "medium", "high", "xhigh"]);
  });
  it("returns [] for an unknown model or missing input", () => {
    expect(codexEffortLevelsFrom(MODELS, "nope")).toEqual([]);
    expect(codexEffortLevelsFrom(MODELS, null)).toEqual([]);
    expect(codexEffortLevelsFrom(null, "gpt-6-astra")).toEqual([]);
  });
  it("drops levels we don't model, so the UI never offers an unusable one", () => {
    const weird = [{ slug: "x", supported_reasoning_levels: [{ effort: "low" }, { effort: "warp9" }] }];
    expect(codexEffortLevelsFrom(weird, "x")).toEqual(["low"]);
  });
  it("keeps `ultra` — a level Codex has and Claude does not", () => {
    expect(EFFORT_LEVELS).toContain("ultra");
  });
});

describe("codexDefaultEffortFrom", () => {
  it("returns the model's own default (which differs per model)", () => {
    expect(codexDefaultEffortFrom(MODELS, "gpt-6-astra")).toBe("medium");
    expect(codexDefaultEffortFrom(MODELS, "gpt-5.6-sol")).toBe("low");
  });
  it("returns null when unknown or unrecognised", () => {
    expect(codexDefaultEffortFrom(MODELS, "nope")).toBeNull();
    expect(codexDefaultEffortFrom([{ slug: "y", default_reasoning_level: "warp9" }], "y")).toBeNull();
  });
});
