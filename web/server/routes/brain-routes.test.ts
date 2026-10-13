import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * The Brains page API: CRUD of remote brains, where each is used, plugin
 * collisions and "Adopt plugin as brain", health and test connection (with
 * an injected fetch: never the network). Above all: no response ever
 * carries the bearer token. Temp dirs only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { registerBrainRoutes } from "./brain-routes.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { getDomain } from "../domain-store.js";
import type { FetchLike } from "../brain/brain-probe.js";

const TOKEN = "super-secret-token-value";
let tmp: string;
let app: Hono;
let fakeFetch: Mock<FetchLike>;
const saved = { root: process.env.COMPANION_DOMAINS_ROOT, claude: process.env.CLAUDE_CONFIG_DIR };

const send = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

function installPlugin(id: string, url: string, userOn: boolean) {
  const root = join(tmp, "plugins", id);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: id.split("@")[0] }));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ "jarvis-brain": { type: "http", url } }));
  mkdirSync(join(tmp, "claude", "plugins"), { recursive: true });
  writeFileSync(join(tmp, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", installPath: root }] } }));
  writeFileSync(join(tmp, "claude", "settings.json"), JSON.stringify({ enabledPlugins: { [id]: userOn } }));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-routes-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  app = new Hono();
  fakeFetch = vi.fn<FetchLike>(async (url: string) => {
    if (url.endsWith("/healthz")) return new Response(JSON.stringify({ status: "ok", version: "1", pages: 7, content_hash: "abc" }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } } }), {
      headers: { "content-type": "application/json" },
    });
  });
  registerBrainRoutes(app, { fetch: fakeFetch });
  registerDomainRoutes(app, { listSessions: () => [] }, { refreshAccountMcp: async () => ({ servers: [], at: Date.now() }) });
});

