import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS, latestSonnet } from "./claude-models.js";

/**
 * The Claude catalog shared by the pickers and the server. latestSonnet is
 * the default model of brain consolidation (decision D5: "always the latest
 * Sonnet", resolved at every run): it must pick the highest Sonnet version
 * whatever the list order, and ignore other families.
 */
describe("latestSonnet", () => {
  it("picks a Sonnet of the real catalog", () => {
    const id = latestSonnet();
    expect(id).toMatch(/^claude-sonnet-/);
    expect(CLAUDE_MODELS.map((m) => m.value)).toContain(id);
  });

  it("compares versions numerically, not by list order or as text", () => {
    const models = [{ value: "claude-sonnet-4-6" }, { value: "claude-opus-9-9" }, { value: "claude-sonnet-10-1" }, { value: "claude-sonnet-5-5" }];
    expect(latestSonnet(models)).toBe("claude-sonnet-10-1");
    expect(latestSonnet([{ value: "claude-sonnet-5" }, { value: "claude-sonnet-5-1" }])).toBe("claude-sonnet-5-1");
    expect(latestSonnet([{ value: "claude-sonnet-4-5-20250929" }, { value: "claude-sonnet-4" }])).toBe("claude-sonnet-4-5-20250929");
  });

  it("returns undefined without a Sonnet", () => {
    expect(latestSonnet([{ value: "claude-opus-5-5" }, { value: "gpt-5.5" }])).toBeUndefined();
    expect(latestSonnet([])).toBeUndefined();
  });
});
