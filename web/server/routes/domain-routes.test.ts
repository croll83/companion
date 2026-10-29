import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * The Domains page API: list (with session counts, memory, skills, MCP
 * toggles), create, update toggles, delete (registry only, refused while a
 * session uses the domain) and edit CLAUDE.md / mcp.json. Temp dirs only.
 */

const h = vi.hoisted(() => ({ home: "" }));
// "Enable local LLM" on, for the domain default tests (never the real settings file).
vi.mock("../settings-manager.js", async (orig) => ({
  ...(await orig<typeof import("../settings-manager.js")>()),
  getSettings: () => ({ localLlmEnabled: true }),
}));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { registerDomainRoutes } from "./domain-routes.js";
import type { AccountMcpList } from "../account-mcp.js";
import { domainDir, getDomain, setDomainLinear } from "../domain-store.js";
import { createLocalProvider } from "../local-providers.js";

let tmp: string;
let sessions: { domain?: string; archived?: boolean }[];
let app: Hono;
let refreshAccountMcp: Mock<() => Promise<AccountMcpList>>;
// Probes and OAuth calls of private MCP servers: never the network. By
// default every server is open (initialize 200, no OAuth metadata).
let mcpAuthFetch: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
const saved = { root: process.env.COMPANION_DOMAINS_ROOT, claude: process.env.CLAUDE_CONFIG_DIR };

const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = (body: unknown) => ({ ...json(body), method: "PATCH" });
const put = (body: unknown) => ({ ...json(body), method: "PUT" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "domain-routes-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  sessions = [];
  app = new Hono();
  // Never run the real `claude mcp list` from tests.
  refreshAccountMcp = vi.fn(async (): Promise<AccountMcpList> => ({ servers: [], at: Date.now() }));
  mcpAuthFetch = vi.fn(async (_url: string, init?: RequestInit) => new Response("{}", { status: init?.method === "POST" ? 200 : 404 }));
  registerDomainRoutes(app, { listSessions: () => sessions }, { refreshAccountMcp, mcpAuthFetch });
});

afterEach(() => {
  for (const [k, v] of [["COMPANION_DOMAINS_ROOT", saved.root], ["CLAUDE_CONFIG_DIR", saved.claude]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /domains", () => {
  // Legacy sessions (no domain on record) count under GLOBAL.
  it("lists GLOBAL with its stats, creating it when missing", async () => {
    sessions = [{ domain: "global" }, {}, { domain: "global", archived: true }];
    const res = await app.request("/domains");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toBe(join(tmp, "home"));
    expect(body.skillGroups.map((g: { id: string }) => g.id)).toEqual(["user", "claude-ai", "design"]);
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0]).toMatchObject({
      slug: "global",
      path: domainDir("global"),
      sessionCount: 2,
      totalSessions: 3,
      memoryNotes: 0,
      skills: [],
      mcpServers: [],
      skillGroupStates: { user: { on: true, own: false }, "claude-ai": { on: true, own: false }, design: { on: true, own: false } },
    });
  });

  it("reports skills, memory notes, MCP servers and a broken mcp.json", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    const dir = domainDir("herd");
    mkdirSync(join(dir, "skills", "hello"), { recursive: true });
    writeFileSync(join(dir, "skills", "hello", "SKILL.md"), "x");
    writeFileSync(join(dir, "memory", "fact.md"), "x");
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { ping: { command: "node" } } }));
    let herd = (await (await app.request("/domains")).json()).domains.find((d: { slug: string }) => d.slug === "herd");
    expect(herd).toMatchObject({ skills: ["hello"], memoryNotes: 1, mcpServers: [{ name: "ping", source: "domain", enabled: true, type: "stdio" }] });
    writeFileSync(join(dir, "mcp.json"), "{");
    herd = (await (await app.request("/domains")).json()).domains.find((d: { slug: string }) => d.slug === "herd");
    expect(herd.mcpError).toMatch(/Invalid JSON/);
  });
});

