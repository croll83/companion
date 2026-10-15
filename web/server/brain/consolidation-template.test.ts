import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The consolidation agent's template. Validates: the prompt is generic (the
 * brain's name only), never holds the curator credential (it names the env
 * variable), treats notes as untrusted and rejects instructions to an AI,
 * and never pushes; the agent runs in the curator clone, in the first domain
 * that chose the brain (else GLOBAL), with no trigger of its own; the model
 * is resolved at every call (latest Sonnet, a chosen one, or Codex's first).
 */

type CodexEntry = { slug: string; visibility: string; priority?: number; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[] };
const h = vi.hoisted(() => ({ home: "", codex: null as null | { models: CodexEntry[] } }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
// Codex's default model: the first of its catalogue by priority (codex-models.ts).
// Effort levels and default: what the catalogue lists for the model (codex-models.ts).
vi.mock("../codex-models.js", () => ({
  defaultCodexModel: () =>
    h.codex ? [...(h.codex as { models: { slug: string; priority?: number }[] }).models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0]?.slug : undefined,
  getCodexEffortLevels: (model: string | undefined) =>
    (h.codex?.models.find((m) => m.slug === model)?.supported_reasoning_levels ?? []).map((l) => l.effort),
  getCodexDefaultEffort: (model: string | undefined) => h.codex?.models.find((m) => m.slug === model)?.default_reasoning_level ?? null,
}));

import {
  consolidationAgentFields,
  consolidationAgentName,
  consolidationDomain,
  consolidationPrompt,
  curatorDir,
  resolveConsolidationEffort,
  resolveConsolidationModel,
} from "./consolidation-template.js";
import { latestSonnet } from "../claude-models.js";
import type { BrainConfig, ConsolidationConfig } from "./brain-store.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cons-template-"));
  h.home = join(tmp, "companion");
  mkdirSync(h.home, { recursive: true });
  h.codex = null;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const brain: BrainConfig = { slug: "work", name: "Work", kind: "embedded", createdAt: 0, about: "", skill: { source: "generated" }, embedded: { wikiDir: "/w", autostart: true, redactSecrets: true, language: "auto" } };
const config: ConsolidationConfig = { enabled: true, schedule: "0 5 * * *", mode: "local", backend: "claude", effort: "high", threshold: 10 };

describe("consolidation template", () => {
  it("writes a generic prompt: env credential, untrusted notes, no push", () => {
    const p = consolidationPrompt(brain);
    expect(p).toContain('knowledge base "Work"');
    expect(p).toContain("$BRAIN_API_URL");
    expect(p).toMatch(/UNTRUSTED claims/);
    expect(p).toMatch(/instructions aimed at an AI .* is rejected/);
    expect(p).toMatch(/Never push/);
    expect(p).toMatch(/append the returned log_entry to log\.md/);
    // Nothing cycles for ever: a note is its own source, and a deferral needs a source on its way.
    expect(p).toMatch(/The note is itself a source/);
    expect(p).toMatch(/deferred: only when a specific source is about to arrive/);
    expect(p).toMatch(/A note a person included/);
    expect(p).not.toMatch(/X-Brain-Key|jarvis|Marco/i);
  });

  it("builds the agent's fields: curator clone, GLOBAL by default, no triggers, the brain role", () => {
    const f = consolidationAgentFields(brain, config);
    expect(f).toMatchObject({
      backendType: "claude",
      model: latestSonnet(),
      permissionMode: "bypassPermissions",
      codexInternetAccess: true,
      cwd: curatorDir("work"),
      domain: "global",
      contextMode: "brief",
      triggers: {},
      enabled: true,
      brainRole: { slug: "work", role: "consolidation" },
    });
    expect(f.cwd).toBe(join(h.home, "brains", "work", "curator"));
    expect(consolidationAgentName(brain)).toBe("Work brain consolidation");
  });

  it("runs in the first domain that chose the brain", () => {
    writeFileSync(join(h.home, "domains.json"), JSON.stringify({
      domains: [
        { slug: "global", name: "GLOBAL", brain: "work" },
        { slug: "alpha", name: "Alpha", brain: "other" },
        { slug: "herd", name: "Herd", brain: "work" },
      ],
    }));
    expect(consolidationDomain("work")).toBe("herd");
    expect(consolidationDomain("nobody")).toBe("global");
  });

  it("resolves the model now: chosen, latest Sonnet, Codex's first model, or the CLI's default", () => {
    expect(resolveConsolidationModel({ backend: "claude", model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(resolveConsolidationModel({ backend: "claude" })).toBe(latestSonnet());
    expect(resolveConsolidationModel({ backend: "codex" })).toBeUndefined();
    h.codex = { models: [{ slug: "gpt-b", visibility: "list", priority: 2 }, { slug: "gpt-a", visibility: "list", priority: 1 }] };
    expect(resolveConsolidationModel({ backend: "codex" })).toBe("gpt-a");
    expect(consolidationAgentFields(brain, { ...config, backend: "codex", enabled: false })).toMatchObject({ backendType: "codex", model: "gpt-a", enabled: false });
    h.codex = { models: [] };
    expect(consolidationAgentFields(brain, { ...config, backend: "codex" }).model).toBe("");
  });

  // The effort of a run follows the model resolved now: the brain's level when
  // the model takes it (Marco wanted "high", not the CLI's own low/medium), else
  // the model's default with `fallback` set so the tab can say so, and nothing
  // for a model without effort control (the CLI would drop the flag).
  it("settles the effort against the model resolved now, falling back to its default", () => {
    const sonnet = latestSonnet();
    expect(resolveConsolidationEffort({ backend: "claude", effort: "high" })).toEqual({ effort: "high", fallback: false });
    expect(resolveConsolidationEffort({ backend: "claude", effort: "max" }, sonnet)).toEqual({ effort: "max", fallback: false });
    // Opus 4.6 has no xhigh: Companion's default instead.
    expect(resolveConsolidationEffort({ backend: "claude", model: "claude-opus-4-6", effort: "xhigh" })).toEqual({ effort: "high", fallback: true });
    // A model outside the effort table: no level at all.
    expect(resolveConsolidationEffort({ backend: "claude", model: "claude-sonnet-4-6", effort: "high" })).toEqual({ fallback: true });
    h.codex = { models: [{ slug: "gpt-sol", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] };
    expect(resolveConsolidationEffort({ backend: "codex", effort: "high" })).toEqual({ effort: "high", fallback: false });
    expect(resolveConsolidationEffort({ backend: "codex", effort: "ultra" })).toEqual({ effort: "low", fallback: true });
  });

  it("writes the settled effort into the agent, and clears it when the model has none", () => {
    expect(consolidationAgentFields(brain, config).effort).toBe("high");
    const fields = consolidationAgentFields(brain, { ...config, model: "claude-sonnet-4-6" });
    expect("effort" in fields && fields.effort === undefined).toBe(true);
  });
});
