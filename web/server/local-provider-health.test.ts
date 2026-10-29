import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Health and model discovery of local providers: /health first, /v1/models
 * when the server has no /health, the token sent as a bearer, timeouts and
 * refusals reported as offline with a reason, the 30 s monitor, and
 * "Refresh models" following the server unless the list was typed by hand.
 * The servers are fakes (a fetch stub, or the fake Anthropic server).
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({ localLlmEnabled: true }) }));

import {
  fetchModels,
  LocalProviderHealthMonitor,
  parseModelList,
  probeProvider,
  fetchProxyInfo,
  refreshProviderInfo,
  type FetchLike,
} from "./local-provider-health.js";
import { createLocalProvider, getLocalProvider, updateLocalProvider } from "./local-providers.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../scripts/fake-anthropic-server.js";

let tmp: string;
let fake: FakeAnthropicServer | null = null;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "local-health-"));
  h.home = join(tmp, "companion");
});
afterEach(async () => {
  await fake?.close();
  fake = null;
  rmSync(tmp, { recursive: true, force: true });
});

const stub = (routes: Record<string, () => Response | Promise<Response>>): FetchLike & { calls: [string, RequestInit | undefined][] } => {
  const calls: [string, RequestInit | undefined][] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
};

describe("parseModelList", () => {
  it("reads OpenAI/Anthropic-style lists and ignores junk", () => {
    expect(parseModelList({ data: [{ id: "a" }, { id: "" }, { nope: 1 }, null, { id: "b" }] })).toEqual(["a", "b"]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: "x" })).toEqual([]);
  });
});