describe("POST/PATCH/DELETE /domains", () => {
  it("creates a domain, rejecting duplicates", async () => {
    const res = await app.request("/domains", json({ name: "Herd", description: "d" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ slug: "herd", name: "Herd", description: "d", path: domainDir("herd") });
    expect((await app.request("/domains", json({ name: "herd" }))).status).toBe(409);
    expect((await app.request("/domains", json({}))).status).toBe(400);
  });

  it("updates toggles and reports the effective skill-group state", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    await app.request("/domains/global", patch({ skillGroups: { design: false } }));
    const res = await app.request("/domains/herd", patch({ chrome: true, mcpDisabled: ["gh"], skillGroups: { user: false } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ chrome: true, mcp: { gh: false } });
    expect(body.skillGroupStates).toEqual({
      user: { on: false, own: true, onCount: 0 },
      "claude-ai": { on: true, own: false, onCount: 0 },
      design: { on: false, own: false, onCount: 0 }, // inherited from GLOBAL
    });
    // One design skill turned back on: the group is now "mixed" (1 of 18 on).
    const one = await (await app.request("/domains/herd", patch({ skillChoices: { "design:polish": true } }))).json();
    expect(one.skillGroupStates.design).toEqual({ on: false, own: false, onCount: 1 });
    expect(one.skillStates["design:polish"]).toEqual({ on: true, own: true });
    expect(one.skillStates["design:adapt"]).toEqual({ on: false, own: false });
    expect((await app.request("/domains/herd", patch({ chrome: "yes" }))).status).toBe(400);
    expect((await app.request("/domains/nope", patch({}))).status).toBe(404);
  });

  // Rename = display name only: the slug (and so the folder, memory and URL) never changes.
  it("renames a domain's display name, keeping its slug and folder", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    const res = await app.request("/domains/herd", patch({ name: "  Baskets " }));
    expect(await res.json()).toMatchObject({ slug: "herd", name: "Baskets", path: domainDir("herd") });
    expect((await app.request("/domains/herd", patch({ name: " " }))).status).toBe(400);
    expect(getDomain("herd")?.name).toBe("Baskets");
  });

  // The Linear link is listed with ids and names only (the key stays in
  // linear-connections.json), and PATCH cannot set it without validation.
  it("lists a domain's Linear link without any key, and ignores it in PATCH", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    setDomainLinear("herd", { connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", projectId: "p1", projectName: "Bskts" });
    await app.request("/domains/herd", patch({ linear: { connectionId: "evil", teamId: "x" } }));
    const text = await (await app.request("/domains")).text();
    expect(text).not.toMatch(/apiKey|lin_api_/);
    const herd = JSON.parse(text).domains.find((d: { slug: string }) => d.slug === "herd");
    expect(herd.linear).toEqual({ connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", projectId: "p1", projectName: "Bskts" });
  });

  // Never deletes files; refused while any session (archived too) uses it.
  it("deletes only the registry entry, and only when no session uses the domain", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    sessions = [{ domain: "herd", archived: true }];
    const blocked = await app.request("/domains/herd", { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toMatch(/1 session/);

    sessions = [];
    const res = await app.request("/domains/herd", { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, keptOnDisk: domainDir("herd") });
    expect(getDomain("herd")).toBeUndefined();
    expect(existsSync(join(domainDir("herd"), "CLAUDE.md"))).toBe(true);
    expect((await app.request("/domains/global", { method: "DELETE" })).status).toBe(400);
    expect((await app.request("/domains/nope", { method: "DELETE" })).status).toBe(404);
  });
});

describe("default local provider", () => {
  // The route checks the provider (and model) exist before the domain keeps it.
  it("accepts an existing provider and model, refuses unknown ones", async () => {
    const r = createLocalProvider({ name: "Lab", baseUrl: "http://lab:30000", models: ["my-model"] });
    if (!r.ok) throw new Error(r.error);
    await app.request("/domains", json({ name: "Herd" }));
    const ok = await app.request("/domains/herd", patch({ localDefault: { provider: "lab", model: "my-model" } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).localDefault).toEqual({ provider: "lab", model: "my-model" });
    const bad = await app.request("/domains/herd", patch({ localDefault: { provider: "nope" } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Unknown local provider/);
    const badModel = await app.request("/domains/herd", patch({ localDefault: { provider: "lab", model: "x" } }));
    expect(badModel.status).toBe(400);
    expect((await app.request("/domains/herd", patch({ localDefault: null }))).status).toBe(200);
    expect(getDomain("herd")).not.toHaveProperty("localDefault");
  });
});

describe("domain files", () => {
  beforeEach(async () => {
    await app.request("/domains", json({ name: "Herd" }));
  });

  it("reads and writes CLAUDE.md", async () => {
    const res = await app.request("/domains/herd/file?name=CLAUDE.md");
    expect(await res.json()).toMatchObject({ path: join(domainDir("herd"), "CLAUDE.md"), format: "markdown", readOnly: false });
    const saved = await app.request("/domains/herd/file", put({ name: "CLAUDE.md", content: "# Herd rules" }));
    expect(saved.status).toBe(200);
    expect(readFileSync(join(domainDir("herd"), "CLAUDE.md"), "utf-8")).toBe("# Herd rules");
  });

  // mcp.json must stay parseable with an object of servers, or every spawn
  // would silently lose the domain's servers.
  it("validates mcp.json before writing it", async () => {
    expect((await (await app.request("/domains/herd/file?name=mcp.json")).json()).format).toBe("json");
    expect((await app.request("/domains/herd/file", put({ name: "mcp.json", content: "{" }))).status).toBe(400);
    expect((await app.request("/domains/herd/file", put({ name: "mcp.json", content: "[]" }))).status).toBe(400);
    expect((await app.request("/domains/herd/file", put({ name: "mcp.json", content: '{"mcpServers":[]}' }))).status).toBe(400);
    const ok = await app.request("/domains/herd/file", put({ name: "mcp.json", content: '{"mcpServers":{"a":{"command":"x"}}}' }));
    expect(ok.status).toBe(200);
  });

  it("allows only the domain's own files of known domains", async () => {
    expect((await app.request("/domains/herd/file?name=../../etc/passwd")).status).toBe(400);
    expect((await app.request("/domains/herd/file", put({ name: "memory/MEMORY.md", content: "x" }))).status).toBe(400);
    expect((await app.request("/domains/nope/file?name=CLAUDE.md")).status).toBe(404);
    expect((await app.request("/domains/nope/file", put({ name: "CLAUDE.md", content: "x" }))).status).toBe(404);
    expect((await app.request("/domains/herd/file", put({ name: "CLAUDE.md" }))).status).toBe(400);
    // GLOBAL works even before anything created it.
    expect((await app.request("/domains/global/file?name=CLAUDE.md")).status).toBe(200);
  });
});

// Plugins: the installed ones are listed once (without server env/headers),
// and each domain reports whether it has them on and whether by its own choice.
describe("plugins", () => {
  function installPlugin() {
    const root = join(tmp, "claude", "plugins", "cache", "brain");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "brain", version: "0.1.4", description: "KB" }));
    mkdirSync(join(root, "skills", "brain"), { recursive: true });
    writeFileSync(join(root, "skills", "brain", "SKILL.md"), "x");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ brain: { type: "http", url: "http://127.0.0.1:7420/mcp", headers: { Authorization: "secret" } } }));
    writeFileSync(join(tmp, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "brain@lab": [{ scope: "user", installPath: root }] } }));
    writeFileSync(join(tmp, "claude", "settings.json"), JSON.stringify({ enabledPlugins: { "brain@lab": false } }));
  }

  it("lists installed plugins and each domain's state, and turns one on for a domain only", async () => {
    installPlugin();
    await app.request("/domains", json({ name: "Hercle" }));
    let body = await (await app.request("/domains")).json();
    expect(body.plugins).toEqual([{
      id: "brain@lab", name: "brain", marketplace: "lab", version: "0.1.4", description: "KB",
      skills: ["brain"], mcpServers: [{ name: "brain", type: "http", target: "http://127.0.0.1:7420/mcp" }], enabledByUser: false,
    }]);
    expect(JSON.stringify(body)).not.toContain("secret");
    const hercle = (b: { domains: { slug: string; pluginStates: unknown }[] }) => b.domains.find((d) => d.slug === "hercle")!;
    expect(hercle(body).pluginStates).toEqual({ "brain@lab": { on: false, own: false } });

    const res = await app.request("/domains/hercle", patch({ plugins: { "brain@lab": true } }));
    expect((await res.json()).pluginStates).toEqual({ "brain@lab": { on: true, own: true } });
    body = await (await app.request("/domains")).json();
    expect(body.domains.find((d: { slug: string }) => d.slug === "global").pluginStates).toEqual({ "brain@lab": { on: false, own: false } });
  });
});

