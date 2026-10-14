// The brain's HTTP surface end to end, through its web-standard fetch handler
// (the same one Bun.serve runs in the bundle): a STOCK MCP SDK client with no
// Companion extension, the `brn_` session tokens, the Host check, /healthz,
// the public skill with ETag, and the curator API behind X-Brain-Key
// (consolidation run, dismiss, skill-context, refresh, lint). The wiki is
// never written by any of it.

import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Audit, type AuditEvent } from "./audit.js";
import { Brain } from "./brain.js";
import { allowedHostNames, createFetchHandler, hostName } from "./http.js";
import { POLICIES } from "./tools.js";
import { mintToken, verifyToken, bearerOf } from "./token.js";
import { brainRules } from "./instructions.js";
import { FIXTURE_SECRETS, makeWiki, tmp } from "./__tests__/fixture.js";

const TOKEN_KEY = "k".repeat(40);
const CURATOR_KEY = "c".repeat(40);
const wikiDir = makeWiki(true);
const dataRoot = tmp();
const events: AuditEvent[] = [];
const brains: Brain[] = [];
afterAll(() => {
  for (const b of brains) b.inbox.close();
  rmSync(wikiDir, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

function start(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    BRAIN_WIKI_DIR: wikiDir,
    BRAIN_DATA_DIR: join(dataRoot, String(Math.random()).slice(2)),
    BRAIN_NAME: "team-brain",
    BRAIN_TITLE: "Team brain",
    BRAIN_OWNER: "Northwind",
    BRAIN_ABOUT: "Northwind engineering: billing, deploys, the office network.",
    ...env,
  });
  const brain = new Brain(cfg, new Audit((e) => events.push(e), undefined, cfg.name));
  brains.push(brain);
  const handler = createFetchHandler(brain);
  const base = "http://127.0.0.1:7421";
  const fetchLike = (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init));
  return { brain, handler, base, fetch: fetchLike };
}

const open = start();
const locked = start({ BRAIN_TOKEN_KEY: TOKEN_KEY, BRAIN_CURATOR_KEY: CURATOR_KEY });

async function connect(s: ReturnType<typeof start>, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "stock-client", version: "1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers }, fetch: s.fetch }));
  return client;
}

function textOf(r: unknown): string {
  return ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");
}

