// The brain's content API added for Companion's Pages and Inbox tabs and
// "Add source", the "fact" alias of brain_inbox_add, and the skill
// description built from index.md and the taxonomy:
//  - pages are listed, searched and read (navigation files too), with
//    secrets redacted only when the caller asks for what sessions see;
//  - a text source becomes a new raw/sources/ file (never overwritten,
//    path-safe) plus a source_pointer note; an URL becomes only a note; a
//    rejected note leaves no file behind;
//  - real agents called brain_inbox_add with kind "fact": it is stored as new_fact;
//  - the skill description lists index.md sections, page titles and tags,
//    each cut to 60 characters, and falls back to the about text when the
//    wiki is empty (a wiki fresh from Companion's template).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Audit } from "./audit.js";
import { Brain } from "./brain.js";
import { createFetchHandler } from "./http.js";
import { canonicalKind, validateNote } from "./inbox.js";
import { buildSkill, defaultSkillDescription, topicsText, wikiTopics } from "./skill.js";
import { loadWiki } from "./wiki.js";
import { MAX_SOURCE_BYTES, hintFromUrl, safeSourceName, writeSourceFile } from "./sources.js";
import { FIXTURE_SECRETS, makeWiki, tmp } from "./__tests__/fixture.js";

const dirs: string[] = [];
const brains: Brain[] = [];
afterAll(() => {
  for (const b of brains) b.inbox.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function start(wikiDir = makeWiki(), env: Record<string, string> = {}) {
  const dataDir = tmp();
  dirs.push(wikiDir, dataDir);
  const cfg = loadConfig({ BRAIN_WIKI_DIR: wikiDir, BRAIN_DATA_DIR: dataDir, BRAIN_NAME: "team-brain", BRAIN_TITLE: "Team brain", BRAIN_OWNER: "Northwind", BRAIN_ABOUT: "Northwind engineering.", ...env });
  const brain = new Brain(cfg, new Audit(() => undefined, undefined, cfg.name));
  brains.push(brain);
  const handler = createFetchHandler(brain);
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await handler(new Request(`http://127.0.0.1:7421/api/v1${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: r.status, json: (await r.json()) as any };
  };
  return { brain, handler, api, wikiDir };
}

describe("pages for the Pages tab", () => {
  const s = start();

  it("lists every page in path order, and searches with ?q=", async () => {
    const all = await s.api("GET", "/wiki/pages");
    const paths = all.json.pages.map((p: any) => p.path);
    expect(paths).toEqual([...paths].sort((a: string, b: string) => a.localeCompare(b)));
    expect(all.json.pages.find((p: any) => p.slug === "billing-service")).toMatchObject({ title: "Billing Service", type: "entity", tags: ["billing", "queue"] });
    const hits = await s.api("GET", "/wiki/pages?q=invoices");
    expect(hits.json.query).toBe("invoices");
    expect(hits.json.pages[0].slug).toBe("billing-service");
    expect(typeof hits.json.pages[0].snippet).toBe("string");
    expect((await s.api("GET", "/wiki/pages?q=zzzz-nothing")).json.pages).toEqual([]);
  });

  it("reads a page with its metadata, and the navigation files by name", async () => {
    const p = await s.api("GET", "/wiki/pages/billing-service");
    expect(p.json).toMatchObject({ slug: "billing-service", path: "entities/billing-service.md", title: "Billing Service", type: "entity", sources: ["raw/articles/billing-design-notes.md"] });
    expect(p.json.markdown).toMatch(/^---\n/);
    const index = await s.api("GET", "/wiki/pages/index");
    expect(index.json).toMatchObject({ path: "index.md", type: "navigation" });
    expect(index.json.markdown).toMatch(/## Start Here/);
    expect((await s.api("GET", "/wiki/pages/SCHEMA.md")).json.path).toBe("SCHEMA.md");
    expect((await s.api("GET", "/wiki/pages/no-such-page")).status).toBe(404);
  });

  it("redacts secrets only with ?redact=1 (what sessions see), never by default", async () => {
    const raw = await s.api("GET", "/wiki/pages/office-network");
    expect(raw.json.markdown).toContain(FIXTURE_SECRETS.assigned);
    const red = await s.api("GET", "/wiki/pages/office-network?redact=1");
    expect(red.json.markdown).not.toContain(FIXTURE_SECRETS.assigned);
    expect(red.json.markdown).toMatch(/\[REDACTED:/);
    // A brain configured not to redact shows the text as it is.
    const plain = start(undefined, { BRAIN_REDACT_SECRETS: "false" });
    expect((await plain.api("GET", "/wiki/pages/office-network?redact=1")).json.markdown).toContain(FIXTURE_SECRETS.assigned);
  });
});

describe("Add source", () => {
  it("writes raw/sources/<date>-<name>.md, records a source_pointer note, never overwrites", async () => {
    const s = start();
    const r = await s.api("POST", "/sources", { name: "Q3 Report (final).md", text: "# Q3\r\n\nRevenue grew.", note: "From the board meeting" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.path).toMatch(/^raw\/sources\/\d{4}-\d{2}-\d{2}-q3-report-final\.md$/);
    expect(readFileSync(join(s.wikiDir, r.json.path), "utf8")).toBe("# Q3\n\nRevenue grew.\n");
    const note = s.brain.inbox.get(r.json.note_id)!;
    expect(note).toMatchObject({ kind: "source_pointer", sources: [`raw:${r.json.path}`], new_page_hint: "q3-report-final", author: "Companion" });
    expect(note.statement).toContain("From the board meeting");
    // The brain sees the new source at once (the note's raw: source had to resolve).
    expect(s.brain.wiki().raw.has(r.json.path)).toBe(true);
    const again = await s.api("POST", "/sources", { name: "Q3 Report (final).md", text: "Another text." });
    expect(again.json.path).toBe(r.json.path.replace(/\.md$/, "-2.md"));
    expect(readFileSync(join(s.wikiDir, r.json.path), "utf8")).toBe("# Q3\n\nRevenue grew.\n");
  });

  it("points the note at an existing page when the name is one", async () => {
    const s = start();
    const r = await s.api("POST", "/sources", { name: "billing-service", text: "New design notes for billing." });
    expect(s.brain.inbox.get(r.json.note_id)).toMatchObject({ pages: ["billing-service"] });
  });

  it("refuses what is not a text source, too large, or unnamed", async () => {
    const s = start();
    expect((await s.api("POST", "/sources", { name: "x", text: "a\u0000b" })).status).toBe(400);
    expect((await s.api("POST", "/sources", { name: "x", text: "a".repeat(MAX_SOURCE_BYTES + 1) })).status).toBe(413);
    expect((await s.api("POST", "/sources", { text: "hello" })).status).toBe(400);
    expect((await s.api("POST", "/sources", { name: "x", text: "   " })).status).toBe(400);
    expect((await s.api("POST", "/sources", { name: "x", text: "ok", note: 5 })).status).toBe(400);
    expect(existsSync(join(s.wikiDir, "raw", "sources"))).toBe(false);
  });

  it("removes the file again when the note is rejected (personal data in the note)", async () => {
    const s = start();
    const r = await s.api("POST", "/sources", { name: "minutes", text: "Minutes.", note: "Ask mario.rossi@gmail.com for the slides" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/note was rejected/);
    expect(readdirSync(join(s.wikiDir, "raw", "sources"))).toEqual([]);
    expect(s.brain.wiki().raw.size).toBe(3);
  });

  it("records an URL as a note only: nothing is downloaded or written", async () => {
    const s = start();
    const r = await s.api("POST", "/sources", { url: "https://example.org/docs/Deploy-Guide.html", note: "Official guide" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.path).toBeUndefined();
    expect(s.brain.inbox.get(r.json.note_id)).toMatchObject({ kind: "source_pointer", sources: ["url:https://example.org/docs/Deploy-Guide.html"], new_page_hint: "deploy-guide" });
    expect(existsSync(join(s.wikiDir, "raw", "sources"))).toBe(false);
    const titled = await s.api("POST", "/sources", { url: "https://example.org/", title: "Example Docs" });
    expect(s.brain.inbox.get(titled.json.note_id)?.new_page_hint).toBe("example-docs");
    expect((await s.api("POST", "/sources", { url: "ftp://example.org/x" })).status).toBe(400);
  });

  it("makes safe names: no path can be smuggled in", () => {
    expect(safeSourceName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeSourceName("Città più bella.txt")).toBe("citta-piu-bella");
    expect(safeSourceName("***")).toBe("");
    expect(hintFromUrl("https://example.org/a/b%20c.pdf")).toBe("b-c");
    expect(hintFromUrl("not a url")).toBe("");
    const wiki = makeWiki();
    dirs.push(wiki);
    expect(writeSourceFile(wiki, "***", "x", new Date("2026-10-14T10:00:00Z"))).toBe("raw/sources/2026-10-14-source.md");
  });

  it("refuses a raw/sources folder that leads outside the wiki (a symlink)", () => {
    const wiki = makeWiki();
    const outside = tmp();
    dirs.push(wiki, outside);
    mkdirSync(join(wiki, "raw"), { recursive: true });
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(outside, join(wiki, "raw", "sources"));
    expect(() => writeSourceFile(wiki, "x", "y", new Date())).toThrow(/outside the wiki/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("kind alias of brain_inbox_add", () => {
  it("maps fact to new_fact in validation", () => {
    const wiki = makeWiki();
    dirs.push(wiki);
    const w = loadWiki(wiki);
    expect(canonicalKind("fact")).toBe("new_fact");
    expect(canonicalKind("question")).toBe("question");
    const v = validateNote({ kind: "fact" as never, statement: "The billing service moved to port 8010.", pages: ["billing-service"], sources: ["person:self"] }, w);
    expect(v.ok).toBe(true);
    expect(v.normalized?.kind).toBe("new_fact");
    expect(validateNote({ kind: "rumour" as never, statement: "The billing service moved to port 8010.", pages: ["billing-service"], sources: ["person:self"] }, w).errors[0]).toMatch(/kind must be one of/);
  });

  it("accepts kind \"fact\" from a stock MCP client and stores it as new_fact", async () => {
    const s = start();
    const client = new Client({ name: "stock-client", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:7421/mcp"), { fetch: (u, i) => s.handler(new Request(u, i)) }));
    const tool = (await client.listTools()).tools.find((t) => t.name === "brain_inbox_add")!;
    expect(JSON.stringify(tool.inputSchema)).toContain("\"fact\"");
    const r = await client.callTool({ name: "brain_inbox_add", arguments: { kind: "fact", statement: "The deploy pipeline now runs on two runners.", pages: ["deploy-pipeline"], sources: ["person:self"] } });
    expect(r.isError).not.toBe(true);
    const id = JSON.parse((r.content as { text: string }[])[0].text).note_id;
    expect(s.brain.inbox.get(id)?.kind).toBe("new_fact");
    expect((await client.callTool({ name: "brain_inbox_add", arguments: { kind: "rumour", statement: "Something else happened today.", pages: ["deploy-pipeline"], sources: ["person:self"] } })).isError).toBe(true);
    await client.close();
  });
});

describe("skill description from index.md titles and tags", () => {
  const persona = { title: "Team brain", owner: "Marco Monaco", about: "Northwind engineering: billing, deploys, the office network." };

  it("lists sections with their page titles, then the tags, within 1000 characters", () => {
    const wiki = makeWiki();
    dirs.push(wiki);
    const doc = buildSkill(loadWiki(wiki), { name: "team-brain", persona, topics: "index", redactSecrets: true, version: "t" });
    expect(doc.description).toMatch(/^Use Team brain, the knowledge base of Marco Monaco, whenever the work touches its topics: Northwind engineering: billing, deploys, the office network\. Read it/);
    expect(doc.description).toMatch(/Wiki sections: Start Here \(Deploy Pipeline, Billing Service\); Systems \(Office Network, Procedura di backup\); Analyses \([^)]*\)\./);
    expect(doc.description).toMatch(/Tags: billing, deploy, network, backup, queue, comparison, capacity, procedure\.$/);
    expect(doc.description.length).toBeLessThanOrEqual(1000);
  });

  it("cuts every wiki item to 60 characters and keeps the whole under the limit", () => {
    const wiki = makeWiki();
    dirs.push(wiki);
    const long = "A".repeat(120);
    writeFileSync(join(wiki, "index.md"), `# Index\n\n## ${long}\n- [[billing-service]]\n`);
    writeFileSync(join(wiki, "SCHEMA.md"), `# S\n\n## Tag Taxonomy\n- ${"b".repeat(90)}, ok\n`);
    const w = loadWiki(wiki);
    const t = wikiTopics(w);
    expect(t.sections[0].heading.length).toBe(60);
    expect(t.tags.every((x) => x.length <= 60)).toBe(true);
    const huge = { ...persona, about: "word ".repeat(400) };
    const d = defaultSkillDescription(huge, t);
    expect(d.length).toBeLessThanOrEqual(1000);
    expect(d).toMatch(/Wiki sections: A{59}…/);
    // A section whose titles do not fit is named alone; items that do not fit are left out.
    expect(topicsText({ sections: [{ heading: "Big", titles: ["x".repeat(50)] }], tags: ["t1", "t2"] }, 30)).toBe("Wiki sections: Big. Tags: t1.");
    expect(topicsText(null, 100)).toBe("");
  });

  it("falls back to the about text when the wiki is empty (a new wiki)", () => {
    const wiki = tmp();
    dirs.push(wiki);
    writeFileSync(join(wiki, "SCHEMA.md"), "# S\n\n## Tag Taxonomy\n- overview\n");
    writeFileSync(join(wiki, "index.md"), "# Index\n\n## Start Here\n\nNo pages yet.\n");
    const doc = buildSkill(loadWiki(wiki), { name: "team-brain", persona, topics: "index", redactSecrets: true, version: "t" });
    expect(doc.description).not.toMatch(/Wiki sections/);
    expect(doc.description).toContain("Northwind engineering: billing, deploys, the office network.");
    expect(doc.description).toMatch(/Tags: overview\.$/);
    // An operator's description gets the topics only when they fit.
    const op = buildSkill(loadWiki(wiki), { name: "team-brain", persona, topics: "index", description: "Use it.", redactSecrets: true, version: "t" });
    expect(op.description).toBe("Use it. Tags: overview.");
    const full = buildSkill(loadWiki(wiki), { name: "team-brain", persona, topics: "index", description: "x".repeat(995), redactSecrets: true, version: "t" });
    expect(full.description).toBe("x".repeat(995));
  });
});