// The MCP form of the Domains page: add (URL or command) and remove one server.
describe("domain MCP servers", () => {
  const del = { method: "DELETE" };

  it("adds, lists and removes a server of the domain's mcp.json", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    let res = await app.request("/domains/herd/mcp/brain", put({ url: "http://100.1.2.3:7421/mcp" }));
    expect(res.status).toBe(200);
    // A URL server is probed when added: this one is open.
    expect((await res.json()).mcpServers).toEqual([
      { name: "brain", source: "domain", enabled: true, own: false, type: "http", target: "http://100.1.2.3:7421/mcp", auth: { owner: "herd", state: "open" } },
    ]);
    res = await app.request("/domains/herd/mcp/brain", del);
    expect((await res.json()).mcpServers).toEqual([]);
  });

  it("works on GLOBAL and reports errors with their status", async () => {
    await app.request("/domains");
    expect((await app.request("/domains/global/mcp/g", put({ command: "g" }))).status).toBe(200);
    expect((await app.request("/domains/global/mcp/g", del)).status).toBe(200);
    expect((await app.request("/domains/nope/mcp/a", put({ command: "a" }))).status).toBe(404);
    expect((await app.request("/domains/global/mcp/bad.name", put({ command: "a" }))).status).toBe(400);
    expect((await app.request("/domains/global/mcp/missing", del)).status).toBe(404);
    const bad = await app.request("/domains/global/mcp/a", { method: "PUT", body: "not json" });
    expect(bad.status).toBe(400);
  });
});

