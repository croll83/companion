// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidateCachePaths, readFreshestCache, pickerModels, parseFamily, compareVersions } from "./codex-models.js";

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

    const writeV = (dir: string, fetchedAt: string, version: string, slugs: string[]) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "models_cache.json"), JSON.stringify({
        fetched_at: fetchedAt, client_version: version,
        models: slugs.map((s, i) => model(s, i + 1)),
      }));
    };

    // 2026-10-03: OpenAI tailors the catalogue per client. Codex 0.160 listed
    // GPT-6.1-Sol, 0.157 did not, and a 0.157 refresh landing 70s later made the
    // picker drop it again — or offer it to a client that was never given it.
    it("trusts the catalogue of the Codex version Companion runs, not the latest fetch", () => {
      const legacy = join(root, "legacy");
      const sessions = join(root, "sessions");
      writeV(legacy, "2026-10-03T11:35:54Z", "0.160.0", ["gpt-6.1-sol", "gpt-6-astra"]);
      writeV(join(sessions, "old"), "2026-10-03T11:37:04Z", "0.157.0", ["gpt-6-sol", "gpt-6-astra"]);

      const on160 = readFreshestCache(candidateCachePaths(legacy, sessions), "0.160.0");
      expect(on160?.models.map((m) => m.slug)).toContain("gpt-6.1-sol");

      const on157 = readFreshestCache(candidateCachePaths(legacy, sessions), "0.157.0");
      expect(on157?.models.map((m) => m.slug)).not.toContain("gpt-6.1-sol");
    });

    it("falls back to the newest catalogue not above the running version", () => {
      const legacy = join(root, "legacy");
      const sessions = join(root, "sessions");
      writeV(legacy, "2026-10-01T00:00:00Z", "0.158.0", ["from-158"]);
      writeV(join(sessions, "a"), "2026-10-03T00:00:00Z", "0.161.0", ["from-161"]);
      writeV(join(sessions, "b"), "2026-09-01T00:00:00Z", "0.150.0", ["from-150"]);

      const cache = readFreshestCache(candidateCachePaths(legacy, sessions), "0.160.0");
      expect(cache?.models.map((m) => m.slug)).toEqual(["from-158"]);
    });

    it("compares versions numerically, not as text", () => {
      expect(compareVersions("0.160.0", "0.157.0")).toBeGreaterThan(0);
      expect(compareVersions("0.2.0", "0.103.0")).toBeLessThan(0);
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
