// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidateCachePaths, readFreshestCache, pickerModels, parseFamily } from "./codex-models.js";

const model = (slug: string, priority: number, visibility = "list") =>
  ({ slug, display_name: slug.toUpperCase(), visibility, priority });

describe("codex picker models", () => {
  it("shows each family only at its newest version", () => {
    const out = pickerModels({
      models: [
        model("gpt-6-astra", 1),
        model("gpt-6-sol", 2),
        model("gpt-6-luna", 3),
        model("gpt-5.6-sol", 4),
        model("gpt-5.6-terra", 7),
        model("gpt-5.6-luna", 8),
        model("gpt-5.5", 12),
      ],
    }).map((m) => m.value);

    // GPT-6 Sol/Luna supersede their 5.6 versions...
    expect(out).toContain("gpt-6-sol");
    expect(out).toContain("gpt-6-luna");
    expect(out).not.toContain("gpt-5.6-sol");
    expect(out).not.toContain("gpt-5.6-luna");
    // ...while a family with no newer generation stays, as does a familyless slug.
    expect(out).toContain("gpt-5.6-terra");
    expect(out).toContain("gpt-5.5");
  });

  it("keeps priority order and drops hidden models", () => {
    const out = pickerModels({
      models: [model("gpt-6-luna", 3), model("gpt-reserve", 1, "hide"), model("gpt-6-astra", 1)],
    }).map((m) => m.value);
    expect(out).toEqual(["gpt-6-astra", "gpt-6-luna"]);
  });

  it("parses families from real slugs", () => {
    expect(parseFamily("gpt-6-sol")).toEqual({ family: "sol", version: 6 });
    expect(parseFamily("gpt-5.6-terra")).toEqual({ family: "terra", version: 5.6 });
    expect(parseFamily("gpt-5.5")).toBeNull();
    expect(parseFamily("codex-auto-review")).toBeNull();
  });

  describe("choosing the cache", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "codex-models-")); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const write = (dir: string, fetchedAt: string, slugs: string[]) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "models_cache.json"), JSON.stringify({
        fetched_at: fetchedAt,
        models: slugs.map((s, i) => model(s, i + 1)),
      }));
    };

    it("prefers the most recently fetched cache, wherever it lives", () => {
      // The regression: Codex refreshed inside a session's CODEX_HOME, the
      // picker kept reading the stale host copy.
      const legacy = join(root, "legacy");
      const sessions = join(root, "sessions");
      write(legacy, "2026-09-22T10:46:00Z", ["gpt-6-astra"]);
      write(join(sessions, "s1"), "2026-09-22T23:36:00Z", ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
      write(join(sessions, "s2"), "2026-09-08T18:05:00Z", ["gpt-5.5"]);

      const cache = readFreshestCache(candidateCachePaths(legacy, sessions));
      expect(cache?.models.map((m) => m.slug)).toContain("gpt-6-sol");
    });

    it("ignores an unreadable cache instead of failing the whole menu", () => {
      const legacy = join(root, "legacy");
      write(legacy, "2026-09-22T10:46:00Z", ["gpt-6-astra"]);
      mkdirSync(join(root, "sessions", "broken"), { recursive: true });
      writeFileSync(join(root, "sessions", "broken", "models_cache.json"), "{not json");

      const cache = readFreshestCache(candidateCachePaths(legacy, join(root, "sessions")));
      expect(cache?.models.map((m) => m.slug)).toEqual(["gpt-6-astra"]);
    });
  });
});