// Private servers (mcp-auth/): the page's buttons. Adding a URL probes it;
// a failed probe leaves it unchecked instead of failing the add; the
// actions work on the server's owner (GLOBAL's servers from any domain);
// removing a server or a domain forgets its credentials.
describe("private MCP server access", () => {
  const ISS = "https://as.example";
  const json200 = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  function oauthProvider(registration: boolean) {
    mcpAuthFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url === "https://p.example/mcp") return new Response("{}", { status: 401 });
      if (url === "https://p.example/.well-known/oauth-protected-resource/mcp") return json200({ authorization_servers: [ISS], scopes_supported: ["s"] });
      if (url === `${ISS}/.well-known/oauth-authorization-server`) {
        return json200({ authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, ...(registration ? { registration_endpoint: `${ISS}/reg` } : {}) });
      }
      if (url === `${ISS}/reg`) return json200({ client_id: "dyn" });
      if (url === `${ISS}/token`) return json200({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      return new Response("nf", { status: 404 });
    });
  }
  const authOf = async (res: Response, name: string) => (await res.json()).mcpServers.find((s: { name: string }) => s.name === name)?.auth;

  it("probes on add, then signs in through a pasted address", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    oauthProvider(true);
    let res = await app.request("/domains/herd/mcp/p", put({ url: "https://p.example/mcp" }));
    expect(await authOf(res, "p")).toMatchObject({ owner: "herd", state: "needs-sign-in", issuer: ISS, scopes: ["s"] });
    res = await app.request("/domains/herd/mcp/p/auth/sign-in", json({}));
    const { authUrl, redirectUri } = await res.json();
    expect(redirectUri).toMatch(/\/api\/mcp-auth\/callback$/);
    const state = new URL(authUrl).searchParams.get("state");
    res = await app.request("/domains/herd/mcp/p/auth/finish", json({ url: `${redirectUri}?code=c&state=${state}` }));
    expect(await authOf(res, "p")).toMatchObject({ state: "signed-in", dynamicClient: true });
    res = await app.request("/domains/herd/mcp/p/auth/sign-out", json({}));
    expect(await authOf(res, "p")).toMatchObject({ state: "needs-sign-in" });
    // Removing the server forgets its credentials.
    await app.request("/domains/herd/mcp/p", { method: "DELETE" });
    expect(existsSync(join(h.home, "mcp-auth", "herd.json")) ? readFileSync(join(h.home, "mcp-auth", "herd.json"), "utf-8") : "").not.toContain("\"p\"");
  });

  it("takes a client ID when the provider cannot register one", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    oauthProvider(false);
    let res = await app.request("/domains/herd/mcp/p", put({ url: "https://p.example/mcp" }));
    expect(await authOf(res, "p")).toMatchObject({ state: "needs-client" });
    res = await app.request("/domains/herd/mcp/p/auth/sign-in", json({}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("needs-client");
    res = await app.request("/domains/herd/mcp/p/auth/client", json({ clientId: "cid", clientSecret: "cs" }));
    expect(await authOf(res, "p")).toMatchObject({ state: "needs-sign-in", clientId: "cid", hasClientSecret: true });
  });

  it("sets an API key on GLOBAL's server from a domain, and checks again", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    mcpAuthFetch.mockImplementation(async () => new Response("{}", { status: 403 }));
    await app.request("/domains/global/mcp/k", put({ url: "https://k.example/mcp" }));
    let res = await app.request("/domains/herd/mcp/k/auth/key", json({ header: "X-Key", value: "v" }));
    expect(await authOf(res, "k")).toEqual({ owner: "global", state: "key-set", header: "X-Key" });
    res = await app.request("/domains/herd/mcp/k/auth/check", json({}));
    expect(await authOf(res, "k")).toMatchObject({ state: "key-set" });
  });

  it("keeps the server when the probe fails, and reports errors with their status", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mcpAuthFetch.mockImplementation(async () => { throw new Error("down"); });
    let res = await app.request("/domains/herd/mcp/x", put({ url: "https://x.example/mcp" }));
    expect(res.status).toBe(200);
    expect(await authOf(res, "x")).toEqual({ owner: "herd", state: "unchecked" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect((await app.request("/domains/herd/mcp/x/auth/check", json({}))).status).toBe(502);
    expect((await app.request("/domains/herd/mcp/x/auth/client", json({ clientId: "c" }))).status).toBe(400);
    expect((await app.request("/domains/herd/mcp/x/auth/finish", json({ url: "bad" }))).status).toBe(400);
    expect((await app.request("/domains/herd/mcp/x/auth/sign-out", json({}))).status).toBe(200);
    expect((await app.request("/domains/herd/mcp/x/auth/zap", json({}))).status).toBe(404);
    expect((await app.request("/domains/herd/mcp/none/auth/check", json({}))).status).toBe(404);
    expect((await app.request("/domains/nope/mcp/x/auth/check", json({}))).status).toBe(404);
  });

  it("forgets a deleted domain's credentials", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    mcpAuthFetch.mockImplementation(async () => new Response("{}", { status: 403 }));
    await app.request("/domains/herd/mcp/k", put({ url: "https://k.example/mcp" }));
    expect(existsSync(join(h.home, "mcp-auth", "herd.json"))).toBe(true);
    await app.request("/domains/herd", { method: "DELETE" });
    expect(existsSync(join(h.home, "mcp-auth", "herd.json"))).toBe(false);
  });
});

