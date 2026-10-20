import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The local-provider registry: COMPANION_HOME/local-providers.json (no token
 * ever) and the 0600 token files, validation of every editable field, the
 * reasoning levels (Claude Code effort values, named after the model levels
 * the proxy maps them to), what the proxy's /info updates, the "Enable local
 * LLM" switch, and the checks a
 * session's provider/model/level go through. Temp dirs only.
 */

const h = vi.hoisted(() => ({ home: "", enabled: true }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({ localLlmEnabled: h.enabled }) }));

import {
  createLocalProvider,
  defaultLocalModel,
  deleteLocalProvider,
  applyProxyInfo,
  isLocalLlmEnabled,
  getLocalProvider,
  hasLocalProviderToken,
  listLocalProviders,
  localProvidersDir,
  normalizeBaseUrl,
  readLocalProviderToken,
  resolveLocalChoice,
  settleLocalEffort,
  updateLocalProvider,
  DEFAULT_LOCAL_EFFORT_LEVELS,
  DEFAULT_CONTEXT_WINDOW,
} from "./local-providers.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "local-providers-"));
  h.home = join(tmp, "companion");
  h.enabled = true;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function create(extra: Record<string, unknown> = {}) {
  const r = createLocalProvider({ name: "Lab vLLM", baseUrl: "http://vllm.example:30000/v1/", models: ["my-model"], ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.provider;
}

describe("normalizeBaseUrl", () => {
  // Users paste the root or the /v1 URL; the proxy always appends /v1/...
  it("strips trailing slashes and /v1", () => {
    expect(normalizeBaseUrl("http://host:30000/")).toBe("http://host:30000");
    expect(normalizeBaseUrl("http://host:30000/v1")).toBe("http://host:30000");
    expect(normalizeBaseUrl(" https://gw.example/anthropic/v1/ ")).toBe("https://gw.example/anthropic");
  });
  it("refuses what is not a plain http(s) URL", () => {
    for (const bad of ["ftp://x", "host:30000", "", 42, "http://u:p@host", "http://host/?a=1"]) {
      expect(normalizeBaseUrl(bad)).toBeNull();
    }
  });
});

describe("create / read", () => {
  it("creates a provider with the Qwen defaults and a slug id", () => {
    const p = create();
    expect(p).toMatchObject({
      id: "lab-vllm",
      name: "Lab vLLM",
      baseUrl: "http://vllm.example:30000",
      models: ["my-model"],
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      effortLevels: DEFAULT_LOCAL_EFFORT_LEVELS,
      effortLabels: { low: "off", medium: "low", high: "medium", xhigh: "xhigh" },
      defaultEffort: "high",
    });
    expect(listLocalProviders().map((x) => x.id)).toEqual(["lab-vllm"]);
    expect(getLocalProvider("lab-vllm")?.name).toBe("Lab vLLM");
  });

  it("gives a second provider with the same name its own id", () => {
    create();
    expect(create().id).toBe("lab-vllm-2");
  });

  // The token lives in its own 0600 file, never in the JSON registry.
  it("stores the token in a 0600 file and never in local-providers.json", () => {
    const p = create({ token: "s3cret-token" });
    const registry = readFileSync(join(h.home, "local-providers.json"), "utf-8");
    expect(registry).not.toContain("s3cret-token");
    const file = join(localProvidersDir(), `${p.id}.secret`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readLocalProviderToken(p.id)).toBe("s3cret-token");
    expect(hasLocalProviderToken(p.id)).toBe(true);
    expect(JSON.stringify(p)).not.toContain("s3cret-token");
  });

  it("refuses missing or invalid fields", () => {
    expect(createLocalProvider({ baseUrl: "http://x" })).toMatchObject({ ok: false, status: 400 });
    expect(createLocalProvider({ name: "x" })).toMatchObject({ ok: false, error: "A base URL is required" });
    expect(createLocalProvider({ name: "x", baseUrl: "nope" })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", contextWindow: 1000 })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", models: "m" })).toMatchObject({ ok: false });
    // Levels are Claude Code effort values: "off" cannot travel as output_config.effort.
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", effortLevels: ["off"] })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", effortLabels: { low: "bad/label" } })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", effortLabels: "x" })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", defaultEffort: "max" })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", token: "has space" })).toMatchObject({ ok: false, error: "Invalid token" });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", defaultModel: 3 })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x", baseUrl: "http://x", defaultEffort: 3 })).toMatchObject({ ok: false });
    expect(createLocalProvider({ name: "x".repeat(81), baseUrl: "http://x" })).toMatchObject({ ok: false });
    expect(listLocalProviders()).toEqual([]);
  });

  // Own levels without a default must not inherit one they may lack; labels keep only listed levels, in the CLI's order.
  it("keeps no default level when custom levels come without one, and orders the levels", () => {
    const p = create({ effortLevels: ["max", "low", "low"], effortLabels: { low: "off", max: "deep", high: "ignored" } });
    expect(p.defaultEffort).toBeUndefined();
    expect(p.effortLevels).toEqual(["low", "max"]);
    expect(p.effortLabels).toEqual({ low: "off", max: "deep" });
  });

  // A hand-edited registry with a broken entry must not break the others.
  it("skips unusable entries and repairs odd values when reading", () => {
    writeFileSync(join(h.home, "..", "x"), "");
    create();
    const path = join(h.home, "local-providers.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.providers.push({ id: "BAD ID", name: "x", baseUrl: "http://x" });
    raw.providers.push({ id: "odd", name: "Odd", baseUrl: "http://odd", contextWindow: "big", effortLevels: "x", defaultEffort: "zzz", models: [1] });
    writeFileSync(path, JSON.stringify(raw));
    const odd = getLocalProvider("odd");
    expect(odd).toMatchObject({ contextWindow: DEFAULT_CONTEXT_WINDOW, effortLevels: DEFAULT_LOCAL_EFFORT_LEVELS, models: [] });
    expect(odd?.defaultEffort).toBeUndefined();
    expect(listLocalProviders().map((p) => p.id).sort()).toEqual(["lab-vllm", "odd"]);
    writeFileSync(path, "not json");
    expect(listLocalProviders()).toEqual([]);
    writeFileSync(path, JSON.stringify({ providers: "x" }));
    expect(listLocalProviders()).toEqual([]);
  });
});