describe("MCP with a stock client (no tokens configured)", () => {
  it("initializes with generated instructions and lists exactly the policy tools", async () => {
    const c = await connect(open);
    const ins = c.getInstructions() ?? "";
    expect(ins).toMatch(/\*\*Team brain\*\*, the knowledge base of Northwind/);
    expect(ins).toMatch(/brain_inbox_add/);
    expect(ins).toMatch(/## Start Here/);
    expect(ins).toMatch(/Latest changes/);
    expect(c.getServerVersion()?.name).toBe("team-brain");
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(POLICIES).sort());
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name).sort();
    expect(writers).toEqual(["brain_inbox_add", "brain_inbox_withdraw"]);
    await c.close();
  });

  it("searches, reads pages, sources and lists, with redaction on", async () => {
    const c = await connect(open);
    const s = JSON.parse(textOf(await c.callTool({ name: "brain_search", arguments: { query: "router office network" } })));
    expect(s.results[0].slug).toBe("office-network");
    const p = textOf(await c.callTool({ name: "brain_read_page", arguments: { slug: "[[office-network]]" } }));
    expect(p).toMatch(/<brain_page path="entities\/office-network.md" trust="data">/);
    expect(p).toMatch(/\[REDACTED:assigned-secret\]/);
    expect(p).not.toContain(FIXTURE_SECRETS.assigned);
    expect(textOf(await c.callTool({ name: "brain_read_page", arguments: { slug: "handbook/index" } }))).toMatch(/"subwiki": "handbook"/);
    expect(textOf(await c.callTool({ name: "brain_read_page", arguments: { slug: "schema" } }))).toMatch(/Tag Taxonomy/);
    expect(textOf(await c.callTool({ name: "brain_read_page", arguments: { slug: "readme" } }))).toMatch(/not present/);
    const missing = await c.callTool({ name: "brain_read_page", arguments: { slug: "billing-svc" } });
    expect(missing.isError).toBe(true);
    const src = textOf(await c.callTool({ name: "brain_read_source", arguments: { path: "raw/articles/billing-design-notes.md", max_lines: 3 } }));
    expect(src).toMatch(/lines: 1-3 of \d+ \(continue with from_line=4\)/);
    expect(src).toMatch(/<brain_source /);
    expect(textOf(await c.callTool({ name: "brain_read_source", arguments: { path: "raw/assets/pixel.png" } }))).toMatch(/binary or too large/);
    expect((await c.callTool({ name: "brain_read_source", arguments: { path: "../../etc/passwd" } })).isError).toBe(true);
    const list = JSON.parse(textOf(await c.callTool({ name: "brain_list", arguments: { dir: "handbook" } })));
    expect(list.count).toBe(3);
    expect(JSON.parse(textOf(await c.callTool({ name: "brain_list", arguments: { type: "entity", tag: "billing" } }))).count).toBe(1);
    expect(textOf(await c.callTool({ name: "brain_orient", arguments: {} }))).toMatch(/Pages to start from/);
    await c.close();
    expect(events.some((e) => e.tool === "brain_read_page" && e.rules?.includes("assigned-secret"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(FIXTURE_SECRETS.assigned);
  });

  it("records notes as the owner, rejects secrets and extra fields, withdraws", async () => {
    const c = await connect(open, { "X-Client-Session-Id": "e7cc3de9-0fda-4690-8ba0-bad42ead872e" });
    const r = await c.callTool({ name: "brain_inbox_add", arguments: { kind: "new_fact", statement: "The brain records notes with provenance in tests.", pages: ["billing-service"], sources: ["person:self"], cwd_repo: "acme" } });
    expect(r.isError, textOf(r)).not.toBe(true);
    const id = JSON.parse(textOf(r)).note_id;
    const rejected = await c.callTool({ name: "brain_inbox_add", arguments: { kind: "new_fact", statement: "The router password: Sup3rSecretValue42 is needed for SSH.", pages: ["office-network"], sources: ["person:self"] } });
    expect(rejected.isError).toBe(true);
    const strict = await c.callTool({ name: "brain_inbox_add", arguments: { kind: "new_fact", statement: "An extra field is not accepted.", pages: ["billing-service"], sources: ["person:self"], author: "someone else" } });
    expect(strict.isError).toBe(true);
    const mine = JSON.parse(textOf(await c.callTool({ name: "brain_inbox_mine", arguments: {} })));
    expect(mine.notes[0].note_id).toBe(id);
    const stored = open.brain.inbox.get(id)!;
    expect(stored.author_id).toBe("user:Northwind");
    expect(stored.client_session_header).toBe("e7cc3de9-0fda-4690-8ba0-bad42ead872e");
    expect(JSON.parse(textOf(await c.callTool({ name: "brain_inbox_withdraw", arguments: { note_id: id, reason: "test" } }))).status).toBe("withdrawn");
    expect((await c.callTool({ name: "brain_inbox_withdraw", arguments: { note_id: id } })).isError).toBe(true);
    await c.close();
    expect(JSON.stringify(events)).not.toContain("Sup3rSecretValue42");
  });

  it("answers 405 to GET and DELETE on /mcp (stateless) and 404 elsewhere", async () => {
    expect((await open.fetch(`${open.base}/mcp`)).status).toBe(405);
    expect((await open.fetch(`${open.base}/mcp`, { method: "DELETE" })).status).toBe(405);
    expect((await open.fetch(`${open.base}/nope`)).status).toBe(404);
  });
});

describe("MCP with brn_ tokens", () => {
  it("refuses a missing, forged or foreign token", async () => {
    const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) };
    expect((await locked.fetch(`${locked.base}/mcp`, init)).status).toBe(401);
    const other = mintToken("x".repeat(40), { domain: "GLOBAL", sessionId: "s1" });
    expect((await locked.fetch(`${locked.base}/mcp`, { ...init, headers: { ...init.headers, authorization: `Bearer ${other}` } })).status).toBe(401);
    await expect(connect(locked)).rejects.toThrow();
  });

  it("a stock client with a token: identity is the session, per session", async () => {
    const token = mintToken(TOKEN_KEY, { domain: "work", sessionId: "sess-1" });
    const c = await connect(locked, { Authorization: `Bearer ${token}` });
    const r = await c.callTool({ name: "brain_inbox_add", arguments: { kind: "question", statement: "Who owns the backup server after the move?", pages: ["procedura-backup"], sources: ["person:self"] } });
    expect(r.isError, textOf(r)).not.toBe(true);
    const id = JSON.parse(textOf(r)).note_id;
    const n = locked.brain.inbox.get(id)!;
    expect(n.author_id).toBe("session:work/sess-1");
    expect(n.author).toBe("Northwind (work)");
    expect(n.mcp_session_id).toBe("sess-1");
    // Another session does not see it as its own.
    const c2 = await connect(locked, { Authorization: `Bearer ${mintToken(TOKEN_KEY, { domain: "work", sessionId: "sess-2" })}` });
    expect(JSON.parse(textOf(await c2.callTool({ name: "brain_inbox_mine", arguments: {} }))).count).toBe(0);
    await c.close();
    await c2.close();
  });

  it("token helpers: shape, tampering, bearer parsing", () => {
    const t = mintToken(TOKEN_KEY, { domain: "d|x", sessionId: "s" });
    expect(t.startsWith("brn_")).toBe(true);
    expect(verifyToken(TOKEN_KEY, t)).toEqual({ domain: "d", sessionId: "x|s" });
    expect(verifyToken(TOKEN_KEY, `${t}x`)).toBeNull();
    expect(verifyToken(TOKEN_KEY, "brn_nodot")).toBeNull();
    expect(verifyToken(TOKEN_KEY, "cmcp_x.y")).toBeNull();
    expect(verifyToken(TOKEN_KEY, undefined)).toBeNull();
    const payload = Buffer.from("nobar").toString("base64url");
    const forged = mintToken(TOKEN_KEY, { domain: "a", sessionId: "b" }).replace(/^brn_[^.]+/, `brn_${payload}`);
    expect(verifyToken(TOKEN_KEY, forged)).toBeNull();
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });
});