// The account's MCP servers come from a cache: GET never waits for the CLI,
// a stale cache is refreshed in the background, and the page can force a read.
describe("account MCP servers", () => {
  const writeCache = (at: number, extra: Record<string, unknown> = {}) => {
    mkdirSync(h.home, { recursive: true });
    writeFileSync(join(h.home, "account-mcp-servers.json"), JSON.stringify({
      at,
      servers: [{ name: "claude.ai Gmail", target: "https://gmail/mcp", health: "connected", connector: true }],
      ...extra,
    }));
  };

  it("refreshes a stale list in the background and says so", async () => {
    const body = await (await app.request("/domains")).json();
    expect(body.accountMcp).toEqual({ at: 0, stale: true });
    expect(refreshAccountMcp).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh list from the cache, listed in every domain, without running the CLI", async () => {
    writeCache(Date.now(), { error: "last read failed" });
    await app.request("/domains", json({ name: "Herd" }));
    const body = await (await app.request("/domains")).json();
    expect(body.accountMcp).toMatchObject({ stale: false, error: "last read failed" });
    expect(refreshAccountMcp).not.toHaveBeenCalled();
    const herd = body.domains.find((d: { slug: string }) => d.slug === "herd");
    expect(herd.mcpServers).toContainEqual(expect.objectContaining({ name: "claude.ai Gmail", source: "account", enabled: true }));
  });

  it("forces a read on request", async () => {
    refreshAccountMcp.mockResolvedValueOnce({ servers: [{ name: "github", target: "npx gh", health: "connected", connector: false }], at: 5, error: "partial" });
    const res = await app.request("/account-mcp-servers/refresh", { method: "POST" });
    expect(await res.json()).toEqual({ at: 5, servers: 1, error: "partial" });
    refreshAccountMcp.mockResolvedValueOnce({ servers: [], at: 6 });
    expect(await (await app.request("/account-mcp-servers/refresh", { method: "POST" })).json()).toEqual({ at: 6, servers: 0 });
  });
});

// Skills of the domain's own from the Domains page: create and remove (moved aside).
describe("domain skills", () => {
  it("creates a skill, lists it with its description, and removes it", async () => {
    await app.request("/domains", json({ name: "Herd" }));
    const res = await app.request("/domains/herd/skills", json({ name: "deploy-check", description: "Check a deploy" }));
    expect(res.status).toBe(201);
    expect((await res.json()).ownSkills).toEqual([{ name: "deploy-check", description: "Check a deploy" }]);
    expect((await app.request("/domains/herd/skills", json({ name: "deploy-check", description: "x" }))).status).toBe(409);
    expect((await app.request("/domains/herd/skills", json({ name: "Bad", description: "x" }))).status).toBe(400);
    const del = await app.request("/domains/herd/skills/deploy-check", { method: "DELETE" });
    expect((await del.json()).ownSkills).toEqual([]);
    expect((await app.request("/domains/herd/skills/deploy-check", { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/domains/global/skills", { method: "POST", body: "bad" })).status).toBe(400);
  });
});
