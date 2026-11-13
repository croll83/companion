import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Memory sync (memory-sync.ts): the nightly send of a domain's memory files
 * to the domain's brain. Validated here, with temp COMPANION_HOME and domain
 * folders and a fake ingest API / curator (no network):
 *  - what goes: new and changed files (whole, with the changed lines), a
 *    notice for deleted ones, never MEMORY.md nor a `brain: no` file, nothing
 *    when nothing changed, the per-run limit with the rest reported;
 *  - what never goes: private keys, certificates, seed phrases (Marco's rule
 *    for the brains), while ordinary hashes stay;
 *  - failures: a brain that refuses every call (401, unreachable) stops the
 *    run and leaves the unsent files for the next one; a refused file alone
 *    does not stop the others; state is only advanced for what was accepted;
 *  - settings: validation, the ingest token kept apart and never returned;
 *  - the domains of a brain (own choice or GLOBAL's) and the notice sessions get;
 *  - the HTTP routes.
 */

const h = vi.hoisted(() => ({ home: `/tmp/memory-sync-test-${process.pid}-${Date.now()}` }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return join(h.home, "companion");
  },
}));

import {
  checkSchedule,
  deletedText,
  diffLines,
  embeddedSender,
  markMemorySent,
  memorySyncDomains,
  memorySyncNotice,
  MemorySync,
  optedOut,
  readMemoryFiles,
  readMemorySyncConfig,
  redactSecrets,
  sourceText,
  updateMemorySync,
  getMemorySync,
  setMemorySync,
  SEND_TIMEOUT_MS,
} from "./memory-sync.js";
import { createEmbeddedBrain, createRemoteBrain, deleteBrain, getBrain } from "./brain-store.js";
import { createDomain, domainMemoryDir, updateDomain } from "../domain-store.js";
import { CuratorError } from "./brain-curator.js";
import { registerBrainRoutes } from "../routes/brain-routes.js";

const NOW = Date.UTC(2026, 10, 12, 3, 0);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { name: string; text: string; note: string; focus: string };
}

/** A fake ingest API: records each call; `answer` decides the response. */
function fakeIngest(answer: (call: Call) => Response | Promise<Response> = () => Response.json({ note_id: "n1" })) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Call["body"] };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function memory(domain: string, files: Record<string, string>): string {
  const dir = domainMemoryDir(domain);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function remoteBrain(slug = "jarvis"): void {
  createRemoteBrain({ name: slug, slug, baseUrl: "http://brain.test:7421" });
}

function useBrain(domain: string, brain: string | null): void {
  createDomain({ name: domain, slug: domain });
  updateDomain(domain, { brain });
}

beforeEach(() => {
  rmSync(h.home, { recursive: true, force: true });
  mkdirSync(join(h.home, "domains"), { recursive: true });
  process.env.COMPANION_DOMAINS_ROOT = join(h.home, "domains");
  setMemorySync(undefined);
});

afterAll(() => {
  rmSync(h.home, { recursive: true, force: true });
  delete process.env.COMPANION_DOMAINS_ROOT;
});

describe("what a file sends", () => {
  // `brain: no` in the frontmatter is the per-file opt-out; the word elsewhere is not.
  it("reads the brain: no opt-out from the frontmatter only", () => {
    expect(optedOut("---\nname: x\nbrain: no\n---\nbody")).toBe(true);
    expect(optedOut("---\nbrain: \"false\"\n---\n")).toBe(true);
    expect(optedOut("---\nname: x\n---\nbrain: no")).toBe(false);
    expect(optedOut("no frontmatter")).toBe(false);
  });

  // Marco's rule: no private keys, certificates or seeds in a brain; a tx hash on an ordinary line stays.
  it("replaces private keys, certificates and seed phrases, and keeps ordinary hashes", () => {
    const hex = "a".repeat(64);
    const text = [
      "-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAA", "-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN CERTIFICATE-----", "MIIB", "-----END CERTIFICATE-----",
      `wallet private key: 0x${hex}`,
      "seed: abandon ability able about above absent absorb abstract absurd abuse access accident",
      `tx hash ${hex}`,
      `ext xprv${"9".repeat(105)}`,
    ].join("\n");
    const r = redactSecrets(text);
    expect(r.count).toBe(5);
    expect(r.text).not.toContain("b3BlbnNzaC1rZXk");
    expect(r.text).not.toContain("MIIB");
    expect(r.text).not.toContain(`0x${hex}`);
    expect(r.text).not.toContain("abandon ability");
    expect(r.text).toContain(`tx hash ${hex}`);
    expect(r.text).toContain("[omesso dall'invio al brain: openssh private key]");
  });

  // The consolidation integrates only what changed: the diff keeps order and context-free +/- lines.
  it("diffs lines in order, and as sets past the size limit", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"]);
    expect(diffLines("same", "same")).toEqual([]);
    const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
    expect(diffLines(big, `${big}\nnew`)).toEqual(["+ new"]);
  });

  it("builds the source of a new, a changed and a deleted file", () => {
    const fresh = sourceText("jarvis", "x.md", "body", NOW);
    expect(fresh).toContain("# Memoria del dominio jarvis: x.md");
    expect(fresh).not.toContain("Cosa è cambiato");
    const changed = sourceText("jarvis", "x.md", "a\nnew", NOW, { text: "a\nold", sentAt: NOW - 86_400_000 });
    expect(changed).toContain("## Cosa è cambiato");
    expect(changed).toContain("- old\n+ new");
    expect(changed).toContain("## Testo completo\n\na\nnew");
    const many = sourceText("jarvis", "x.md", Array.from({ length: 500 }, (_, i) => `n${i}`).join("\n"), NOW, { text: "", sentAt: NOW });
    expect(many).toContain("altre 101 righe cambiate");
    const gone = deletedText("jarvis", "x.md", NOW, "last text");
    expect(gone).toContain("(eliminato)");
    expect(gone).toContain("last text");
    // A text over 1 MB is cut (the ingest APIs refuse bigger ones).
    expect(Buffer.byteLength(sourceText("d", "big.md", "é".repeat(700_000), NOW))).toBeLessThanOrEqual(1_000_000);
  });

  // Only top-level notes go: the index and hidden files never.
  it("lists memory files without MEMORY.md and hidden files", () => {
    const dir = memory("jarvis", { "MEMORY.md": "- index", "a.md": "A", ".tmp.md": "x", "b.txt": "no" });
    mkdirSync(join(dir, "sub.md"));
    expect(readMemoryFiles(dir).map((f) => f.name)).toEqual(["a.md"]);
    expect(readMemoryFiles(join(h.home, "missing"))).toEqual([]);
  });
});

