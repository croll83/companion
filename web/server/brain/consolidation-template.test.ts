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

const h = vi.hoisted(() => ({ home: "", codex: null as null | { models: { slug: string; visibility: string; priority?: number }[] } }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("../codex-models.js", () => ({
  loadCodexCache: () => h.codex,
  pickerModels: (cache: { models: { slug: string; priority?: number }[] }) =>
    [...cache.models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map((m) => ({ value: m.slug, label: m.slug, description: "" })),
}));

import {
  consolidationAgentFields,
  consolidationAgentName,
  consolidationDomain,
  consolidationPrompt,
  curatorDir,
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
const config: ConsolidationConfig = { enabled: true, schedule: "0 5 * * *", mode: "local", backend: "claude", threshold: 10 };

describe("consolidation template", () => {
  it("writes a generic prompt: env credential, untrusted notes, no push", () => {
    const p = consolidationPrompt(brain);
    expect(p).toContain('knowledge base "Work"');
    expect(p).toContain("$BRAIN_API_URL");
    expect(p).toMatch(/UNTRUSTED claims/);
    expect(p).toMatch(/instructions aimed at an AI .* is rejected/);
    expect(p).toMatch(/Never push/);
    expect(p).toMatch(/append the returned log_entry to log\.md/);
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
});
