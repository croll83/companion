// @vitest-environment node
/**
 * defaultCodexModel: the model a Codex session gets when none was chosen
 * (an agent saved with the default). It must be the picker's first model, so
 * a run starts on what the UI would preselect, and undefined while Codex has
 * written no catalogue yet (Codex then picks its own).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const h = vi.hoisted(() => ({ legacy: "", companion: "" }));
vi.mock("./codex-home.js", () => ({
  getLegacyCodexHome: () => h.legacy,
  resolveCompanionCodexHome: () => h.companion,
}));
// No codex binary: the cache is read without a version check.
vi.mock("./path-resolver.js", () => ({ resolveBinary: () => null, getEnrichedPath: () => "" }));

import { defaultCodexModel, resetCodexModelsCache } from "./codex-models.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-default-"));
  h.legacy = join(root, "legacy");
  h.companion = join(root, "homes");
  mkdirSync(h.legacy, { recursive: true });
  mkdirSync(h.companion, { recursive: true });
  resetCodexModelsCache();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("defaultCodexModel", () => {
  it("is undefined while Codex has no model catalogue", () => {
    expect(defaultCodexModel()).toBeUndefined();
  });

  it("is the picker's first model: newest of each family, by priority, hidden ones skipped", () => {
    writeFileSync(join(h.legacy, "models_cache.json"), JSON.stringify({
      fetched_at: "2026-10-14T00:00:00Z",
      models: [
        { slug: "gpt-reserve", visibility: "hide", priority: 0 },
        { slug: "gpt-5.6-sol", visibility: "list", priority: 1 },
        { slug: "gpt-6.1-sol", visibility: "list", priority: 2 },
        { slug: "gpt-6-luna", visibility: "list", priority: 3 },
      ],
    }));
    expect(defaultCodexModel()).toBe("gpt-6.1-sol");
  });
});