describe("settings", () => {
  it("validates schedule, limit, URL and token, and keeps the token apart", () => {
    expect(updateMemorySync("nope", { enabled: true })).toMatchObject({ ok: false, status: 404 });
    remoteBrain();
    // A remote brain cannot be turned on without its ingest API.
    expect(updateMemorySync("jarvis", { enabled: true })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { enabled: "yes" as unknown as boolean })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { schedule: "* * * * *" })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { schedule: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { maxFiles: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { ingestUrl: "ftp://x" })).toMatchObject({ ok: false, status: 400 });
    expect(updateMemorySync("jarvis", { token: "has space" })).toMatchObject({ ok: false, status: 400 });
    const ok = updateMemorySync("jarvis", { enabled: true, ingestUrl: "http://brain.test:7422/api/v1/", schedule: "30 2 * * *", maxFiles: 5, token: "brk_secret" });
    expect(ok).toMatchObject({ ok: true, value: { enabled: true, ingestUrl: "http://brain.test:7422", schedule: "30 2 * * *", maxFiles: 5 } });
    expect(JSON.stringify(readMemorySyncConfig("jarvis"))).not.toContain("brk_secret");
    const tokenFile = join(h.home, "companion", "brains", "jarvis", "memory-sync-token");
    expect(readFileSync(tokenFile, "utf-8").trim()).toBe("brk_secret");
    expect(statSync(tokenFile).mode & 0o077).toBe(0);
    updateMemorySync("jarvis", { token: null, enabled: false, ingestUrl: null });
    expect(existsSync(tokenFile)).toBe(false);
    expect(readMemorySyncConfig("jarvis")).toEqual({ enabled: false, schedule: "30 2 * * *", maxFiles: 5 });
  });

  it("accepts a nightly schedule and refuses one more often than every 15 minutes", () => {
    expect(checkSchedule("0 3 * * *")).toBeNull();
    expect(checkSchedule("*/5 * * * *")).toMatch(/15 minutes/);
  });

  // Own choice, GLOBAL's default, and "none" all count; GLOBAL itself only when it names the brain.
  it("finds the domains of a brain, including those using GLOBAL's", () => {
    remoteBrain();
    remoteBrain("other");
    useBrain("hermes", "jarvis");
    useBrain("herd", "other");
    useBrain("plain", null);
    expect(memorySyncDomains("jarvis")).toEqual(["hermes"]);
    updateDomain("global", { brain: "jarvis" });
    createDomain({ name: "inherits", slug: "inherits" });
    expect(memorySyncDomains("jarvis")).toEqual(["global", "hermes", "inherits"]);
  });

  // Sessions read the rule only where the sync is on (Claude prompt, Codex AGENTS.md).
  it("gives sessions the notice only when the sync is on", () => {
    remoteBrain();
    const brain = getBrain("jarvis")!;
    expect(memorySyncNotice(brain)).toEqual([]);
    expect(memorySyncNotice(null)).toEqual([]);
    updateMemorySync("jarvis", { enabled: true, ingestUrl: "http://brain.test:7422" });
    expect(memorySyncNotice(brain).join("\n")).toContain("write new facts in the memory files as usual");
  });
});