afterEach(() => {
  for (const [k, v] of [["COMPANION_DOMAINS_ROOT", saved.root], ["CLAUDE_CONFIG_DIR", saved.claude]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function createJarvis(body: Record<string, unknown> = {}) {
  const res = await app.request("/brains", send("POST", { name: "Jarvis", about: "Infra wiki", baseUrl: "http://100.116.99.9:7421", ...body }));
  expect(res.status).toBe(201);
  return res.json();
}

describe("CRUD", () => {
  it("creates a remote brain, on no domain, and lists it", async () => {
    const created = await createJarvis();
    expect(created).toMatchObject({
      slug: "jarvis", kind: "remote", serverName: "jarvis-brain", tokenEnvVar: "COMPANION_BRAIN_JARVIS_TOKEN", hasToken: false,
      urls: { mcpUrl: "http://100.116.99.9:7421/mcp", healthUrl: "http://100.116.99.9:7421/healthz", apiUrl: "http://100.116.99.9:7421/api/v1" },
      domains: [], collisions: [],
    });
    expect(created.skillText).toContain("name: jarvis-brain");
    const list = await (await app.request("/brains")).json();
    expect(list.brains.map((b: { slug: string }) => b.slug)).toEqual(["jarvis"]);
    expect((await app.request("/brains/jarvis")).status).toBe(200);
    expect((await app.request("/brains/nope")).status).toBe(404);
  });

  it("rejects invalid input with the store's error", async () => {
    const res = await app.request("/brains", send("POST", { name: "x", baseUrl: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("base URL");
    expect((await app.request("/brains", { method: "POST", body: "{bad" })).status).toBe(400);
  });

  it("updates and deletes a brain, clearing it from domains", async () => {
    await createJarvis();
    let res = await app.request("/brains/jarvis", send("PATCH", { about: "New", skill: { source: "custom", custom: "Body" } }));
    expect(await res.json()).toMatchObject({ about: "New", skill: { source: "custom" }, skillText: expect.stringContaining("Body") });
    res = await app.request("/brains/jarvis", send("PATCH", { baseUrl: "bad" }));
    expect(res.status).toBe(400);
    await app.request("/domains", send("POST", { name: "Herd" }));
    await app.request("/domains/herd", send("PATCH", { brain: "jarvis" }));
    res = await app.request("/brains/jarvis", send("DELETE"));
    expect(await res.json()).toEqual({ ok: true, clearedFrom: ["herd"] });
    expect(getDomain("herd")?.brain).toBeUndefined();
    expect((await app.request("/brains/jarvis", send("DELETE"))).status).toBe(404);
  });
});

describe("secrets", () => {
  // The token may be set, changed or removed through the API, but no
  // response (list, detail, create, update, health, test) ever echoes it.
  it("never returns the bearer token", async () => {
    const bodies: string[] = [];
    let res = await app.request("/brains", send("POST", { name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: TOKEN }));
    bodies.push(await res.text());
    for (const path of ["/brains", "/brains/team", "/brains/team/health", "/domains"]) {
      res = await app.request(path);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    res = await app.request("/brains/team/test", send("POST"));
    bodies.push(await res.text());
    res = await app.request("/brains/team", send("PATCH", { token: `${TOKEN}-2` }));
    bodies.push(await res.text());
    for (const body of bodies) expect(body).not.toContain(TOKEN);
    expect(JSON.parse(bodies[2])).toMatchObject({ hasToken: true, remote: { auth: { mode: "bearer" } } });
    // The token did reach the brain (server side only).
    expect(fakeFetch.mock.calls.some(([, init]) => (init as RequestInit).headers && JSON.stringify((init as RequestInit).headers).includes(TOKEN))).toBe(true);
    expect(readFileSync(join(h.home, "brains", "team", "secret"), "utf-8").trim()).toBe(`${TOKEN}-2`);
  });
});

describe("health and test", () => {
  it("checks health and tests the connection through the injected fetch", async () => {
    await createJarvis();
    const health = await (await app.request("/brains/jarvis/health")).json();
    expect(health).toMatchObject({ reachable: true, pages: 7, version: "1", content_hash: "abc" });
    const test = await (await app.request("/brains/jarvis/test", send("POST"))).json();
    expect(test.mcp).toMatchObject({ ok: true, serverName: "fake" });
    expect(fakeFetch.mock.calls.map(([u]) => u)).toContain("http://100.116.99.9:7421/mcp");
    expect((await app.request("/brains/nope/health")).status).toBe(404);
    expect((await app.request("/brains/nope/test", send("POST"))).status).toBe(404);
  });
});

describe("domains and collisions", () => {
  // The Domains page gets each domain's effective brain and the brain list.
  it("assigns a brain through PATCH /domains and shows where it is used", async () => {
    await createJarvis();
    await app.request("/domains", send("POST", { name: "Herd" }));
    let res = await app.request("/domains/herd", send("PATCH", { brain: "nope" }));
    expect(res.status).toBe(400);
    res = await app.request("/domains/global", send("PATCH", { brain: "jarvis" }));
    expect((await res.json()).effectiveBrain).toEqual({ slug: "jarvis", name: "Jarvis", own: true });
    const domains = await (await app.request("/domains")).json();
    expect(domains.brains).toEqual([{ slug: "jarvis", name: "Jarvis" }]);
    expect(domains.domains.find((d: { slug: string }) => d.slug === "herd").effectiveBrain).toEqual({ slug: "jarvis", name: "Jarvis", own: false });
    const brain = await (await app.request("/brains/jarvis")).json();
    expect(brain.domains).toEqual([{ slug: "global", name: "GLOBAL", own: true }, { slug: "herd", name: "Herd", own: false }]);
    res = await app.request("/domains/herd", send("PATCH", { brain: null }));
    expect((await res.json()).effectiveBrain).toBeNull();
    res = await app.request("/domains/global", send("PATCH", { brain: "inherit" }));
    expect(res.status).toBe(400);
  });

  // jarvis-brain's marketplace plugin serves the same URL: reported, then adopted.
  it("reports a colliding plugin and adopts it as the brain", async () => {
    installPlugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp", true);
    await createJarvis();
    await app.request("/domains", send("POST", { name: "Herd" }));
    const brain = await (await app.request("/brains/jarvis")).json();
    expect(brain.collisions).toEqual([
      { pluginId: "jarvis-brain@jarvis-lab", pluginName: "jarvis-brain", servers: ["jarvis-brain"], domains: ["global", "herd"] },
    ]);
    const res = await app.request("/brains/jarvis/adopt-plugin", send("POST", { pluginId: "jarvis-brain@jarvis-lab" }));
    const body = await res.json();
    expect(body.adoptedIn).toEqual(["global", "herd"]);
    expect(body.brain.collisions[0].domains).toEqual([]);
    expect(body.brain.domains.map((d: { slug: string }) => d.slug)).toEqual(["global", "herd"]);
    expect(getDomain("herd")).toMatchObject({ brain: "jarvis", plugins: { "jarvis-brain@jarvis-lab": false } });
  });

  it("refuses to adopt an unknown or non-colliding plugin", async () => {
    installPlugin("other@lab", "http://other/mcp", false);
    await createJarvis();
    expect((await app.request("/brains/jarvis/adopt-plugin", send("POST", { pluginId: "nope@x" }))).status).toBe(404);
    expect((await app.request("/brains/jarvis/adopt-plugin", send("POST", { pluginId: "other@lab" }))).status).toBe(409);
    expect((await app.request("/brains/nope/adopt-plugin", send("POST", { pluginId: "other@lab" }))).status).toBe(404);
    expect(existsSync(join(h.home, "brains", "jarvis"))).toBe(true);
  });
});
