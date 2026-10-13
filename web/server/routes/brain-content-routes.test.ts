import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";

/**
 * Phase 2b routes end to end against a REAL brain core running in-process
 * (the test imports the core; Companion's server only talks to it over its
 * curator API, here through an injected fetch):
 *  - "New brain": a wiki from the template, an embedded brain on it,
 *    started, on no domain, its skill taken from the brain; git missing is a
 *    clear error with a code for the page; bad input is refused;
 *  - "Adopt existing folder": what blocks it, with fixes, then the guided
 *    lint of the running brain with one-click additive fixes;
 *  - Pages (list, search, read; secrets redacted as sessions see them),
 *    Inbox (list by status, dismiss with a reason), Add source (text, URL);
 *  - errors: a stopped brain, a remote brain, bad statuses; and no answer
 *    ever carries the brain's keys.
 * HOME, COMPANION_HOME and the git config are temp folders.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { registerBrainRoutes } from "./brain-routes.js";
import { registerDomainRoutes } from "./domain-routes.js";
import { brainDataDir, brainServerName, getBrain } from "../brain/brain-store.js";
import { embeddedKeys } from "../brain/brain-token.js";
import { setChildPort } from "../brain/brain-endpoints.js";
import { setGitBinaryForTest } from "../brain/brain-git.js";
import type { BrainRuntimeStatus } from "../brain/brain-supervisor.js";
import { loadConfig } from "../brain/core/config.js";
import { Audit } from "../brain/core/audit.js";
import { Brain } from "../brain/core/brain.js";
import { createFetchHandler } from "../brain/core/http.js";
import { FIXTURE_SECRETS, writeFixtureWiki } from "../brain/core/__tests__/fixture.js";

let tmp: string;
let app: Hono;
const running = new Map<number, { brain: Brain; handler: (r: Request) => Promise<Response> }>();
let nextPort = 46000;
const saved = { HOME: process.env.HOME, root: process.env.COMPANION_DOMAINS_ROOT, claude: process.env.CLAUDE_CONFIG_DIR, global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

const send = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A supervisor that runs the brain core in-process instead of a child process. */
function coreSupervisor() {
  const states = new Map<string, { state: BrainRuntimeStatus["state"]; port?: number }>();
  const start = (slug: string) => {
    const b = getBrain(slug)!;
    const keys = embeddedKeys(slug)!;
    const port = nextPort++;
    const cfg = loadConfig({
      BRAIN_WIKI_DIR: b.embedded!.wikiDir,
      BRAIN_DATA_DIR: brainDataDir(slug),
      BRAIN_NAME: brainServerName(slug),
      BRAIN_TITLE: `${b.name} brain`,
      BRAIN_OWNER: "Marco Monaco",
      BRAIN_ABOUT: b.about,
      BRAIN_LANGUAGE: b.embedded!.language,
      BRAIN_REDACT_SECRETS: String(b.embedded!.redactSecrets),
      BRAIN_TOKEN_KEY: keys.tokenKey,
      BRAIN_CURATOR_KEY: keys.curatorKey,
      BRAIN_REFRESH_SECONDS: "0",
    });
    const brain = new Brain(cfg, new Audit(() => undefined, undefined, cfg.name));
    running.set(port, { brain, handler: createFetchHandler(brain) });
    states.set(slug, { state: "running", port });
    setChildPort(slug, port);
  };
  return {
    start: vi.fn(start),
    stop: vi.fn(async (slug: string) => {
      const port = states.get(slug)?.port;
      if (port) running.get(port)?.brain.inbox.close();
      if (port) running.delete(port);
      states.set(slug, { state: "stopped" });
      setChildPort(slug, null);
    }),
    restart: vi.fn(async (slug: string) => start(slug)),
    status: vi.fn((slug: string): BrainRuntimeStatus => ({ state: states.get(slug)?.state ?? "stopped", crashes: 0 })),
    waitRunning: vi.fn(async (slug: string) => states.get(slug)?.state === "running"),
    logTail: vi.fn(() => []),
  };
}