describe("HTTP endpoints", () => {
  it("checks the Host header against the bind address", async () => {
    expect(hostName("127.0.0.1:7421")).toBe("127.0.0.1");
    expect(hostName("[::1]:7421")).toBe("::1");
    expect(hostName("Example.COM")).toBe("example.com");
    expect([...allowedHostNames("100.100.1.2", ["brain-host"])]).toEqual(["100.100.1.2", "brain-host"]);
    expect((await open.fetch(`${open.base}/healthz`, { headers: { host: "evil.example.com" } })).status).toBe(403);
    expect((await open.fetch(`${open.base}/healthz`, { headers: { host: "localhost:9" } })).status).toBe(200);
  });

  it("healthz reports the wiki, the auth mode and the inbox", async () => {
    const h = await (await locked.fetch(`${locked.base}/healthz`)).json();
    expect(h).toMatchObject({ status: "ok", name: "team-brain", protocol: 1, redact_secrets: true, auth: { mcp: true, api: true } });
    expect(h.content_hash).toBe(locked.brain.wiki().contentHash);
  });

  it("publishes the skill without authentication, with ETag and 304", async () => {
    const res = await locked.fetch(`${locked.base}/skill`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.skill_api).toBe(1);
    expect(doc.name).toBe("team-brain");
    expect(doc.tools.sort()).toEqual(Object.keys(POLICIES).sort());
    const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(doc.skill_md)![1]);
    expect(fm).toEqual({ name: "team-brain", description: doc.description });
    expect(doc.description).toMatch(/^Use Team brain, the knowledge base of Northwind/);
    expect(doc.description).toMatch(/Wiki sections: Start Here; Systems; Analyses\.$/);
    for (const r of brainRules(true)) expect(doc.skill_md).toContain(r);
    expect(doc.skill_md).not.toMatch(/jarvis/i);
    const etag = res.headers.get("etag")!;
    expect((await locked.fetch(`${locked.base}/skill`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await locked.fetch(`${locked.base}/skill.md`, { headers: { "if-none-match": "W/x, *" } })).status).toBe(304);
    const md = await locked.fetch(`${locked.base}/skill.md`);
    expect(md.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await md.text()).toBe(doc.skill_md);
  });
});