describe("probeProvider / fetchModels", () => {
  it("is online when /health answers, with the bearer token", async () => {
    const f = stub({ "/health": () => new Response("") });
    const r = await probeProvider("http://p", "tok", f);
    expect(r.status).toBe("online");
    expect((f.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  // llama.cpp-style servers without /health: the models list proves it is up.
  it("falls back to /v1/models when /health is missing", async () => {
    fake = await startFakeAnthropicServer({ health: false, models: ["m1", "m2"] });
    expect(await probeProvider(fake.url, null)).toMatchObject({ status: "online" });
    expect(await fetchModels(fake.url, null)).toMatchObject({ ok: true, models: ["m1", "m2"] });
  });

  it("reports why it is offline", async () => {
    expect(await probeProvider("http://p", null, stub({ "/health": () => new Response("", { status: 500 }) })))
      .toMatchObject({ status: "offline", error: "GET /health answered HTTP 500" });
    const refused = (async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }) as FetchLike;
    expect(await probeProvider("http://p", null, refused)).toMatchObject({ status: "offline", error: "ECONNREFUSED" });
    const timeout = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as FetchLike;
    expect(await fetchModels("http://p", null, timeout)).toEqual({ ok: false, error: "no answer within 5 s" });
    expect(await fetchModels("http://p", "bad", stub({ "/v1/models": () => new Response("", { status: 401 }) })))
      .toEqual({ ok: false, error: "The server refused the token (HTTP 401)" });
    expect(await fetchModels("http://p", null, stub({ "/v1/models": () => new Response("", { status: 502 }) })))
      .toEqual({ ok: false, error: "GET /v1/models answered HTTP 502" });
    expect(await probeProvider("http://p", null, stub({}))).toMatchObject({ status: "offline", error: "GET /v1/models answered HTTP 404" });
    const odd = (async () => { throw "boom"; }) as FetchLike;
    expect(await fetchModels("http://p", null, odd)).toEqual({ ok: false, error: "boom" });
  });

  // The fake server enforces its token, as vLLM --api-key does.
  it("uses the token against a server that requires one", async () => {
    fake = await startFakeAnthropicServer({ token: "secret", models: ["my-model"] });
    expect(await fetchModels(fake.url, "secret")).toMatchObject({ ok: true, models: ["my-model"] });
    expect(await fetchModels(fake.url, "wrong")).toMatchObject({ ok: false });
  });
});

describe("LocalProviderHealthMonitor", () => {
  it("checks every provider, keeps the result and forgets deleted ones", async () => {
    const f = stub({ "/health": () => new Response("") });
    const providers = [{ id: "a", baseUrl: "http://a" }, { id: "b", baseUrl: "http://b" }];
    const m = new LocalProviderHealthMonitor({
      fetch: f,
      list: () => providers as never,
      token: (id) => (id === "a" ? "ta" : null),
      enabled: () => true,
    });
    expect(m.get("a")).toEqual({ status: "unknown" });
    await m.checkAll();
    expect(m.get("a").status).toBe("online");
    expect(m.get("b").status).toBe("online");
    providers.pop();
    await m.checkAll();
    expect(m.get("b")).toEqual({ status: "unknown" });
    m.forget("a");
    expect(m.get("a")).toEqual({ status: "unknown" });
  });

  // A change of state is logged once (offline -> online), not at every tick.
  it("logs transitions and never runs two checks of one provider at once", async () => {
    let up = false;
    const f = (async () => new Response("", { status: up ? 200 : 503 })) as FetchLike;
    const m = new LocalProviderHealthMonitor({ fetch: f, list: () => [], token: () => null });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await m.check({ id: "x", baseUrl: "http://x" });
    up = true;
    const [first, second] = await Promise.all([m.check({ id: "x", baseUrl: "http://x" }), m.check({ id: "x", baseUrl: "http://x" })]);
    expect(first.status).toBe("online");
    expect(second.status).toBe("offline");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("x is now online"));
    log.mockRestore();
  });

  it("polls on an interval until stopped", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(async () => new Response(""));
      const m = new LocalProviderHealthMonitor({ fetch: f as FetchLike, list: () => [{ id: "a", baseUrl: "http://a" }] as never, token: () => null, enabled: () => true });
      m.start(1000);
      m.start(1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
      m.stop();
      const n = f.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.mock.calls.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchProxyInfo / refreshProviderInfo", () => {
  // The Companion LLM proxy publishes its models, window and levels on GET /info.
  it("reads the proxy's /info and stores it", async () => {
    const info = { models: ["my-model"], contextWindow: 65536, effort: { default: "high", levels: [{ name: "off", claude: "low" }, { name: "medium", claude: "high" }] } };
    const f = stub({ "/info": () => Response.json(info) });
    expect(await fetchProxyInfo("http://p", "t", f)).toMatchObject({ ok: true, viaProxy: true, ...info });
    const r = createLocalProvider({ name: "Proxy", baseUrl: "http://p" });
    if (!r.ok) throw new Error(r.error);
    const refreshed = await refreshProviderInfo(r.provider, f);
    expect(refreshed.ok).toBe(true);
    expect(getLocalProvider(r.provider.id)).toMatchObject({ models: ["my-model"], contextWindow: 65536, effortLevels: ["low", "high"], effortLabels: { low: "off", high: "medium" }, defaultEffort: "high" });
  });

  // The proxy's web search flag travels to the stored provider (it decides whether sessions keep WebSearch).
  it("reads the proxy's web search and stores it", async () => {
    const f = stub({ "/info": () => Response.json({ models: ["m"], webSearch: true, searchBackend: "tavily" }) });
    expect(await fetchProxyInfo("http://p", "t", f)).toMatchObject({ ok: true, viaProxy: true, webSearch: true, searchBackend: "tavily" });
    const r = createLocalProvider({ name: "Search", baseUrl: "http://p" });
    if (!r.ok) throw new Error(r.error);
    await refreshProviderInfo(r.provider, f);
    expect(getLocalProvider(r.provider.id)?.webSearchBackend).toBe("tavily");
    const older = stub({ "/info": () => Response.json({ models: ["m"] }) });
    expect(await fetchProxyInfo("http://p", "t", older)).toMatchObject({ webSearch: false, searchBackend: null });
    await refreshProviderInfo(r.provider, older);
    expect(getLocalProvider(r.provider.id)?.webSearchBackend).toBeUndefined();
  });

  // A plain Anthropic-compatible server (no proxy): models and vLLM's max_model_len from /v1/models.
  it("falls back to /v1/models with max_model_len", async () => {
    const f = stub({ "/v1/models": () => Response.json({ data: [{ id: "m", max_model_len: 32768 }] }) });
    expect(await fetchProxyInfo("http://p", null, f)).toEqual({ ok: true, viaProxy: false, latencyMs: expect.any(Number), models: ["m"], contextWindow: 32768 });
    const odd = stub({ "/info": () => Response.json({ hello: 1 }), "/v1/models": () => Response.json({ data: [] }) });
    expect(await fetchProxyInfo("http://p", null, odd)).toMatchObject({ ok: true, viaProxy: false, models: [], contextWindow: null });
  });

  it("reports a refused token, an unreachable proxy, and a failed refresh", async () => {
    expect(await fetchProxyInfo("http://p", "bad", stub({ "/info": () => new Response("", { status: 401 }) }))).toEqual({ ok: false, error: "The proxy refused the token (HTTP 401)" });
    const refused = (async () => { throw Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } }); }) as FetchLike;
    expect(await fetchProxyInfo("http://p", null, refused)).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(await fetchProxyInfo("http://p", null, stub({}))).toEqual({ ok: false, error: "GET /v1/models answered HTTP 404" });
    const r = createLocalProvider({ name: "Down", baseUrl: "http://127.0.0.1:1" });
    if (!r.ok) throw new Error(r.error);
    expect((await refreshProviderInfo(r.provider)).ok).toBe(false);
  });

  it("uses the fake Anthropic server (not a proxy) end to end", async () => {
    fake = await startFakeAnthropicServer({ models: ["qwen3-coder"] });
    const r = createLocalProvider({ name: "Fake", baseUrl: fake.url });
    if (!r.ok) throw new Error(r.error);
    expect(await refreshProviderInfo(r.provider)).toMatchObject({ ok: true, viaProxy: false });
    expect(getLocalProvider(r.provider.id)?.models).toEqual(["qwen3-coder"]);
    updateLocalProvider(r.provider.id, { models: ["mine"], modelsManual: true });
    await refreshProviderInfo(getLocalProvider(r.provider.id)!);
    expect(getLocalProvider(r.provider.id)?.models).toEqual(["mine"]);
  });
});

describe("polling switch", () => {
  // Off by default: no request to any provider until "Enable local LLM" is on.
  it("does not poll while local LLM is off", async () => {
    const f = vi.fn(async () => new Response(""));
    const m = new LocalProviderHealthMonitor({ fetch: f as FetchLike, list: () => [{ id: "a", baseUrl: "http://a" }] as never, token: () => null, enabled: () => false });
    await m.checkAll();
    expect(f).not.toHaveBeenCalled();
  });
});
