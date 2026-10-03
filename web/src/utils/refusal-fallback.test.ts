import { describe, it, expect } from "vitest";
import { nextRefusalFallback, normalizeModelId, REFUSAL_CHAIN } from "./refusal-fallback.js";

describe("refusal fallback chain", () => {
  it("walks Fable 5.1 → Opus 5.5 → Opus 5 → Opus 4.8, one step per refusal", () => {
    expect(nextRefusalFallback("claude-fable-5-1")).toBe("claude-opus-5-5");
    expect(nextRefusalFallback("claude-opus-5-5")).toBe("claude-opus-5");
    expect(nextRefusalFallback("claude-opus-5")).toBe("claude-opus-4-8");
  });

  it("stops when the last resort itself refuses", () => {
    expect(nextRefusalFallback("claude-opus-4-8")).toBeNull();
  });

  it("treats an older Fable like the current one", () => {
    expect(nextRefusalFallback("claude-fable-5")).toBe("claude-opus-5-5");
  });

  it("sends a model outside the chain to the last resort, as before", () => {
    expect(nextRefusalFallback("claude-sonnet-5")).toBe("claude-opus-4-8");
    expect(nextRefusalFallback("claude-opus-4-6")).toBe("claude-opus-4-8");
    expect(nextRefusalFallback(undefined)).toBe("claude-opus-4-8");
  });

  it("never offers the model that just refused", () => {
    for (const model of REFUSAL_CHAIN) {
      expect(nextRefusalFallback(model)).not.toBe(model);
    }
  });

  it("reads ids as responses report them, not as the picker writes them", () => {
    expect(nextRefusalFallback("claude-opus-5-5[1m]")).toBe("claude-opus-5");
    expect(nextRefusalFallback("claude-opus-5-20260401")).toBe("claude-opus-4-8");
  });

  it("does not confuse Opus 5 with Opus 5.5", () => {
    // Prefix matching would read a 5.5 refusal as a 5 refusal and skip a step.
    expect(normalizeModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(nextRefusalFallback("claude-opus-5-5")).toBe("claude-opus-5");
  });
});