describe("curator API", () => {
  const key = { "x-brain-key": CURATOR_KEY, "content-type": "application/json" };
  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = key): Promise<{ status: number; json: any }> {
    const r = await locked.fetch(`${locked.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  }

  it("requires X-Brain-Key", async () => {
    expect((await api("GET", "/inbox/notes", undefined, {})).status).toBe(401);
    expect((await api("GET", "/inbox/notes", undefined, { "x-brain-key": "wrong" })).status).toBe(401);
    expect((await api("GET", "/inbox/notes")).status).toBe(200);
    // Without a configured key the API is open (a single-user server on loopback).
    expect((await open.fetch(`${open.base}/api/v1/wiki/schema`)).status).toBe(200);
  });

  it("runs a consolidation end to end and never writes the wiki", async () => {
    const before = readFileSync(join(wikiDir, "entities", "billing-service.md"), "utf8");
    const w = locked.brain.wiki();
    const att = { authorId: "session:work/s9", author: "t", roles: ["user"], mcpSessionId: "s9", clientName: "t", clientVersion: "0", wikiCommit: w.commit, wikiHash: w.contentHash };
    const add = (n: Record<string, unknown>) => {
      const r = locked.brain.inbox.add(n as never, att, w);
      if (!r.ok) throw new Error(r.errors.join("; "));
      return r.note_id;
    };
    const fact = add({ kind: "correction", statement: "The billing service listens on port 8010 since 2026-10-12.", pages: ["billing-service"], sources: ["host:billing:/etc/billing.env"] });
    const fact2 = add({ kind: "new_fact", statement: "The billing service now logs to the central pipeline.", pages: ["billing-service"], sources: ["person:self"] });
    const personal = add({ kind: "new_fact", statement: "Saturday I am going sailing with the family.", pages: ["office-network"], sources: ["person:self"] });
    const newp = add({ kind: "new_fact", statement: "A video encoding workflow runs on the render box.", new_page_hint: "video-workflow", sources: ["person:self"] });
    const dismissMe = add({ kind: "question", statement: "Is this note worth keeping at all?", pages: ["deploy-pipeline"], sources: ["person:self"] });

    expect((await api("POST", `/inbox/notes/${dismissMe}/dismiss`, { reason: "noise" })).json.status).toBe("discarded");
    expect((await api("POST", `/inbox/notes/${dismissMe}/dismiss`, {})).status).toBe(409);
    expect((await api("POST", "/inbox/notes/NOPE/dismiss", {})).status).toBe(404);
    expect((await api("GET", `/inbox/notes/${dismissMe}`)).json.statement).toBe("");
    expect((await api("GET", "/inbox/notes/NOPE")).status).toBe(404);

    const run = await api("POST", "/consolidation/runs", { run_id: "2026-10-13-test" });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    const billing = run.json.items.find((i: any) => i.target === "billing-service");
    expect(billing.notes).toHaveLength(2);
    expect(billing.target_path).toBe("entities/billing-service.md");
    expect(run.json.items.find((i: any) => i.target === "video-workflow").is_new_page).toBe(true);
    expect((await api("POST", "/consolidation/runs", { run_id: "other-run" })).status).toBe(409);
    expect((await api("GET", "/consolidation/runs/2026-10-13-test")).json.counts.undecided).toBeGreaterThanOrEqual(4);

    const page = await api("GET", "/wiki/pages/billing-service");
    const draft = page.json.markdown.replace("port 8000", "port 8010");
    expect((await api("POST", "/lint/page", { path: page.json.path, markdown: draft })).json.ok).toBe(true);
    const bad = await api("POST", "/lint/page", { path: "concepts/video-workflow.md", markdown: "---\ntitle: Video\ntype: concept\ntags: [video]\n---\n# Video\n" });
    expect(bad.json).toMatchObject({ ok: false, is_new_page: true });
    expect((await api("POST", "/lint/page", { path: "../etc/x.md", markdown: "x" })).status).toBe(400);

    const d = (note: string, decision: string, reason: string) => api("POST", `/consolidation/runs/2026-10-13-test/notes/${note}/decision`, { decision, reason, by: "nightly-test" });
    expect((await d(fact, "accepted", "")).status).toBe(400);
    expect((await d(fact, "approved", "x")).status).toBe(400);
    expect((await d(fact, "accepted", "entities/billing-service.md updated")).status).toBe(200);
    expect((await d(personal, "discarded", "personal")).status).toBe(200);
    expect((await d(newp, "deferred", "needs a person")).status).toBe(200);
    expect((await d(fact, "rejected", "second thoughts")).status).toBe(409);
    expect((await d("NOPE", "accepted", "x")).status).toBe(404);
    expect((await api("GET", "/consolidation/runs/2026-10-13-test/notes?decision=none")).json.notes.map((n: any) => n.note_id)).toContain(fact2);

    const fin = await api("POST", "/consolidation/runs/2026-10-13-test/finalize", { summary: "one correction applied" });
    expect(fin.status).toBe(200);
    expect(fin.json.released).toContain(fact2);
    expect(fin.json.log_entry).toMatch(/^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] consolidate\n- Pages touched: entities\/billing-service.md/);
    expect(locked.brain.inbox.get(fact2)!.status).toBe("pending");

    const r2 = await api("POST", "/consolidation/runs", {});
    expect(r2.json.run_id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await api("POST", `/consolidation/runs/${r2.json.run_id}/abandon`, {})).status).toBe(400);
    expect((await api("POST", `/consolidation/runs/${r2.json.run_id}/abandon`, { reason: "test" })).status).toBe(200);
    expect((await api("GET", "/consolidation/runs")).json.runs).toHaveLength(2);
    expect((await api("GET", "/consolidation/runs/nope")).status).toBe(404);
    expect(readFileSync(join(wikiDir, "entities", "billing-service.md"), "utf8")).toBe(before);
  });

  it("serves the wiki reads, skill-context, lint, and refresh", async () => {
    const s = await api("GET", "/wiki/schema");
    expect(s.json.taxonomy).toContain("billing");
    expect(s.json.wiki_commit).toMatch(/^[0-9a-f]{12}$/);
    expect((await api("GET", "/wiki/pages/office-network")).json.markdown).toContain(FIXTURE_SECRETS.assigned); // not redacted: callers edit the wiki
    expect((await api("GET", `/wiki/pages/${encodeURIComponent("handbook/index")}`)).json.path).toBe("handbook/index.md");
    expect((await api("GET", "/wiki/pages/no-such-page")).status).toBe(404);
    expect((await api("GET", "/wiki/sources?path=raw/notes/components.md&max=2")).json).toMatchObject({ to: 2, path: "raw/notes/components.md" });
    expect((await api("GET", "/wiki/sources")).status).toBe(400);
    expect((await api("GET", "/wiki/pages")).json.pages).toHaveLength(9);
    expect((await api("GET", "/inbox/notes?status=nope")).status).toBe(400);
    expect((await api("GET", "/lint")).json.errors).toBe(0);
    const ctx = (await api("GET", "/wiki/skill-context")).json;
    expect(ctx).toMatchObject({ skill_api: 1, name: "team-brain", title: "Team brain", owner: "Northwind", pages: 9 });
    expect(ctx.sections.map((x: any) => x.heading)).toEqual(["Start Here", "Systems", "Analyses"]);
    expect(ctx.tools.map((t: any) => t.name)).toContain("brain_search");
    expect((await api("GET", "/consolidation/runs/x/finalize")).status).toBe(405);
    expect((await api("GET", "/nothing")).status).toBe(404);
    const bodyless = await locked.fetch(`${locked.base}/api/v1/consolidation/runs`, { method: "POST", headers: key, body: "not json" });
    expect(bodyless.status).toBe(400);

    expect((await api("POST", "/admin/refresh")).json.changed).toBe(false);
    appendFileSync(join(wikiDir, "concepts", "deploy-pipeline.md"), "\nThe zigbee coordinator moved to the attic.\n");
    const refreshed = (await api("POST", "/admin/refresh")).json;
    expect(refreshed.changed).toBe(true);
    expect(refreshed.content_hash).toBe(locked.brain.wiki().contentHash);
    expect(locked.brain.index().search("zigbee attic", { limit: 1, includeRaw: false })[0].ref).toBe("deploy-pipeline");
  });
});
