import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { registerDomainRoutes } from "./domain-routes.js";
import { domainDir, getDomain } from "../domain-store.js";

let tmp: string;
let sessions: { domain?: string; archived?: boolean }[];
let app: Hono;
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
  registerDomainRoutes(app, { listSessions: () => sessions });
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
    expect(body).toMatchObject({ chrome: true, mcpDisabled: ["gh"] });
    expect(body.skillGroupStates).toEqual({
      user: { on: false, own: true },
      "claude-ai": { on: true, own: false },
      design: { on: false, own: false }, // inherited from GLOBAL
    });
    expect((await app.request("/domains/herd", patch({ chrome: "yes" }))).status).toBe(400);
    expect((await app.request("/domains/nope", patch({}))).status).toBe(404);
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
