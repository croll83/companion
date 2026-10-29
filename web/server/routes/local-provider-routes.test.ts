import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { Hono } from "hono";

/**
 * /api/local-providers (Settings → Providers → Local LLM) and
 * /api/sessions/:id/local-metrics, against the real Companion LLM proxy
 * (tools/llm-proxy) in front of the fake Anthropic-compatible server, as on
 * a model host. Checks: the list is empty while "Enable local LLM" is off;
 * creating a provider reads models, window and levels from the proxy;
 * a session's numbers come from the proxy; and NO response (every GET
 * included) ever carries the provider token, only `hasToken`.
 */

const h = vi.hoisted(() => ({ home: "", enabled: true }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("../settings-manager.js", () => ({ getSettings: () => ({ localLlmEnabled: h.enabled }) }));

import { localSessionView, registerLocalProviderRoutes } from "./local-provider-routes.js";
import { LocalProviderHealthMonitor } from "../local-provider-health.js";
import { normalizeConfig, startProxy } from "../../../tools/llm-proxy/llm-proxy.mjs";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../../scripts/fake-anthropic-server.js";

const TOKEN = "super-secret-proxy-token";
let tmp: string;
let fake: FakeAnthropicServer;
let proxy: Server;
let proxyUrl: string;
let app: Hono;
let live = 0;
let health: LocalProviderHealthMonitor;
const sessionLocal = new Map<string, { provider: string; model: string; effort?: string }>();

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "local-routes-"));
  h.home = join(tmp, "companion");
  h.enabled = true;
  fake = await startFakeAnthropicServer({ models: ["my-model"] });
  proxy = await startProxy(normalizeConfig({
    listen: { host: "127.0.0.1", port: 0 }, upstream: { url: fake.url }, token: TOKEN, contextWindow: 131072, effort: { default: "high" },
  }), { logger: () => {} });
  proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  health = new LocalProviderHealthMonitor({ enabled: () => true });
  live = 0;
  sessionLocal.clear();
  app = new Hono();
  registerLocalProviderRoutes(app, {
    liveSessionsUsing: () => live,
    sessionLocal: (id) => sessionLocal.get(id),
    health,
  });
});
afterEach(async () => {
  await new Promise((r) => proxy.close(r));
  await fake.close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};
const createLab = () => call("POST", "/local-providers", { name: "Lab", baseUrl: proxyUrl, token: TOKEN });

describe("CRUD", () => {
  it("creates a provider and reads models, window and levels from the proxy", async () => {
    const created = await createLab();
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: "lab",
      models: ["my-model"],
      contextWindow: 131072,
      effortLevels: ["low", "medium", "high", "xhigh"],
      effortLabels: { low: "off", medium: "low", high: "medium", xhigh: "xhigh" },
      defaultEffort: "high",
      hasToken: true,
      health: { status: "online" },
    });
    expect(created.text).not.toContain(TOKEN);
  });

  // Off by default: the list is empty, so no page offers "Local".
  it("lists nothing while local LLM is off", async () => {
    await createLab();
    h.enabled = false;
    expect((await call("GET", "/local-providers")).json).toEqual([]);
  });

  // The guarantee asked by the design: no GET returns the token.
  it("never returns the token from any route", async () => {
    await createLab();
    sessionLocal.set("s1", { provider: "lab", model: "my-model", effort: "low" });
    const responses = [
      await call("GET", "/local-providers"),
      await call("GET", "/local-providers/lab"),
      await call("GET", "/sessions/s1/local-metrics"),
      await call("PATCH", "/local-providers/lab", { name: "Lab bis" }),
      await call("POST", "/local-providers/lab/refresh"),
      await call("POST", "/local-providers/test", { id: "lab" }),
    ];
    for (const r of responses) {
      expect(r.status).toBeLessThan(300);
      expect(r.text).not.toContain(TOKEN);
    }
    expect(responses[0].json[0]).toMatchObject({ id: "lab", hasToken: true });
    expect(responses[0].json[0]).not.toHaveProperty("token");
    expect(responses[4].json).toMatchObject({ ok: true, viaProxy: true });
  });

  it("updates, refuses bad input and 404s unknown providers", async () => {
    await createLab();
    // /health needs no token, so removing it keeps the badge online; /info then refuses.
    const patched = await call("PATCH", "/local-providers/lab", { contextWindow: 65536, token: "" });
    expect(patched.json).toMatchObject({ contextWindow: 65536, hasToken: false, health: { status: "online" } });
    expect((await call("POST", "/local-providers/lab/refresh")).json).toMatchObject({ ok: false, error: expect.stringContaining("refused the token") });
    expect((await call("PATCH", "/local-providers/lab", { baseUrl: "nope" })).status).toBe(400);
    expect((await call("PATCH", "/local-providers/missing", {})).status).toBe(404);
    expect((await call("GET", "/local-providers/missing")).status).toBe(404);
    expect((await call("POST", "/local-providers", { name: "" })).status).toBe(400);
    expect((await call("POST", "/local-providers/missing/refresh")).status).toBe(404);
  });

  // A proxy that is off at creation: the provider is saved, without models, and shown offline.
  it("saves a provider whose proxy is off", async () => {
    const created = await call("POST", "/local-providers", { name: "Off", baseUrl: "http://127.0.0.1:1" });
    expect(created.json).toMatchObject({ models: [], health: { status: "offline" } });
  });

  it("refuses to delete a provider live sessions run on", async () => {
    await createLab();
    live = 2;
    expect((await call("DELETE", "/local-providers/lab")).status).toBe(409);
    live = 0;
    expect((await call("DELETE", "/local-providers/lab")).json).toEqual({ ok: true });
    expect((await call("DELETE", "/local-providers/lab")).status).toBe(404);
    expect((await call("GET", "/local-providers")).json).toEqual([]);
  });
});