describe("runs", () => {
  function setup(maxFiles = 40) {
    remoteBrain();
    useBrain("jarvis", "jarvis");
    updateMemorySync("jarvis", { enabled: true, ingestUrl: "http://brain.test:7422", token: "brk_t", maxFiles });
  }

  it("sends new files, then only changes and deletions, and nothing when nothing changed", async () => {
    setup();
    const dir = memory("jarvis", { "MEMORY.md": "- index", "a.md": "alpha\nold", "b.md": "beta", "skip.md": "---\nbrain: no\n---\nsecret" });
    const ingest = fakeIngest();
    let now = NOW;
    const svc = new MemorySync({ fetch: ingest.fetch, now: () => now });

    let r = await svc.run("jarvis", "manual");
    expect(r.ok && r.value.ok).toBe(true);
    expect(ingest.calls.map((c) => c.body.name).sort()).toEqual(["memoria-jarvis-a", "memoria-jarvis-b"]);
    expect(ingest.calls[0].url).toBe("http://brain.test:7422/api/v1/ingest/text");
    expect(ingest.calls[0].headers.Authorization).toBe("Bearer brk_t");
    expect(ingest.calls[0].body.focus.length).toBeLessThanOrEqual(600);
    const report = r.ok ? r.value.domains[0] : undefined;
    expect(report).toMatchObject({ domain: "jarvis", unchanged: 0, skipped: [{ file: "skip.md", reason: "brain: no" }] });

    ingest.calls.length = 0;
    now += 86_400_000;
    r = await svc.run("jarvis", "manual");
    expect(ingest.calls).toHaveLength(0);
    expect(r.ok && r.value.domains[0].unchanged).toBe(2);

    writeFileSync(join(dir, "a.md"), "alpha\nnew");
    rmSync(join(dir, "b.md"));
    now += 86_400_000;
    r = await svc.run("jarvis", "manual");
    const changed = ingest.calls.find((c) => c.body.name === "memoria-jarvis-a")!;
    expect(changed.body.text).toContain("- old\n+ new");
    expect(changed.body.note).toContain("aggiornato");
    const gone = ingest.calls.find((c) => c.body.name === "memoria-jarvis-b")!;
    expect(gone.body.text).toContain("(eliminato)");
    expect(gone.body.text).toContain("beta");
    expect(r.ok && r.value.domains[0]).toMatchObject({ sent: ["a.md"], deleted: ["b.md"] });
    expect(svc.view("jarvis").lastRun?.domains[0].sent).toEqual(["a.md"]);
  });

  // The first send of a big memory is spread over nights; nothing is silently dropped.
  it("sends at most maxFiles per run, changed files first, and reports the rest", async () => {
    setup(2);
    const dir = memory("jarvis", { "old.md": "v1" });
    const ingest = fakeIngest();
    const svc = new MemorySync({ fetch: ingest.fetch, now: () => NOW });
    await svc.run("jarvis", "manual");
    writeFileSync(join(dir, "old.md"), "v2");
    memory("jarvis", { "n1.md": "1", "n2.md": "2" });
    utimesSync(join(dir, "n1.md"), new Date(NOW - 5000), new Date(NOW - 5000));
    ingest.calls.length = 0;
    const r = await svc.run("jarvis", "manual");
    expect(ingest.calls.map((c) => c.body.name)).toEqual(["memoria-jarvis-old", "memoria-jarvis-n2"]);
    expect(r.ok && r.value.domains[0].deferred).toEqual(["n1.md"]);
  });

  // A wrong token fails every file the same way: stop, keep the rest for the next run, advance nothing.
  it("stops on a refusal of the whole API and keeps the files for the next run", async () => {
    setup();
    memory("jarvis", { "a.md": "A", "b.md": "B", "no.md": "---\nbrain: no\n---\n" });
    const ingest = fakeIngest(() => Response.json({ error: "a curator token is required" }, { status: 401 }));
    const svc = new MemorySync({ fetch: ingest.fetch, now: () => NOW });
    const r = await svc.run("jarvis", "manual");
    expect(ingest.calls).toHaveLength(1);
    expect(r.ok && r.value).toMatchObject({ ok: false, error: "HTTP 401: a curator token is required" });
    expect(r.ok && r.value.domains[0].deferred).toHaveLength(1);
    const ok = fakeIngest();
    await new MemorySync({ fetch: ok.fetch, now: () => NOW }).run("jarvis", "manual");
    expect(ok.calls).toHaveLength(2);
  });

  // A slow brain (about 40 s per ingest on a small server) must not be cut off:
  // the request carries a timeout of minutes, not seconds.
  it("gives each send minutes, not seconds", async () => {
    setup();
    memory("jarvis", { "a.md": "A" });
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal; });
    await new MemorySync({ fetch: fakeIngest().fetch, now: () => NOW }).run("jarvis", "manual");
    spy.mockRestore();
    expect(timeouts).toEqual([SEND_TIMEOUT_MS]);
    expect(SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it("goes on after one refused file, and stops when the brain does not answer", async () => {
    setup();
    memory("jarvis", { "a.md": "A", "b.md": "B" });
    const ingest = fakeIngest((c) => (c.body.name.endsWith("-a") ? new Response("too big", { status: 413 }) : Response.json({})));
    const r = await new MemorySync({ fetch: ingest.fetch, now: () => NOW }).run("jarvis", "manual");
    expect(r.ok && r.value.domains[0]).toMatchObject({ sent: ["b.md"], failed: [{ file: "a.md", error: "HTTP 413: too big" }] });
    expect(r.ok && r.value.ok).toBe(false);

    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r2 = await new MemorySync({ fetch: down, now: () => NOW }).run("jarvis", "manual");
    expect(r2.ok && r2.value.error).toMatch(/did not answer: ECONNREFUSED/);
  });

  it("refuses a scheduled run when off, a second run at once, and an unknown brain", async () => {
    setup();
    memory("jarvis", { "a.md": "A" });
    let release: () => void = () => {};
    const slow = fakeIngest(() => new Promise<Response>((res) => { release = () => res(Response.json({})); }));
    const svc = new MemorySync({ fetch: slow.fetch, now: () => NOW });
    const first = svc.run("jarvis", "manual");
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    expect(svc.view("jarvis").running).toBe(true);
    expect(await svc.run("jarvis", "manual")).toMatchObject({ ok: false, status: 409 });
    release();
    await first;
    updateMemorySync("jarvis", { enabled: false });
    expect(await svc.run("jarvis", "schedule")).toMatchObject({ ok: false, status: 409 });
    expect(await svc.run("nope", "manual")).toMatchObject({ ok: false, status: 404 });
  });

  it("records a run without an ingest URL as an error", async () => {
    remoteBrain();
    useBrain("jarvis", "jarvis");
    const r = await new MemorySync({ now: () => NOW }).run("jarvis", "manual");
    expect(r.ok && r.value).toMatchObject({ ok: false, error: expect.stringMatching(/No ingest URL/) });
  });

  // Embedded brains take the files through their curator API, as "Add source" does.
  it("sends to an embedded brain through its curator API", async () => {
    const wiki = join(h.home, "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "SCHEMA.md"), "# s\n");
    writeFileSync(join(wiki, "index.md"), "# i\n");
    expect(createEmbeddedBrain({ name: "tac", slug: "tac", wikiDir: wiki }).ok).toBe(true);
    useBrain("tac", "tac");
    memory("tac", { "a.md": "A" });
    const curator = vi.fn(async () => ({}));
    const r = await new MemorySync({ curator, now: () => NOW }).run("tac", "manual");
    expect(curator).toHaveBeenCalledWith("tac", "/sources", expect.objectContaining({ method: "POST", body: expect.objectContaining({ name: "memoria-tac-a", by: "Companion memory sync" }) }));
    expect(r.ok && r.value.ok).toBe(true);

    const stopped = embeddedSender("tac", async () => { throw new CuratorError(409, "The brain is not running: start it first"); });
    await expect(stopped({ name: "n", text: "t", note: "x" })).rejects.toMatchObject({ fatal: true });
    const refused = embeddedSender("tac", async () => { throw new CuratorError(413, "too big"); });
    await expect(refused({ name: "n", text: "t", note: "x" })).rejects.toMatchObject({ fatal: false });
  });

  // A memory already moved by hand (the 12/11 travaso) is not sent again; later edits are.
  it("marks a domain's files as sent, only those not modified since `before`", async () => {
    setup();
    const dir = memory("jarvis", { "old.md": "O", "new.md": "N", "no.md": "---\nbrain: no\n---\n" });
    utimesSync(join(dir, "old.md"), new Date(NOW - 10_000), new Date(NOW - 10_000));
    utimesSync(join(dir, "new.md"), new Date(NOW + 10_000), new Date(NOW + 10_000));
    expect(markMemorySent("jarvis", "jarvis", { before: NOW, now: NOW })).toEqual(["old.md"]);
    const ingest = fakeIngest();
    await new MemorySync({ fetch: ingest.fetch, now: () => NOW }).run("jarvis", "manual");
    expect(ingest.calls.map((c) => c.body.name)).toEqual(["memoria-jarvis-new"]);
  });

  it("arms and disarms the nightly timer with the settings", () => {
    setup();
    const svc = new MemorySync();
    svc.startAll();
    svc.schedule("jarvis");
    deleteBrain("jarvis");
    svc.schedule("jarvis");
    svc.stopAll();
    setMemorySync(svc);
    expect(getMemorySync()).toBe(svc);
  });
});

describe("routes", () => {
  function app(svc: MemorySync) {
    const a = new Hono();
    registerBrainRoutes(a, { memorySync: svc });
    return a;
  }
  const send = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("reads and saves settings, never returning the token, and runs on demand", async () => {
    remoteBrain();
    useBrain("jarvis", "jarvis");
    memory("jarvis", { "a.md": "A" });
    const ingest = fakeIngest();
    const a = app(new MemorySync({ fetch: ingest.fetch, now: () => NOW }));
    expect((await a.request("/brains/nope/memory-sync")).status).toBe(404);
    let res = await a.request("/brains/jarvis/memory-sync", send("PUT", { enabled: true }));
    expect(res.status).toBe(400);
    res = await a.request("/brains/jarvis/memory-sync", send("PUT", { enabled: true, ingestUrl: "http://brain.test:7422", token: "brk_x", ignored: 1 }));
    const view = (await res.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ config: { enabled: true }, tokenConfigured: true, domains: ["jarvis"] });
    expect(JSON.stringify(view)).not.toContain("brk_x");
    res = await a.request("/brains/jarvis/memory-sync/run", send("POST", {}));
    expect(await res.json()).toMatchObject({ run: { ok: true, domains: [{ sent: ["a.md"] }] }, memorySync: { lastRun: { ok: true } } });
    expect((await a.request("/brains/nope/memory-sync/run", send("POST", {}))).status).toBe(404);
  });

  it("marks a domain as sent and refuses other domains or bad times", async () => {
    remoteBrain();
    useBrain("jarvis", "jarvis");
    memory("jarvis", { "a.md": "A" });
    const a = app(new MemorySync({ now: () => NOW }));
    expect((await a.request("/brains/jarvis/memory-sync/mark-sent", send("POST", { domain: "other" }))).status).toBe(400);
    expect((await a.request("/brains/jarvis/memory-sync/mark-sent", send("POST", { domain: "jarvis", before: "x" }))).status).toBe(400);
    const res = await a.request("/brains/jarvis/memory-sync/mark-sent", send("POST", { domain: "jarvis", before: Date.now() + 60_000 }));
    expect(await res.json()).toMatchObject({ marked: ["a.md"] });
    const all = await a.request("/brains/jarvis/memory-sync/mark-sent", send("POST", { domain: "jarvis" }));
    expect(await all.json()).toMatchObject({ marked: ["a.md"] });
  });

  it("answers 503 when the server has no memory sync service", async () => {
    remoteBrain();
    const a = new Hono();
    registerBrainRoutes(a, {});
    expect((await a.request("/brains/jarvis/memory-sync")).status).toBe(503);
  });
});