describe("update / delete", () => {
  it("updates fields, sets and clears the token", () => {
    const p = create();
    const r = updateLocalProvider(p.id, {
      name: "Renamed", baseUrl: "http://other:1/v1", contextWindow: 65536, token: "t1",
      models: ["a", "b", "a"], modelsManual: true, defaultModel: "b",
      effortLevels: ["low", "high"], defaultEffort: "high",
    });
    expect(r).toMatchObject({ ok: true, provider: { id: p.id, name: "Renamed", baseUrl: "http://other:1", contextWindow: 65536, models: ["a", "b"], modelsManual: true, defaultModel: "b", defaultEffort: "high" } });
    expect(readLocalProviderToken(p.id)).toBe("t1");
    expect(updateLocalProvider(p.id, { token: "" }).ok).toBe(true);
    expect(hasLocalProviderToken(p.id)).toBe(false);
    expect(updateLocalProvider(p.id, { modelsManual: false, defaultModel: null, defaultEffort: "" })).toMatchObject({ ok: true });
    const after = getLocalProvider(p.id);
    expect(after?.modelsManual).toBeUndefined();
    expect(after?.defaultModel).toBeUndefined();
    expect(after?.defaultEffort).toBeUndefined();
  });

  it("drops a default model that is no longer listed, refuses a default level that is not", () => {
    const p = create({ defaultModel: "my-model" });
    expect(updateLocalProvider(p.id, { models: ["other"] })).toMatchObject({ ok: true });
    expect(getLocalProvider(p.id)?.defaultModel).toBeUndefined();
    expect(updateLocalProvider(p.id, { effortLevels: ["low"] })).toMatchObject({ ok: false });
    expect(updateLocalProvider(p.id, { effortLevels: ["low", "high"], effortLabels: {} })).toMatchObject({ ok: true });
    expect(getLocalProvider(p.id)?.effortLabels).toBeUndefined();
    expect(updateLocalProvider(p.id, { name: "" })).toMatchObject({ ok: false });
    expect(updateLocalProvider(p.id, { baseUrl: "x" })).toMatchObject({ ok: false });
    expect(updateLocalProvider(p.id, { token: 5 })).toMatchObject({ ok: false });
    expect(updateLocalProvider("missing", {})).toMatchObject({ ok: false, status: 404 });
  });

  it("deletes the provider and its token", () => {
    const p = create({ token: "t" });
    expect(deleteLocalProvider(p.id)).toBe(true);
    expect(getLocalProvider(p.id)).toBeUndefined();
    expect(existsSync(join(localProvidersDir(), `${p.id}.secret`))).toBe(false);
    expect(deleteLocalProvider(p.id)).toBe(false);
  });
});