describe("POST /local-providers/test", () => {
  it("tests a URL before it is saved, with a typed token", async () => {
    expect((await call("POST", "/local-providers/test", { baseUrl: proxyUrl, token: TOKEN })).json)
      .toMatchObject({ ok: true, viaProxy: true, models: ["my-model"], contextWindow: 131072, effort: { default: "high" } });
    expect((await call("POST", "/local-providers/test", { baseUrl: proxyUrl, token: "wrong" })).json)
      .toMatchObject({ ok: false, error: expect.stringContaining("refused the token") });
    // A plain server (the fake vLLM itself): no /info, models only.
    expect((await call("POST", "/local-providers/test", { baseUrl: fake.url })).json).toMatchObject({ ok: true, viaProxy: false, models: ["my-model"] });
    expect((await call("POST", "/local-providers/test", { baseUrl: "bad" })).status).toBe(400);
  });
});

describe("local metrics", () => {
  // The numbers of one session, as the proxy measured them (X-Companion-Session header).
  it("reads the session's numbers from its proxy", async () => {
    await createLab();
    const sid = "aaaaaaaa-0000-0000-0000-000000000001";
    sessionLocal.set(sid, { provider: "lab", model: "my-model", effort: "xhigh" });
    const empty = await call("GET", `/sessions/${sid}/local-metrics`);
    expect(empty.json).toMatchObject({ provider: { id: "lab", name: "Lab", contextWindow: 131072 }, model: "my-model", effort: "xhigh", effortLabel: "xhigh", metrics: null });
    const res = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-companion-session": sid },
      body: JSON.stringify({ model: "sonnet", stream: true, messages: [{ role: "user", content: "hi" }], output_config: { effort: "xhigh" } }),
    });
    await res.text();
    const full = await call("GET", `/sessions/${sid}/local-metrics`);
    expect(full.json.metrics).toMatchObject({ requests: 1, authSeen: ["authorization: proxy token"], last: { effort: "xhigh" } });
    expect((await call("GET", "/sessions/nope/local-metrics")).status).toBe(404);
    sessionLocal.set("gone", { provider: "deleted", model: "m" });
    expect((await call("GET", "/sessions/gone/local-metrics")).json.provider).toEqual({ id: "deleted", missing: true });
  });

  it("says why the numbers are missing when the proxy cannot be asked", async () => {
    await createLab();
    sessionLocal.set("s2", { provider: "lab", model: "my-model" });
    await call("PATCH", "/local-providers/lab", { token: "" });
    expect((await call("GET", "/sessions/s2/local-metrics")).json).toMatchObject({ metrics: null, metricsError: "the proxy answered HTTP 401", effortLabel: null });
    await new Promise((r) => proxy.close(r));
    expect((await call("GET", "/sessions/s2/local-metrics")).json.metricsError).toBeTruthy();
    proxy = await startProxy(normalizeConfig({ listen: { host: "127.0.0.1", port: 0 }, upstream: { url: fake.url }, token: TOKEN }), { logger: () => {} });
  });

  it("localSessionView names the provider and its levels, or flags it missing", async () => {
    await createLab();
    expect(localSessionView({ provider: "lab", model: "my-model" })).toEqual({
      provider: "lab", model: "my-model", providerName: "Lab",
      effortLevels: ["low", "medium", "high", "xhigh"], effortLabels: { low: "off", medium: "low", high: "medium", xhigh: "xhigh" },
      defaultEffort: "high", contextWindow: 131072,
    });
    expect(localSessionView({ provider: "x", model: "m" })).toMatchObject({ missing: true, effortLevels: [] });
  });
});