/** Requests to 127.0.0.1:<port> go to the core brain on that port (in-process). */
async function childFetch(url: string, init?: RequestInit): Promise<Response> {
  const port = Number(new URL(url).port);
  const child = running.get(port);
  if (!child) throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`);
  return child.handler(new Request(url, init));
}

let sup: ReturnType<typeof coreSupervisor>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-content-"));
  h.home = join(tmp, "companion");
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "domains");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  process.env.GIT_CONFIG_GLOBAL = join(tmp, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Marco Monaco\n\temail = marco@example.org\n");
  sup = coreSupervisor();
  app = new Hono();
  registerBrainRoutes(app, { fetch: childFetch, curatorFetch: childFetch, supervisor: sup, readyWaitMs: 50 });
  registerDomainRoutes(app, { listSessions: () => [] }, { refreshAccountMcp: async () => ({ servers: [], at: Date.now() }) });
});

afterEach(() => {
  for (const { brain } of running.values()) brain.inbox.close();
  running.clear();
  for (const s of ["boat", "notes", "work"]) setChildPort(s, null);
  setGitBinaryForTest("git");
  for (const [k, v] of [["HOME", saved.HOME], ["COMPANION_DOMAINS_ROOT", saved.root], ["CLAUDE_CONFIG_DIR", saved.claude], ["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

async function newBoat(extra: Record<string, unknown> = {}) {
  const r = await json("/brains/new", send("POST", { name: "Boat", about: "La barca, i motori e il charter della stagione.", tags: ["engine", "charter"], ...extra }));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe("New brain", () => {
  it("creates the wiki and an embedded brain on it, started, on no domain, with the brain's skill", async () => {
    expect((await json("/brains/git")).body).toMatchObject({ available: true });
    const r = await newBoat();
    const dir = join(process.env.HOME!, "companion_brain_boat");
    expect(r.wiki).toMatchObject({ dir, language: "it", tags: ["engine", "charter"], commit: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(r.brain).toMatchObject({
      slug: "boat",
      kind: "embedded",
      about: "La barca, i motori e il charter della stagione.",
      embedded: { wikiDir: dir, autostart: true, redactSecrets: true, language: "it" },
      domains: [],
      skill: { source: "server" },
    });
    expect(sup.start).toHaveBeenCalledWith("boat");
    // The new wiki has no pages: the skill says what it covers from the about text, and the owner is a person.
    expect(r.brain.skillText).toMatch(/the knowledge base of Marco Monaco, whenever the work touches its topics: La barca/);
    expect(r.brain.skillText).toMatch(/Tags: engine, charter\./);
    // The template lints clean through the brain's own lint.
    expect((await json("/brains/boat/lint")).body).toMatchObject({ ok: true, errors: 0, advice: [] });
    // The check and the page list see files written since the last reload (no wait for the periodic one).
    writeFileSync(join(process.env.HOME!, "companion_brain_boat", "concepts", "Bad Name.md"), "no frontmatter\n");
    expect((await json("/brains/boat/lint")).body.ok).toBe(false);
    expect((await json("/brains/boat/pages")).body.pages.map((p: { path: string }) => p.path)).toEqual(["concepts/Bad Name.md"]);
    // Off everywhere: GLOBAL has no brain.
    const domains = (await json("/domains")).body;
    expect(domains.domains.every((d: { effectiveBrain?: unknown }) => !d.effectiveBrain)).toBe(true);
  });

  it("uses the folder given, and refuses a non-empty one, a duplicate name or no name", async () => {
    const dir = join(tmp, "elsewhere", "boat-wiki");
    expect((await newBoat({ wikiDir: dir })).wiki.dir).toBe(dir);
    expect(execFileSync("git", ["-C", dir, "log", "--format=%an"], { encoding: "utf8" }).trim()).toBe("Marco Monaco");
    let r = await json("/brains/new", send("POST", { name: "Boat" }));
    expect(r).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already exists/) } });
    r = await json("/brains/new", send("POST", { name: "Notes", wikiDir: dir }));
    expect(r).toMatchObject({ status: 409, body: { code: "exists" } });
    expect(getBrain("notes")).toBeUndefined();
    expect((await json("/brains/new", send("POST", { name: " " }))).status).toBe(400);
    expect((await json("/brains/new", send("POST", { name: "***" }))).status).toBe(400);
    expect((await json("/brains/new", send("POST", { name: "Notes", about: 3 }))).status).toBe(400);
    expect((await json("/brains/new", send("POST", { name: "Notes", wikiDir: "relative" }))).body).toMatchObject({ code: "invalid" });
  });

  it("says git is missing, with a code the page turns into a blocking card, and creates nothing", async () => {
    setGitBinaryForTest(join(tmp, "no-git"));
    expect((await json("/brains/git")).body).toEqual({ available: false });
    const r = await json("/brains/new", send("POST", { name: "Boat", about: "x" }));
    expect(r).toMatchObject({ status: 409, body: { code: "git-missing", error: expect.stringMatching(/git is not installed/) } });
    expect(existsSync(join(process.env.HOME!, "companion_brain_boat"))).toBe(false);
    expect(getBrain("boat")).toBeUndefined();
  });

  it("reports a git that fails as a server error", async () => {
    const fake = join(tmp, "fake-git");
    writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'git version 9'; exit 0; fi\nexit 1\n");
    chmodSync(fake, 0o755);
    setGitBinaryForTest(fake);
    expect((await json("/brains/new", send("POST", { name: "Boat" }))).body).toMatchObject({ code: "git-failed" });
  });
});

describe("Add source, Inbox, Pages", () => {
  it("adds a pasted source, shows its note in the inbox, dismisses it with a reason", async () => {
    await newBoat();
    let r = await json("/brains/boat/sources", send("POST", { name: "Engine manual.md", text: "# Engine\n\nOil every 250 hours.", note: "From the shipyard" }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.path).toMatch(/^raw\/sources\/\d{4}-\d{2}-\d{2}-engine-manual\.md$/);
    const dir = join(process.env.HOME!, "companion_brain_boat");
    expect(readFileSync(join(dir, r.body.path), "utf8")).toBe("# Engine\n\nOil every 250 hours.\n");
    // Left uncommitted for the consolidation.
    expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toMatch(/\?\? raw\/sources\//);

    r = await json("/brains/boat/sources", send("POST", { url: "https://example.org/charter-rules", note: "Port rules" }));
    expect(r.status).toBe(200);
    expect(r.body.path).toBeUndefined();

    let inbox = (await json("/brains/boat/inbox")).body;
    expect(inbox.counts).toEqual({ pending: 2 });
    expect(inbox.notes.map((n: { kind: string }) => n.kind)).toEqual(["source_pointer", "source_pointer"]);
    expect(inbox.notes[0]).toMatchObject({ sources: ["url:https://example.org/charter-rules"], author: "Companion", status: "pending" });
    expect(inbox.notes[1].statement).toMatch(/engine-manual\.md.*From the shipyard/);
    expect(inbox.notes[0].mcp_session_id).toBeUndefined();

    const id = inbox.notes[0].note_id;
    r = await json(`/brains/boat/inbox/${id}/dismiss`, send("POST", { reason: "Not needed" }));
    expect(r.body).toEqual({ note_id: id, status: "discarded" });
    expect((await json(`/brains/boat/inbox/${id}/dismiss`, send("POST", {}))).status).toBe(409);
    inbox = (await json("/brains/boat/inbox?status=discarded")).body;
    expect(inbox.notes[0]).toMatchObject({ note_id: id, status_reason: "Not needed", status_by: "user", statement: "" });
    expect((await json("/brains/boat/inbox?status=bogus")).status).toBe(400);
    expect((await json("/brains/boat/sources", send("POST", { name: "big", text: "x".repeat(1_000_001) }))).status).toBe(413);
    expect((await json("/brains/boat/sources", send("POST", { name: "bad", text: "a\u0000b" }))).status).toBe(400);
  });

  it("lists, searches and reads pages, secrets redacted as sessions see them", async () => {
    const wiki = join(tmp, "team-wiki");
    writeFixtureWiki(wiki);
    const created = await json("/brains", send("POST", { kind: "embedded", name: "Work", wikiDir: wiki }));
    expect(created.status).toBe(201);
    const list = (await json("/brains/work/pages")).body;
    expect(list.pages.length).toBe(9);
    const found = (await json("/brains/work/pages?q=invoices")).body;
    expect(found.pages[0]).toMatchObject({ slug: "billing-service", title: "Billing Service" });
    const page = (await json("/brains/work/pages/office-network")).body;
    expect(page.markdown).not.toContain(FIXTURE_SECRETS.assigned);
    expect(page.markdown).toMatch(/\[REDACTED:/);
    expect((await json("/brains/work/pages/index")).body.path).toBe("index.md");
    // A path-like slug (a name used twice in the wiki) is one parameter.
    expect((await json(`/brains/work/pages/${encodeURIComponent("handbook/index")}`)).body.path).toBe("handbook/index.md");
    expect((await json("/brains/work/pages/nope")).status).toBe(404);
  });

  it("refuses a stopped brain, a remote brain and an unknown one", async () => {
    await newBoat();
    await app.request("/brains/boat/stop", send("POST"));
    expect(await json("/brains/boat/pages")).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not running/) } });
    await json("/brains", send("POST", { name: "Far", baseUrl: "http://100.64.0.9:7421", skill: { source: "generated" } }));
    expect((await json("/brains/far/inbox")).status).toBe(404);
    expect((await json("/brains/nope/lint")).status).toBe(404);
  });
});

describe("Adopt existing folder and guided lint", () => {
  it("offers to create SCHEMA.md and index.md, then lints the running brain and fixes it in clicks", async () => {
    const dir = join(tmp, "notes");
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const pageText = (name: string, links: string[]) =>
      `---\ntitle: ${name}\ncreated: 2026-10-01\nupdated: 2026-10-02\ntype: concept\ntags: [boats]\nsources: [https://example.org]\n---\n# ${name}\n\n${links.map((l) => `[[${l}]]`).join(" ")} ${"Real words here. ".repeat(30)}\n`;
    writeFileSync(join(dir, "concepts", "hull.md"), pageText("Hull", ["keel", "rudder"]));
    writeFileSync(join(dir, "concepts", "keel.md"), pageText("Keel", ["hull", "rudder"]));
    writeFileSync(join(dir, "concepts", "rudder.md"), pageText("Rudder", ["hull", "keel"]));

    let check = (await json("/brains/adopt-check", send("POST", { wikiDir: dir }))).body;
    expect(check).toMatchObject({ ok: true, ready: false });
    expect(check.advice.map((a: { fix?: { id: string } }) => a.fix?.id)).toEqual(["create-schema", "create-index"]);
    check = (await json("/brains/adopt-check", send("POST", { wikiDir: dir, fix: "create-schema", name: "Notes", about: "Sailing notes" }))).body;
    expect(check.done).toBe("SCHEMA.md created");
    check = (await json("/brains/adopt-check", send("POST", { wikiDir: dir, fix: "create-index" }))).body;
    expect(check).toMatchObject({ ready: true, advice: [] });
    expect((await json("/brains/adopt-check", send("POST", { wikiDir: dir, fix: "add-tags" }))).status).toBe(400);
    expect((await json("/brains/adopt-check", send("POST", { wikiDir: join(tmp, "missing") }))).status).toBe(400);

    expect((await json("/brains", send("POST", { kind: "embedded", name: "Notes", wikiDir: dir }))).status).toBe(201);
    let lint = (await json("/brains/notes/lint")).body;
    const ids = lint.advice.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["tags-unknown", "index-unlisted", "log-missing"]));
    for (const fix of ["add-tags", "index-pages", "create-log"]) {
      const r = await json("/brains/notes/lint/fix", send("POST", { fix }));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      lint = r.body.lint;
    }
    expect(lint).toMatchObject({ ok: true, errors: 0 });
    expect(lint.advice.filter((a: { fix?: unknown }) => a.fix)).toEqual([]);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toMatch(/- \[\[hull\]\] — Hull/);
    expect((await json("/brains/notes/lint/fix", send("POST", { fix: "rm" }))).status).toBe(400);
  });
});

describe("secrets", () => {
  it("never returns the brain's keys from the new routes", async () => {
    const created = await newBoat();
    const bodies = [JSON.stringify(created)];
    for (const path of ["/brains/boat/pages", "/brains/boat/pages/index", "/brains/boat/inbox", "/brains/boat/lint", "/brains/git"]) bodies.push(await (await app.request(path)).text());
    bodies.push(await (await app.request("/brains/boat/sources", send("POST", { name: "n", text: "Some text." }))).text());
    bodies.push(await (await app.request("/brains/adopt-check", send("POST", { wikiDir: join(process.env.HOME!, "companion_brain_boat") }))).text());
    const keys = embeddedKeys("boat")!;
    const secret = readFileSync(join(h.home, "brains", "boat", "secret"), "utf8").trim();
    for (const b of bodies) {
      expect(b).not.toContain(keys.curatorKey);
      expect(b).not.toContain(keys.tokenKey);
      expect(b).not.toContain(secret);
    }
    expect(readdirSync(join(h.home, "brains"))).toEqual(["boat"]);
  });
});