describe("applyProxyInfo", () => {
  // The proxy's config is the source of truth for models, window and the level mapping.
  it("takes models, context window and levels from the proxy", () => {
    const p = create({ defaultModel: "my-model" });
    const next = applyProxyInfo(p.id, {
      models: ["other-model"],
      contextWindow: 65536,
      effort: { default: "medium", levels: [{ name: "none", claude: "medium" }, { name: "deep", claude: "max" }, { name: "x", claude: "ultra" }] },
    });
    expect(next).toMatchObject({ models: ["other-model"], contextWindow: 65536, effortLevels: ["medium", "max"], effortLabels: { medium: "none", max: "deep" }, defaultEffort: "medium" });
    expect(next?.defaultModel).toBeUndefined();
    // Same info again: nothing to write.
    const at = getLocalProvider(p.id)!.updatedAt;
    applyProxyInfo(p.id, { models: ["other-model"], contextWindow: 65536, effort: { default: "medium", levels: [{ name: "none", claude: "medium" }, { name: "deep", claude: "max" }] } });
    expect(getLocalProvider(p.id)!.updatedAt).toBe(at);
  });

  // webSearch: true on /info keeps Claude Code's WebSearch on the provider's sessions; anything else turns it off.
  it("stores whether the proxy answers web search, and its backend", () => {
    const p = create();
    expect(applyProxyInfo(p.id, { models: [], webSearch: true, searchBackend: "tavily" })?.webSearchBackend).toBe("tavily");
    expect(getLocalProvider(p.id)?.webSearchBackend).toBe("tavily");
    // A backend name that is not a short label still means "on".
    expect(applyProxyInfo(p.id, { models: [], webSearch: true, searchBackend: "<b>bad</b>" })?.webSearchBackend).toBe("on");
    // An older proxy (no field) or a server that is not the proxy: off.
    expect(applyProxyInfo(p.id, { models: [] })?.webSearchBackend).toBeUndefined();
    expect(getLocalProvider(p.id)?.webSearchBackend).toBeUndefined();
  });

  it("keeps a hand-typed model list, ignores a bad window and drops a default the levels lack", () => {
    const p = create({ models: ["mine"], modelsManual: true, effortLevels: ["xhigh"], defaultEffort: "xhigh" });
    const next = applyProxyInfo(p.id, { models: ["theirs"], contextWindow: 10, effort: { levels: [{ name: "low", claude: "low" }] } });
    expect(next).toMatchObject({ models: ["mine"], contextWindow: DEFAULT_CONTEXT_WINDOW, effortLevels: ["low"] });
    expect(next?.defaultEffort).toBeUndefined();
    expect(applyProxyInfo("missing", { models: [] })).toBeUndefined();
  });
});

describe("resolveLocalChoice", () => {
  // What a new session or agent run is checked against before it spawns.
  it("resolves the default model and settles the level", () => {
    const p = create({ models: ["a", "b"], defaultModel: "b" });
    expect(defaultLocalModel(p)).toBe("b");
    expect(resolveLocalChoice({ provider: p.id }, "bogus")).toMatchObject({ ok: true, local: { provider: p.id, model: "b" }, effort: "high" });
    expect(resolveLocalChoice({ provider: p.id, model: "a" }, "low")).toMatchObject({ ok: true, local: { model: "a" }, effort: "low" });
    expect(settleLocalEffort({ ...p, defaultEffort: undefined }, null)).toBeUndefined();
  });
  it("explains what is wrong", () => {
    const p = create();
    expect(resolveLocalChoice(undefined, null)).toMatchObject({ ok: false, error: "A local provider is required" });
    // Off by default: nothing local starts until "Enable local LLM" is on.
    h.enabled = false;
    expect(isLocalLlmEnabled()).toBe(false);
    expect(resolveLocalChoice({ provider: p.id }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Enable local LLM") });
    h.enabled = true;
    expect(resolveLocalChoice({ provider: "nope" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("Unknown local provider") });
    expect(resolveLocalChoice({ provider: p.id, model: "claude-opus-5-5" }, null)).toMatchObject({ ok: false, error: expect.stringContaining("not a model") });
    updateLocalProvider(p.id, { models: [] });
    expect(resolveLocalChoice({ provider: p.id }, null)).toMatchObject({ ok: false, error: expect.stringContaining("has no model") });
  });
});
