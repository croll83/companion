import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecution } from "../agent-types.js";
import type { CLIResultMessage } from "../session-types.js";

/**
 * Consolidation of embedded brains (brain-consolidation.ts), with REAL git on
 * temp wikis and a fake executor and curator API (no CLI ever runs). It
 * validates what the design asks of Companion, not of the model:
 *  - the deterministic triggers: skipped (recorded, no session) with 0
 *    notes, the catch-up on the first health tick after a long pause, the
 *    threshold with its 6-hour gap, never two runs at once;
 *  - the preparation: new sources committed in the wiki, the curator clone
 *    created and reset, the curator URL (a per-run pass) in the env, the
 *    model resolved now (latest Sonnet by default);
 *  - the verified post-sync: success only with a commit fast-forwarded into
 *    the wiki and a reload; "not synced" when the wiki was edited by hand,
 *    a later run refusing to reset that commit away, Retry sync; "no commit";
 *  - the agent made from the template, remote linking, the run records.
 * COMPANION_HOME, HOME and the git config are temp folders.
 */

const h = vi.hoisted(() => ({ home: `/tmp/brain-consolidation-test-${process.pid}-${Date.now()}` }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import {
  BrainConsolidation,
  CATCH_UP_AFTER_MS,
  THRESHOLD_MIN_GAP_MS,
  getBrainConsolidation,
  lastAttemptAt,
  lastSuccessAt,
  readRuns,
  saveRun,
  setBrainConsolidation,
  type ConsolidationExecutor,
} from "./brain-consolidation.js";
import { createEmbeddedBrain, createRemoteBrain, getBrain } from "./brain-store.js";
import { CuratorError } from "./brain-curator.js";
import * as agentStore from "../agent-store.js";
import { curatorDir } from "./consolidation-template.js";
import { handleBrainProxy } from "./brain-proxy.js";
import { setChildPort } from "./brain-endpoints.js";
import { latestSonnet } from "../claude-models.js";

const saved = { HOME: process.env.HOME, global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
let wiki: string;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A wiki git repo on main with one commit. */
function makeWiki(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(dir, "index.md"), "# Index\n");
  writeFileSync(join(dir, "log.md"), "# Log\n");
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
}

function fakeExecutor(over: Partial<ConsolidationExecutor> = {}) {
  const base = {
    startRun: vi.fn((): ReturnType<ConsolidationExecutor["startRun"]> => ({ ok: true as const })),
    isRunInProgress: vi.fn(() => false),
    runSessionOf: vi.fn((): string | undefined => undefined),
    listAllExecutions: vi.fn(() => ({ executions: [] as AgentExecution[], total: 0 })),
  };
  return Object.assign(base, over);
}

/** The brain's curator API: pending count, refresh, the core's runs. */
function fakeCurator(state: { pending: number; refreshFails?: boolean; runsFail?: boolean; runs?: { run_id: string; created_at: string; counts: Record<string, number> }[] }) {
  return vi.fn(async (_slug: string, path: string) => {
    if (path.startsWith("/inbox/notes")) return { counts: { pending: state.pending } } as never;
    if (path === "/lint") return { errors: 0, warnings: 2 } as never;
    if (path === "/admin/refresh") {
      if (state.refreshFails) throw new Error("The brain is not running: start it first");
      return { changed: true } as never;
    }
    if (path === "/consolidation/runs" && state.runsFail) throw new CuratorError(502, "The brain did not answer");
    if (path === "/consolidation/runs") return { runs: (state.runs ?? []).map(({ run_id, created_at }) => ({ run_id, created_at })) } as never;
    const m = /^\/consolidation\/runs\/(.+)$/.exec(path);
    if (m) return { counts: state.runs?.find((r) => r.run_id === m[1])?.counts ?? {} } as never;
    throw new Error(`unexpected ${path}`);
  });
}

function exec(over: Partial<AgentExecution> = {}): AgentExecution {
  return { sessionId: "", agentId: "work-brain-consolidation", triggerType: "manual", startedAt: Date.now(), ...over };
}

const okResult = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 40 } } as unknown as CLIResultMessage;

/** An embedded brain "work" on a git wiki, consolidation turned on (agent created). */
function setup(state = { pending: 3 } as Parameters<typeof fakeCurator>[0], executor = fakeExecutor()) {
  const r = createEmbeddedBrain({ name: "Work", wikiDir: wiki });
  if (!r.ok) throw new Error(r.error);
  const svc = new BrainConsolidation({ executor, curator: fakeCurator(state) });
  const on = svc.configure("work", { enabled: true });
  if (!on.ok) throw new Error(on.error);
  return { svc, executor, agent: svc.agentOf(on.brain)! };
}

/** The agent's work in the clone: a page and a commit. */
function agentCommits(file = "concepts/new.md"): void {
  const dir = curatorDir("work");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  writeFileSync(join(dir, file), "# New\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "consolidation: test");
}

beforeEach(() => {
  rmSync(h.home, { recursive: true, force: true });
  mkdirSync(h.home, { recursive: true });
  const home = join(h.home, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(h.home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test User\n\temail = test@example.org\n");
  wiki = join(h.home, "wiki");
  makeWiki(wiki);
});

let services: BrainConsolidation[] = [];
afterEach(() => {
  for (const s of services) s.stopAll();
  services = [];
  for (const [k, v] of [["HOME", saved.HOME], ["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(() => rmSync(h.home, { recursive: true, force: true }));

function track<T extends { svc: BrainConsolidation }>(x: T): T {
  services.push(x.svc);
  return x;
}

describe("run records", () => {
  // The threshold and catch-up compare to the last real attempt: a skipped run did nothing.
  it("keeps the last 50, replaces by id and ignores skipped runs for the last attempt", () => {
    createEmbeddedBrain({ name: "Work", wikiDir: wiki });
    for (let i = 0; i < 55; i++) saveRun("work", { id: `r${i}`, trigger: "schedule", status: i === 54 ? "skipped" : "success", startedAt: 1000 + i, finishedAt: 2000 + i });
    saveRun("work", { id: "r53", trigger: "schedule", status: "not_synced", startedAt: 1053 });
    const runs = readRuns("work");
    expect(runs).toHaveLength(50);
    expect(runs[0].id).toBe("r5");
    expect(runs.find((r) => r.id === "r53")?.status).toBe("not_synced");
    expect(lastAttemptAt(runs)).toBe(1053);
    expect(lastSuccessAt(runs)).toBe(2052);
    expect(lastAttemptAt([])).toBe(0);
    expect(lastSuccessAt([])).toBeUndefined();
  });

  it("skips torn lines", () => {
    createEmbeddedBrain({ name: "Work", wikiDir: wiki });
    saveRun("work", { id: "a", trigger: "manual", status: "success", startedAt: 1 });
    const path = join(h.home, "brains", "work", "reports", "runs.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{"torn\n`);
    expect(readRuns("work").map((r) => r.id)).toEqual(["a"]);
  });

  it("exposes the server's service", () => {
    const svc = new BrainConsolidation({ executor: fakeExecutor() });
    setBrainConsolidation(svc);
    expect(getBrainConsolidation()).toBe(svc);
    setBrainConsolidation(undefined);
  });
});

describe("configure: the agent from the template", () => {
  it("creates the agent with the brain role, the curator clone as folder and no trigger of its own; arms the cron", () => {
    const { svc, agent } = track(setup());
    expect(agent).toMatchObject({
      name: "Work brain consolidation",
      backendType: "claude",
      model: latestSonnet(),
      cwd: curatorDir("work"),
      domain: "global",
      enabled: true,
      brainRole: { slug: "work", role: "consolidation" },
      triggers: {},
    });
    // The curator credential is never in the prompt or the saved env.
    expect(agent.prompt).toContain("$BRAIN_API_URL");
    expect(agent.env).toBeUndefined();
    expect(getBrain("work")?.consolidation).toMatchObject({ enabled: true, schedule: "0 5 * * *", threshold: 10, agentId: agent.id });
    const view = svc.view("work")!;
    expect(view.nextRunAt).toBeGreaterThan(Date.now());
    expect(view.agent?.id).toBe(agent.id);
    expect(view.resolvedModel).toBe(latestSonnet());
  });

  it("rewrites the same agent when settings change, and disarms the cron when turned off", () => {
    const { svc, agent } = track(setup());
    const r = svc.configure("work", { backend: "codex", model: "gpt-5.5", threshold: 4, agentId: "ignored" });
    expect(r.ok).toBe(true);
    const again = agentStore.getAgent(agent.id)!;
    expect(again).toMatchObject({ backendType: "codex", model: "gpt-5.5" });
    expect(agentStore.listAgents().filter((a) => a.brainRole)).toHaveLength(1);
    svc.configure("work", { enabled: false });
    expect(agentStore.getAgent(agent.id)?.enabled).toBe(false);
    expect(svc.view("work")?.nextRunAt).toBeNull();
  });

  it("finds its agent by role after a rename, and picks a free name when taken", () => {
    agentStore.createAgent({ version: 1, name: "Work brain consolidation", description: "", backendType: "claude", model: "m", permissionMode: "bypassPermissions", cwd: "", prompt: "mine", enabled: true });
    const { svc, agent } = track(setup());
    expect(agent.name).toBe("Work brain consolidation 2");
    const renamed = agentStore.updateAgent(agent.id, { name: "Renamed" })!;
    expect(svc.agentOf(getBrain("work")!)?.id).toBe(renamed.id);
  });

  it("refuses invalid settings and remote brains", () => {
    const { svc } = track(setup());
    expect(svc.configure("work", { threshold: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(svc.configure("work", { mode: "pr" })).toMatchObject({ ok: false, status: 400 });
    expect(svc.configure("nope", {})).toMatchObject({ ok: false, status: 404 });
    createRemoteBrain({ name: "Jarvis", baseUrl: "http://100.1.1.1:7421" });
    expect(svc.configure("jarvis", { enabled: true })).toMatchObject({ ok: false, status: 409 });
    expect(svc.view("nope")).toBeNull();
  });
});

describe("triggers", () => {
  it("records a skipped run and starts no session when no note waits", async () => {
    const { svc, executor } = track(setup({ pending: 0 }));
    const r = await svc.trigger("work", "schedule");
    expect(r).toMatchObject({ ok: true, started: false, run: { status: "skipped", trigger: "schedule", pending: 0 } });
    expect(executor.startRun).not.toHaveBeenCalled();
    expect(readRuns("work").map((x) => x.status)).toEqual(["skipped"]);
  });

  it("starts the agent (even when disabled) when notes wait, and never two runs at once", async () => {
    const { svc, executor, agent } = track(setup({ pending: 2 }));
    expect(await svc.trigger("work", "manual")).toEqual({ ok: true, started: true });
    expect(executor.startRun).toHaveBeenCalledWith(agent.id, undefined, { ignoreEnabled: true, triggerType: "manual" });
    executor.isRunInProgress.mockReturnValue(true);
    expect(await svc.trigger("work", "schedule")).toMatchObject({ ok: false, status: 409 });
    expect(svc.view("work")?.running).toBe(true);
  });

  it("refuses while the count is being read (the overlap guard)", async () => {
    const { svc } = track(setup({ pending: 2 }));
    const first = svc.trigger("work", "manual");
    expect(await svc.trigger("work", "manual")).toMatchObject({ ok: false, status: 409 });
    await first;
  });

  it("records an error when the notes cannot be counted, and passes the executor's refusal on", async () => {
    const executor = fakeExecutor({ startRun: vi.fn(() => ({ ok: false as const, status: 409 as const, error: "busy" })) });
    const { svc } = track(setup({ pending: 1 }, executor));
    expect(await svc.trigger("work", "manual")).toEqual({ ok: false, status: 409, error: "busy" });
    const broken = new BrainConsolidation({ executor, curator: vi.fn(async () => { throw new Error("down"); }) });
    const r = await broken.trigger("work", "manual");
    expect(r).toMatchObject({ ok: true, started: false, run: { status: "error" } });
    expect(await broken.trigger("nope", "manual")).toMatchObject({ ok: false, status: 404 });
  });

  it("needs the agent: consolidation turned on first", async () => {
    createEmbeddedBrain({ name: "Work", wikiDir: wiki });
    const svc = new BrainConsolidation({ executor: fakeExecutor(), curator: fakeCurator({ pending: 1 }) });
    expect(await svc.trigger("work", "manual")).toMatchObject({ ok: false, status: 409 });
  });

  it("catches up on the first health tick only, when the last attempt is over a day old", async () => {
    const { svc, executor } = track(setup({ pending: 1 }));
    saveRun("work", { id: "old", trigger: "schedule", status: "success", startedAt: Date.now() - CATCH_UP_AFTER_MS - 1000 });
    svc.onHealth("work", { pending: 1 });
    await vi.waitFor(() => expect(executor.startRun).toHaveBeenCalledTimes(1));
    // Later ticks: 1 note is under the threshold (10).
    svc.onHealth("work", { pending: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.startRun).toHaveBeenCalledTimes(1);
  });

  it("does not catch up after a recent attempt, nor without notes", async () => {
    const { svc, executor } = track(setup({ pending: 1 }));
    saveRun("work", { id: "recent", trigger: "schedule", status: "error", startedAt: Date.now() - 3_600_000 });
    svc.onHealth("work", { pending: 1 });
    svc.onHealth("other", undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.startRun).not.toHaveBeenCalled();
  });

  it("runs at the threshold when the last attempt is over 6 hours old", async () => {
    const { svc, executor } = track(setup({ pending: 12 }));
    saveRun("work", { id: "a", trigger: "schedule", status: "success", startedAt: Date.now() - 3_600_000 });
    svc.onHealth("work", { pending: 1 }); // first tick, recent: nothing
    svc.onHealth("work", { pending: 12 }); // over the threshold but within 6 h: nothing
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.startRun).not.toHaveBeenCalled();
    saveRun("work", { id: "a", trigger: "schedule", status: "success", startedAt: Date.now() - THRESHOLD_MIN_GAP_MS - 1000 });
    svc.onHealth("work", { pending: 9 }); // under the threshold
    svc.onHealth("work", { pending: 10 });
    await vi.waitFor(() => expect(executor.startRun).toHaveBeenCalledTimes(1));
  });

  it("ignores health ticks of brains with consolidation off", async () => {
    const { svc, executor } = track(setup({ pending: 50 }));
    svc.configure("work", { enabled: false });
    svc.onHealth("work", { pending: 50 });
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.startRun).not.toHaveBeenCalled();
  });
});

describe("prepare and settle (real git)", () => {
  afterEach(() => setChildPort("work", null));

  it("commits new sources, clones the wiki, hands over a per-run curator URL, then syncs the agent's commit", async () => {
    // An older consolidation run of the brain: its decisions are not this run's.
    const state: Parameters<typeof fakeCurator>[0] & { runs: NonNullable<Parameters<typeof fakeCurator>[0]["runs"]> } = {
      pending: 2,
      runs: [{ run_id: "older", created_at: new Date().toISOString(), counts: { accepted: 9 } }],
    };
    const { svc, agent } = track(setup(state));
    mkdirSync(join(wiki, "raw", "sources"), { recursive: true });
    writeFileSync(join(wiki, "raw", "sources", "2026-10-14-manual.md"), "# Manual\n");
    const e = exec({ triggerType: "manual" });
    const prep = await svc.prepare(agent, e);

    expect(sh(wiki, "log", "-1", "--format=%s")).toBe("sources: 1 added from Companion");
    expect(existsSync(join(curatorDir("work"), "raw", "sources", "2026-10-14-manual.md"))).toBe(true);
    expect(prep.model).toBe(latestSonnet());
    expect(prep.domain).toBe("global");
    expect(prep.env?.BRAIN_API_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/brains\/work\/curator\/[A-Za-z0-9_-]{20,}\/api\/v1$/);
    expect(readRuns("work")[0]).toMatchObject({ status: "running", pending: 2, trigger: "manual" });

    // The pass works through the proxy while the run lasts.
    setChildPort("work", 45999);
    const path = new URL(prep.env!.BRAIN_API_URL).pathname;
    const fetchChild = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const deps = { supervisor: { waitRunning: async () => true }, fetch: fetchChild };
    const live = await handleBrainProxy(new Request(`http://127.0.0.1${path}/inbox/notes`), "127.0.0.1", deps);
    expect(live?.status).toBe(200);

    // The agent opens its own run and decides.
    state.runs.push({ run_id: "2099-01-01", created_at: new Date().toISOString(), counts: { accepted: 1, rejected: 1, undecided: 0 } });
    agentCommits();
    e.sessionId = "s1";
    const out = await svc.settle(agent, e, { success: true, subtype: "success" }, okResult);
    expect(out).toEqual({ success: true, subtype: "success" });
    const run = readRuns("work").at(-1)!;
    expect(run).toMatchObject({ status: "success", sessionId: "s1", costUsd: 0.42, tokens: { input: 150, output: 50 }, decided: { accepted: 1, rejected: 1, undecided: 0 } });
    expect(run.commit).toBe(sh(wiki, "rev-parse", "--short", "HEAD"));
    expect(existsSync(join(wiki, "concepts", "new.md"))).toBe(true);
    // The whole wiki is linted again after the sync (the agent could only lint against the old wiki).
    expect(run.lint).toEqual({ errors: 0, warnings: 2 });

    // After the run the pass is dead.
    const dead = await handleBrainProxy(new Request(`http://127.0.0.1${path}/inbox/notes`), "127.0.0.1", deps);
    expect(dead?.status).toBe(401);
    expect(svc.view("work")?.lastSuccessAt).toBe(run.finishedAt);
  });

  it("marks a run 'not synced' when the wiki changed by hand, refuses to reset that commit away, and Retry sync brings it in", async () => {
    const { svc, agent } = track(setup({ pending: 1 }));
    const e = exec();
    await svc.prepare(agent, e);
    agentCommits();
    // Meanwhile someone commits in the wiki: no fast-forward possible.
    writeFileSync(join(wiki, "index.md"), "# Index\nby hand\n");
    sh(wiki, "commit", "-q", "-am", "by hand");
    const out = await svc.settle(agent, e, { success: true });
    expect(out.success).toBe(false);
    const run = readRuns("work").at(-1)!;
    expect(run.status).toBe("not_synced");
    expect(run.error).toMatch(/Consolidated but not synced: git pull --ff-only/);
    expect(out.error).toBe(run.error);

    expect(run.error).not.toMatch(/hint:/);

    // The next run does not start: the old commit is not in the wiki yet. The
    // refusal leaves the wiki as it is (new sources stay uncommitted).
    mkdirSync(join(wiki, "raw", "sources"), { recursive: true });
    writeFileSync(join(wiki, "raw", "sources", "late.md"), "# Late\n");
    await expect(svc.prepare(agent, exec())).rejects.toThrow(/previous consolidation is not in the wiki yet/);
    expect(existsSync(join(curatorDir("work"), "concepts", "new.md"))).toBe(true);
    expect(sh(wiki, "log", "-1", "--format=%s")).toBe("by hand");
    expect(sh(wiki, "status", "--porcelain", "--untracked-files=all")).toContain("raw/sources/late.md");

    // The user undoes the hand edit; Retry sync brings the commit in.
    sh(wiki, "reset", "-q", "--hard", "HEAD~1");
    const retry = await svc.retrySync("work");
    expect(retry).toMatchObject({ ok: true, run: { status: "success" } });
    expect(existsSync(join(wiki, "concepts", "new.md"))).toBe(true);
    expect(await svc.retrySync("work")).toMatchObject({ ok: true, run: { status: "success", error: expect.stringMatching(/Nothing to sync/) } });
  });

  it("marks 'no commit' when notes waited and the agent committed nothing", async () => {
    const { svc, agent } = track(setup({ pending: 2 }));
    const e = exec();
    await svc.prepare(agent, e);
    writeFileSync(join(curatorDir("work"), "draft.md"), "x\n");
    const out = await svc.settle(agent, e, { success: true });
    expect(out.success).toBe(false);
    expect(readRuns("work").at(-1)).toMatchObject({ status: "no_commit", error: expect.stringMatching(/no commit, with 2 notes waiting \(it left uncommitted changes/) });
  });

  it("counts a run without notes and without commit as a success (nothing to do)", async () => {
    const { svc, agent } = track(setup({ pending: 0 }));
    const e = exec();
    await svc.prepare(agent, e);
    expect(await svc.settle(agent, e, { success: true })).toEqual({ success: true });
    expect(readRuns("work").at(-1)?.status).toBe("success");
  });

  it("marks 'not synced' when the brain cannot reload the wiki", async () => {
    const { svc, agent } = track(setup({ pending: 1, refreshFails: true }));
    const e = exec();
    await svc.prepare(agent, e);
    agentCommits();
    await svc.settle(agent, e, { success: true });
    expect(readRuns("work").at(-1)).toMatchObject({ status: "not_synced", error: expect.stringMatching(/did not reload/) });
  });

  it("records a failed run as an error (decisions unknown when the brain does not list its runs)", async () => {
    const { svc, agent } = track(setup({ pending: 1, runsFail: true }));
    const e = exec();
    await svc.prepare(agent, e);
    const out = await svc.settle(agent, e, { success: false, error: "CLI exited" });
    expect(out).toEqual({ success: false, error: "CLI exited" });
    expect(readRuns("work").at(-1)).toMatchObject({ status: "error", error: "CLI exited" });
    expect(readRuns("work").at(-1)?.decided).toBeUndefined();
    // An execution the service never prepared is left as it is.
    expect(await svc.settle(agent, exec(), { success: true })).toEqual({ success: true });
  });

  it("refuses a wiki folder that is not a git repository, and the run is recorded as an error", async () => {
    const { svc, agent } = track(setup({ pending: 1 }));
    rmSync(join(wiki, ".git"), { recursive: true, force: true });
    const e = exec();
    await expect(svc.prepare(agent, e)).rejects.toThrow(/not a git repository/);
    await svc.settle(agent, e, { success: false, error: "prepare failed" });
    expect(readRuns("work").at(-1)).toMatchObject({ status: "error" });
    expect(await svc.retrySync("work")).toMatchObject({ ok: false, status: 409 });
  });

  it("re-clones a curator folder that is not a clone, and resets a dirty clone", async () => {
    const { svc, agent } = track(setup({ pending: 1 }));
    mkdirSync(curatorDir("work"), { recursive: true });
    writeFileSync(join(curatorDir("work"), "junk"), "x");
    await svc.prepare(agent, exec());
    expect(existsSync(join(curatorDir("work"), "junk"))).toBe(false);
    expect(existsSync(join(curatorDir("work"), "SCHEMA.md"))).toBe(true);
    writeFileSync(join(curatorDir("work"), "index.md"), "dirty\n");
    writeFileSync(join(curatorDir("work"), "untracked.md"), "x\n");
    await svc.prepare(agent, exec());
    expect(readFileSync(join(curatorDir("work"), "index.md"), "utf8")).toBe("# Index\n");
    expect(existsSync(join(curatorDir("work"), "untracked.md"))).toBe(false);
  });
});

describe("remote brains and removal", () => {
  function remote() {
    createRemoteBrain({ name: "Jarvis", baseUrl: "http://100.1.1.1:7421" });
    return agentStore.createAgent({ version: 1, name: "jarvis-wiki-consolidation", description: "", backendType: "claude", model: "claude-opus-5-5", permissionMode: "bypassPermissions", cwd: "/x", prompt: "own prompt", enabled: true, triggers: { schedule: { enabled: true, expression: "0 5 * * *", recurring: true } } });
  }

  it("links an existing agent without touching its prompt or schedule, and lists its runs", () => {
    const linked = remote();
    const executions: AgentExecution[] = [
      { sessionId: "s1", agentId: linked.id, triggerType: "schedule", startedAt: 10, completedAt: 20, success: true },
      { sessionId: "s2", agentId: linked.id, triggerType: "manual", startedAt: 30, completedAt: 40, success: false, error: "boom" },
      { sessionId: "", agentId: linked.id, triggerType: "manual", startedAt: 50 },
    ];
    const svc = new BrainConsolidation({ executor: fakeExecutor({ listAllExecutions: vi.fn(() => ({ executions, total: 3 })) }) });
    expect(svc.linkAgent("jarvis", linked.id)).toMatchObject({ ok: true });
    const after = agentStore.getAgent(linked.id)!;
    expect(after).toMatchObject({ brainRole: { slug: "jarvis", role: "consolidation" }, prompt: "own prompt", triggers: { schedule: { enabled: true } } });
    // Companion adds no step to its runs.
    expect(svc.appliesTo(after)).toBe(false);
    const view = svc.view("jarvis")!;
    expect(view.agent?.id).toBe(linked.id);
    expect(view.runs.map((r) => r.status)).toEqual(["running", "error", "success"]);
    expect(view.lastSuccessAt).toBe(20);
    expect(view.resolvedModel).toBe("claude-opus-5-5");

    expect(svc.linkAgent("jarvis", null)).toMatchObject({ ok: true });
    expect(agentStore.getAgent(linked.id)?.brainRole).toBeUndefined();
  });

  it("refuses unknown agents, agents of another brain and embedded brains", () => {
    const linked = remote();
    createRemoteBrain({ name: "Team", baseUrl: "http://100.1.1.2:7421" });
    const svc = new BrainConsolidation({ executor: fakeExecutor() });
    expect(svc.linkAgent("jarvis", "missing")).toMatchObject({ ok: false, status: 404 });
    svc.linkAgent("team", linked.id);
    expect(svc.linkAgent("jarvis", linked.id)).toMatchObject({ ok: false, status: 409 });
    expect(svc.linkAgent("nope", null)).toMatchObject({ ok: false, status: 404 });
    createEmbeddedBrain({ name: "Work", wikiDir: wiki });
    expect(svc.linkAgent("work", linked.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("forget: deletes the agent Companion made, only unlinks a linked one", () => {
    const { svc, agent } = track(setup());
    svc.forget(getBrain("work")!);
    expect(agentStore.getAgent(agent.id)).toBeNull();
    expect(svc.view("work")?.nextRunAt).toBeNull();
    const linked = remote();
    svc.linkAgent("jarvis", linked.id);
    svc.forget(getBrain("jarvis")!);
    expect(agentStore.getAgent(linked.id)).toMatchObject({ id: linked.id });
    expect(agentStore.getAgent(linked.id)?.brainRole).toBeUndefined();
    svc.forget(getBrain("jarvis")!); // nothing linked: no-op
  });

  // A restart kills the CLIs: a run left "running" on disk can never finish.
  it("closes the runs a restart interrupted", () => {
    const { svc } = track(setup());
    saveRun("work", { id: "r", trigger: "schedule", status: "running", startedAt: 5 });
    svc.startAll();
    expect(readRuns("work").at(-1)).toMatchObject({ status: "error", error: expect.stringMatching(/Interrupted/) });
  });

  it("re-arms crons at startup and after a time zone change; a broken schedule is not armed", () => {
    const { svc } = track(setup());
    svc.stopAll();
    expect(svc.view("work")?.nextRunAt).toBeNull();
    svc.startAll();
    expect(svc.view("work")?.nextRunAt).not.toBeNull();
    svc.rescheduleAll();
    expect(svc.view("work")?.nextRunAt).not.toBeNull();
    // A hand-edited brain.json with an invalid cron: logged, not armed.
    const file = join(h.home, "brains", "work", "brain.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    json.consolidation.schedule = "not a cron";
    writeFileSync(file, JSON.stringify(json));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    svc.schedule("work");
    expect(svc.view("work")?.nextRunAt).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the run hooks' scope", () => {
  it("applies to the consolidation agents of embedded brains only", () => {
    const { svc, agent } = track(setup());
    expect(svc.appliesTo(agent)).toBe(true);
    expect(svc.appliesTo({ ...agent, brainRole: undefined })).toBe(false);
    expect(svc.appliesTo({ ...agent, brainRole: { slug: "gone", role: "consolidation" } })).toBe(false);
  });

  it("a run started from the Agents page records its own trigger and counts the notes itself", async () => {
    const { svc, agent } = track(setup({ pending: 4 }));
    await svc.prepare(agent, exec({ triggerType: "webhook" }));
    expect(readRuns("work").at(-1)).toMatchObject({ trigger: "webhook", pending: 4, backend: "claude" });
  });
});
