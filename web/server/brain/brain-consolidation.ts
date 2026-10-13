import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import type { AgentConfig, AgentExecution } from "../agent-types.js";
import type { AgentRunHooks, RunOutcome, RunPreparation, StartRunResult } from "../agent-executor.js";
import type { CLIResultMessage } from "../session-types.js";
import * as agentStore from "../agent-store.js";
import { scheduleTimeZone } from "../agent-schedule.js";
import { writePrivateFile } from "../private-file.js";
import {
  brainDir,
  consolidationOf,
  getBrain,
  listBrains,
  updateConsolidation,
  type BrainConfig,
  type BrainResult,
  type ConsolidationConfig,
  type ConsolidationPatch,
} from "./brain-store.js";
import { CuratorError, curatorFetch } from "./brain-curator.js";
import { gitAuthor, runGit, type GitRun } from "./brain-git.js";
import { curatorPassUrl, issueCuratorPass, revokeCuratorPass } from "./brain-proxy.js";
import {
  consolidationAgentFields,
  consolidationAgentName,
  consolidationDomain,
  curatorDir,
  resolveConsolidationModel,
} from "./consolidation-template.js";

/**
 * Consolidation of embedded brains, driven by Companion (not by the model):
 *
 * TRIGGERS (deterministic). The brain's cron (Companion's time zone); a
 * health tick that sees `threshold` or more pending notes when the last run
 * is older than 6 h; the first health tick after Companion starts when notes
 * are pending and the last run is older than 24 h ("catch-up"); "Consolidate
 * now". Each trigger first counts the pending notes through the curator API:
 * none, and the run is recorded as "skipped" without starting a session.
 * Never two runs at once (the agent executor's own overlap check, plus a
 * guard while the count is read).
 *
 * BEFORE A RUN (AgentRunHooks.prepare, also for runs started from the Agents
 * page): files that "Add source" left uncommitted under raw/sources/ are
 * committed in the wiki folder; the curator clone (brains/<slug>/curator) is
 * cloned or fetched and reset to the wiki's branch; a commit of an earlier
 * run that never reached the wiki is synced first (a run never resets it
 * away); the agent gets BRAIN_API_URL, the curator API behind a pass valid
 * for this run only (brain-proxy.ts); its model is resolved now (the latest
 * Sonnet of the catalog by default).
 *
 * AFTER A RUN (AgentRunHooks.settle): the run counts as a success only when
 * the clone is ahead of the wiki, `git pull --ff-only <clone> <branch>` in
 * the wiki folder succeeds and the brain reloads it. Otherwise "not_synced"
 * (with git's message: the wiki was edited by hand, for example) or
 * "no_commit" (notes were waiting and the agent committed nothing).
 *
 * Runs are recorded in brains/<slug>/reports/runs.jsonl (the last 50).
 */

export type ConsolidationRunStatus = "running" | "success" | "skipped" | "not_synced" | "no_commit" | "error";
export type ConsolidationTrigger = "schedule" | "manual" | "threshold" | "catch-up" | "webhook" | "linear";

export interface ConsolidationRun {
  id: string;
  trigger: ConsolidationTrigger;
  status: ConsolidationRunStatus;
  startedAt: number;
  finishedAt?: number;
  /** Notes waiting when the run was asked for. */
  pending?: number;
  sessionId?: string;
  backend?: "claude" | "codex";
  model?: string;
  /** Decisions recorded by the brain's consolidation runs during this run. */
  decided?: Record<string, number>;
  /** The agent's commit (short id), when it made one. */
  commit?: string;
  costUsd?: number;
  tokens?: { input: number; output: number };
  /** Why it was skipped, not synced or failed. */
  error?: string;
}

const MAX_RUNS = 50;
const HOUR = 3_600_000;
export const THRESHOLD_MIN_GAP_MS = 6 * HOUR;
export const CATCH_UP_AFTER_MS = 24 * HOUR;

// ── Run records ─────────────────────────────────────────────────────────────

function runsPath(slug: string): string {
  return join(brainDir(slug), "reports", "runs.jsonl");
}

/** The recorded runs of a brain, oldest first. */
export function readRuns(slug: string): ConsolidationRun[] {
  let text: string;
  try {
    text = readFileSync(runsPath(slug), "utf-8");
  } catch {
    return [];
  }
  const runs: ConsolidationRun[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ConsolidationRun;
      if (r && typeof r.id === "string" && typeof r.startedAt === "number") runs.push(r);
    } catch {
      /* a torn line */
    }
  }
  return runs;
}

/** Insert or replace a run (by id), keeping the last 50. */
export function saveRun(slug: string, run: ConsolidationRun): void {
  const runs = readRuns(slug).filter((r) => r.id !== run.id);
  runs.push(run);
  runs.sort((a, b) => a.startedAt - b.startedAt);
  const path = runsPath(slug);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFile(path, `${runs.slice(-MAX_RUNS).map((r) => JSON.stringify(r)).join("\n")}\n`);
}

/** When the last real attempt started (skipped runs do not count): what the threshold and catch-up compare to. */
export function lastAttemptAt(runs: ConsolidationRun[]): number {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status !== "skipped") return runs[i].startedAt;
  return 0;
}

/** When the wiki last received a consolidation (a successful run). */
export function lastSuccessAt(runs: ConsolidationRun[]): number | undefined {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status === "success") return runs[i].finishedAt ?? runs[i].startedAt;
  return undefined;
}

// ── git ─────────────────────────────────────────────────────────────────────

class GitError extends Error {}

/** git's own message, without its "hint:" lines. */
function gitMessage(r: GitRun): string {
  const raw = r.stderr.trim() || r.stdout.trim() || (r.missing ? "git is not installed" : `git exited with code ${r.code}`);
  const text = raw.split("\n").filter((l) => !l.startsWith("hint:")).join("\n").trim() || raw;
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

/** git in `cwd`; throws GitError with git's message when it fails. */
async function git(args: string[], cwd: string, what: string, timeoutMs = 60_000): Promise<string> {
  const r = await runGit(args, cwd, timeoutMs);
  if (r.code !== 0) throw new GitError(`${what}: ${gitMessage(r)}`);
  return r.stdout.trim();
}

/** The branch checked out in the wiki folder; throws when it is not a git work tree on a branch. */
async function wikiBranch(wikiDir: string): Promise<string> {
  const r = await runGit(["symbolic-ref", "--short", "HEAD"], wikiDir, 10_000);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new GitError(`The wiki folder ${wikiDir} is not a git repository on a branch: consolidation needs git there (run "git init -b main" and commit the wiki)`);
  }
  return r.stdout.trim();
}

/** Commit what "Add source" wrote under raw/sources/ and nobody committed yet (only those paths). */
async function commitPendingSources(wikiDir: string): Promise<number> {
  if (!existsSync(join(wikiDir, "raw", "sources"))) return 0;
  const status = await git(["status", "--porcelain", "--untracked-files=all", "--", "raw/sources"], wikiDir, "Could not read the wiki's git status");
  const files = status.split("\n").filter(Boolean).length;
  if (!files) return 0;
  const who = await gitAuthor();
  await git(["add", "--", "raw/sources"], wikiDir, "Could not stage the new sources");
  await git(["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "commit", "-q", "-m", `sources: ${files} added from Companion`, "--", "raw/sources"], wikiDir, "Could not commit the new sources");
  return files;
}

/** Commits of the clone that the wiki's branch does not have yet (after a fetch). */
async function commitsAhead(dir: string, branch: string): Promise<number> {
  await git(["fetch", "-q", "origin", branch], dir, "Could not fetch the wiki into the curator clone");
  return Number(await git(["rev-list", "--count", `origin/${branch}..HEAD`], dir, "Could not compare the curator clone with the wiki")) || 0;
}

/** Clone the wiki into the curator folder (a fresh one when missing or not a clone), with a commit identity. */
async function ensureClone(wikiDir: string, dir: string, branch: string): Promise<void> {
  if (existsSync(join(dir, ".git"))) return;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  await git(["clone", "-q", "--branch", branch, wikiDir, dir], dirname(dir), "Could not clone the wiki");
  const who = await gitAuthor();
  await git(["config", "user.name", who.name], dir, "Could not configure the clone");
  await git(["config", "user.email", who.email], dir, "Could not configure the clone");
}

// ── The service ─────────────────────────────────────────────────────────────

/** The executor operations the service uses (a fake in tests). */
export interface ConsolidationExecutor {
  startRun(agentId: string, input?: string, opts?: { ignoreEnabled?: boolean; triggerType?: AgentExecution["triggerType"] }): StartRunResult;
  isRunInProgress(agentId: string): boolean;
  runSessionOf(agentId: string): string | undefined;
  listAllExecutions(opts?: { agentId?: string; limit?: number }): { executions: AgentExecution[]; total: number };
}

export type CuratorCall = <T>(slug: string, path: string, opts?: { method?: "GET" | "POST"; body?: unknown }) => Promise<T>;

export interface ConsolidationDeps {
  executor: ConsolidationExecutor;
  /** The brain's curator API (default: curatorFetch with the brain's key). */
  curator?: CuratorCall;
  now?: () => number;
}

/** A run being prepared or running, by its execution. */
interface ActiveRun {
  slug: string;
  run: ConsolidationRun;
  pass?: string;
  wikiDir: string;
  branch?: string;
  /** The brain's consolidation runs that existed before this run (its own are the others). */
  coreRunsBefore?: Set<string>;
}

export type TriggerResult = { ok: true; started: boolean; run?: ConsolidationRun } | { ok: false; status: 404 | 409; error: string };

/** What the brain's page shows of its consolidation. */
export interface ConsolidationView {
  config: ConsolidationConfig;
  agent: { id: string; name: string; backendType: "claude" | "codex"; model: string; enabled: boolean } | null;
  /** The model the next run would use ("latest Sonnet" resolved now); null when the CLI picks. */
  resolvedModel: string | null;
  running: boolean;
  runningSessionId?: string;
  nextRunAt: number | null;
  lastSuccessAt?: number;
  /** Embedded brains: recorded runs, newest first. Remote brains: the linked agent's runs. */
  runs: ConsolidationRun[];
  /** The domain runs work in. */
  domain: string;
}

let instance: BrainConsolidation | undefined;

/** The service of this server (wired in server/index.ts with the agent executor). */
export function setBrainConsolidation(service: BrainConsolidation | undefined): void {
  instance = service;
}

export function getBrainConsolidation(): BrainConsolidation | undefined {
  return instance;
}

export class BrainConsolidation implements AgentRunHooks {
  private executor: ConsolidationExecutor;
  private curator: CuratorCall;
  private now: () => number;
  private timers = new Map<string, Cron>();
  /** Brains whose pending notes are being counted before a run (the overlap guard). */
  private starting = new Set<string>();
  /** What the next prepare of a brain's agent was triggered by (set just before startRun). */
  private nextTrigger = new Map<string, { trigger: ConsolidationTrigger; pending: number }>();
  private active = new Map<AgentExecution, ActiveRun>();
  /** Brains that had a health tick since startup: the first one may catch up. */
  private seen = new Set<string>();

  constructor(deps: ConsolidationDeps) {
    this.executor = deps.executor;
    this.curator = deps.curator ?? ((slug, path, opts) => curatorFetch(slug, path, opts));
    this.now = deps.now ?? Date.now;
  }

  // ── Agent ────────────────────────────────────────────────────────────────

  /** The brain's consolidation agent: the one recorded, else any agent with this brain's role. */
  agentOf(brain: Pick<BrainConfig, "slug" | "consolidation">): AgentConfig | null {
    const id = brain.consolidation?.agentId;
    const byId = id ? agentStore.getAgent(id) : null;
    if (byId?.brainRole?.slug === brain.slug) return byId;
    return agentStore.listAgents().find((a) => a.brainRole?.slug === brain.slug && a.brainRole.role === "consolidation") ?? null;
  }

  /**
   * Change an embedded brain's consolidation settings and bring its agent in
   * line with them: created from the template the first time it is turned
   * on, rewritten afterwards (prompt, backend, folder, domain, enabled).
   */
  configure(slug: string, patch: ConsolidationPatch): BrainResult {
    const brain = getBrain(slug);
    if (!brain) return { ok: false, status: 404, error: "Brain not found" };
    if (brain.kind !== "embedded") return { ok: false, status: 409, error: "A remote brain is consolidated by its own agent: link it instead" };
    const { agentId: _ignored, ...rest } = patch;
    const updated = updateConsolidation(slug, rest);
    if (!updated.ok) return updated;
    const c = consolidationOf(updated.brain);
    const fields = consolidationAgentFields(updated.brain, c);
    let agent = this.agentOf(updated.brain);
    try {
      if (agent) agent = agentStore.updateAgent(agent.id, fields);
      else if (c.enabled) agent = this.createAgent(updated.brain, fields);
    } catch (err) {
      return { ok: false, status: 409, error: `Could not save the consolidation agent: ${(err as Error).message}` };
    }
    const result = agent && agent.id !== c.agentId ? updateConsolidation(slug, { agentId: agent.id }) : updated;
    this.schedule(slug);
    return result;
  }

  /** A new agent named after the brain ("<name> brain consolidation", then " 2", " 3"... when taken). */
  private createAgent(brain: BrainConfig, fields: ReturnType<typeof consolidationAgentFields>): AgentConfig {
    const base = consolidationAgentName(brain);
    let lastError: unknown;
    for (let i = 1; i <= 20; i++) {
      try {
        return agentStore.createAgent({ version: 1, name: i === 1 ? base : `${base} ${i}`, ...fields });
      } catch (err) {
        lastError = err;
        if (!/already exists/.test((err as Error).message)) break;
      }
    }
    throw lastError;
  }

  /**
   * A remote brain: link an existing agent as its consolidation agent (or
   * unlink with null). Only its brainRole changes; its prompt, schedule and
   * mode stay as they are, and Companion adds no step to its runs.
   */
  linkAgent(slug: string, agentId: string | null): BrainResult {
    const brain = getBrain(slug);
    if (!brain) return { ok: false, status: 404, error: "Brain not found" };
    if (brain.kind !== "remote") return { ok: false, status: 409, error: "An embedded brain's agent is made by Companion: turn consolidation on instead" };
    const next = agentId ? agentStore.getAgent(agentId) : null;
    if (agentId && !next) return { ok: false, status: 404, error: "Agent not found" };
    if (next?.brainRole && next.brainRole.slug !== slug) {
      return { ok: false, status: 409, error: `The agent already consolidates the brain "${next.brainRole.slug}"` };
    }
    const prev = this.agentOf(brain);
    if (prev && prev.id !== next?.id) agentStore.updateAgent(prev.id, { brainRole: undefined });
    if (next) agentStore.updateAgent(next.id, { brainRole: { slug, role: "consolidation" } });
    return updateConsolidation(slug, { agentId: next?.id ?? null });
  }

  /** The Consolidation tab's data. */
  view(slug: string): ConsolidationView | null {
    const brain = getBrain(slug);
    if (!brain) return null;
    const config = consolidationOf(brain);
    const agent = this.agentOf(brain);
    const sessionId = agent ? this.executor.runSessionOf(agent.id) : undefined;
    const running = this.starting.has(slug) || (agent ? this.executor.isRunInProgress(agent.id) : false);
    const runs = brain.kind === "embedded" ? readRuns(slug) : this.remoteRuns(agent);
    return {
      config,
      agent: agent ? { id: agent.id, name: agent.name, backendType: agent.backendType, model: agent.model, enabled: agent.enabled } : null,
      resolvedModel: (brain.kind === "embedded" ? resolveConsolidationModel(config) : agent?.model) || null,
      running,
      ...(sessionId ? { runningSessionId: sessionId } : {}),
      nextRunAt: this.timers.get(slug)?.nextRun()?.getTime() ?? null,
      ...(lastSuccessAt(runs) !== undefined ? { lastSuccessAt: lastSuccessAt(runs) } : {}),
      runs: [...runs].reverse(),
      domain: brain.kind === "embedded" ? consolidationDomain(slug) : agent?.domain ?? "global",
    };
  }

  /** A linked agent's runs, in the shape of ours (no post-sync for remote brains). */
  private remoteRuns(agent: AgentConfig | null): ConsolidationRun[] {
    if (!agent) return [];
    return this.executor
      .listAllExecutions({ agentId: agent.id, limit: 20 })
      .executions.map((e) => ({
        id: e.sessionId || `run-${e.startedAt}`,
        trigger: e.triggerType,
        status: !e.completedAt ? "running" : e.success ? "success" : "error",
        startedAt: e.startedAt,
        ...(e.completedAt ? { finishedAt: e.completedAt } : {}),
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(e.error ? { error: e.error } : {}),
      }) satisfies ConsolidationRun)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  // ── Triggers ─────────────────────────────────────────────────────────────

  /**
   * At startup: close the runs a restart interrupted (a new server has no run
   * in progress; the CLIs died with the old one), and arm the cron of every
   * embedded brain with consolidation on.
   */
  startAll(): void {
    for (const b of listBrains()) {
      if (this.active.size === 0) this.closeInterrupted(b.slug);
      this.schedule(b.slug);
    }
  }

  private closeInterrupted(slug: string): void {
    for (const r of readRuns(slug)) {
      if (r.status !== "running") continue;
      saveRun(slug, { ...r, status: "error", finishedAt: r.finishedAt ?? this.now(), error: "Interrupted: Companion restarted before the run finished" });
    }
  }

  /** Re-arm every cron (the time zone setting changed). */
  rescheduleAll(): void {
    for (const b of listBrains()) this.schedule(b.slug);
  }

  /** (Re)arm a brain's cron, or disarm it when consolidation is off or the brain is gone. */
  schedule(slug: string): void {
    this.timers.get(slug)?.stop();
    this.timers.delete(slug);
    const brain = getBrain(slug);
    const c = brain ? consolidationOf(brain) : undefined;
    if (brain?.kind !== "embedded" || !c?.enabled) return;
    try {
      this.timers.set(slug, new Cron(c.schedule, { mode: "5-part", timezone: scheduleTimeZone() }, () => {
        void this.trigger(slug, "schedule").catch((err: unknown) => console.warn(`[brain-consolidation] ${slug}: scheduled run failed:`, err));
      }));
    } catch (err) {
      console.warn(`[brain-consolidation] ${slug}: schedule "${c.schedule}" not armed:`, err);
    }
  }

  /**
   * Before a brain is deleted: its cron stops; the agent Companion made for
   * an embedded brain is deleted, an agent linked to a remote brain is only
   * unlinked.
   */
  forget(brain: BrainConfig): void {
    this.timers.get(brain.slug)?.stop();
    this.timers.delete(brain.slug);
    const agent = this.agentOf(brain);
    if (!agent) return;
    if (brain.kind === "embedded") agentStore.deleteAgent(agent.id);
    else agentStore.updateAgent(agent.id, { brainRole: undefined });
  }

  stopAll(): void {
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
  }

  /**
   * A health tick of an embedded brain with its inbox counts: the catch-up
   * (first tick since startup, notes pending, last attempt over 24 h ago) or
   * the threshold (that many pending notes, last attempt over 6 h ago).
   */
  onHealth(slug: string, inbox: Record<string, number> | undefined): void {
    const first = !this.seen.has(slug);
    this.seen.add(slug);
    if (!inbox) return;
    const brain = getBrain(slug);
    if (brain?.kind !== "embedded") return;
    const c = consolidationOf(brain);
    if (!c.enabled) return;
    const pending = inbox.pending ?? 0;
    const since = this.now() - lastAttemptAt(readRuns(slug));
    let trigger: ConsolidationTrigger | null = null;
    if (first && pending > 0 && since > CATCH_UP_AFTER_MS) trigger = "catch-up";
    else if (pending >= c.threshold && since > THRESHOLD_MIN_GAP_MS) trigger = "threshold";
    if (!trigger) return;
    void this.trigger(slug, trigger).catch((err: unknown) => console.warn(`[brain-consolidation] ${slug}: ${trigger} run failed:`, err));
  }

  /**
   * Ask for a run: refused while one is in progress; skipped (recorded, no
   * session) when no note is waiting; otherwise the agent starts.
   */
  async trigger(slug: string, trigger: ConsolidationTrigger): Promise<TriggerResult> {
    const brain = getBrain(slug);
    if (brain?.kind !== "embedded") return { ok: false, status: 404, error: "No embedded brain with this name" };
    const agent = this.agentOf(brain);
    if (!agent) return { ok: false, status: 409, error: "Turn consolidation on first: it creates the consolidation agent" };
    if (this.starting.has(slug) || this.executor.isRunInProgress(agent.id)) {
      return { ok: false, status: 409, error: "A consolidation run is already in progress" };
    }
    this.starting.add(slug);
    try {
      let pending: number;
      try {
        pending = await this.countPending(slug);
      } catch (err) {
        const run = this.record(slug, { trigger, status: "error", error: `Could not count the waiting notes: ${(err as Error).message}`, finishedAt: this.now() });
        return { ok: true, started: false, run };
      }
      if (pending === 0) {
        const run = this.record(slug, { trigger, status: "skipped", pending, error: "No note waiting", finishedAt: this.now() });
        return { ok: true, started: false, run };
      }
      this.nextTrigger.set(slug, { trigger, pending });
      const started = this.executor.startRun(agent.id, undefined, {
        ignoreEnabled: true,
        triggerType: trigger === "manual" ? "manual" : "schedule",
      });
      if (!started.ok) {
        this.nextTrigger.delete(slug);
        return started;
      }
      return { ok: true, started: true };
    } finally {
      this.starting.delete(slug);
    }
  }

  private async countPending(slug: string): Promise<number> {
    const r = await this.curator<{ counts?: Record<string, number> }>(slug, "/inbox/notes?status=pending&limit=1");
    return r.counts?.pending ?? 0;
  }

  private record(slug: string, fields: Omit<ConsolidationRun, "id" | "startedAt"> & { startedAt?: number }): ConsolidationRun {
    const run: ConsolidationRun = { id: randomBytes(6).toString("hex"), startedAt: this.now(), ...fields };
    saveRun(slug, run);
    return run;
  }

  // ── Run hooks (AgentRunHooks) ────────────────────────────────────────────

  /** Only the consolidation agents of embedded brains: a linked remote agent runs as it is. */
  appliesTo(agent: AgentConfig): boolean {
    const slug = agent.brainRole?.role === "consolidation" ? agent.brainRole.slug : undefined;
    return !!slug && getBrain(slug)?.kind === "embedded";
  }

  async prepare(agent: AgentConfig, exec: AgentExecution): Promise<RunPreparation> {
    const slug = agent.brainRole!.slug;
    const brain = getBrain(slug)!;
    const c = consolidationOf(brain);
    const asked = this.nextTrigger.get(slug);
    this.nextTrigger.delete(slug);
    const model = agent.backendType === c.backend ? resolveConsolidationModel(c) : agent.model || undefined;
    const run: ConsolidationRun = {
      id: randomBytes(6).toString("hex"),
      trigger: asked?.trigger ?? exec.triggerType,
      status: "running",
      startedAt: exec.startedAt,
      ...(asked ? { pending: asked.pending } : {}),
      backend: agent.backendType,
      ...(model ? { model } : {}),
    };
    const active: ActiveRun = { slug, run, wikiDir: brain.embedded!.wikiDir };
    this.active.set(exec, active);
    saveRun(slug, run);

    if (run.pending === undefined) run.pending = await this.countPending(slug);
    const dir = curatorDir(slug);
    active.branch = await wikiBranch(active.wikiDir);
    await ensureClone(active.wikiDir, dir, active.branch);
    // A commit of an earlier run that never reached the wiki: sync it now, never
    // reset it away. Checked before anything is committed in the wiki, so a
    // refused run leaves the wiki as it was.
    if (await commitsAhead(dir, active.branch)) {
      const sync = await this.syncIntoWiki(slug, dir, active.wikiDir, active.branch);
      if (!sync.ok) throw new Error(`The previous consolidation is not in the wiki yet, so this run did not start: ${sync.error}`);
    }
    await commitPendingSources(active.wikiDir);
    active.coreRunsBefore = await this.coreRunIds(slug);
    await git(["fetch", "-q", "origin", active.branch], dir, "Could not fetch the wiki into the curator clone");
    await git(["checkout", "-q", "-f", "-B", active.branch, `origin/${active.branch}`], dir, "Could not reset the curator clone");
    await git(["clean", "-q", "-fd"], dir, "Could not clean the curator clone");
    active.pass = issueCuratorPass(slug);
    saveRun(slug, run);
    return { env: { BRAIN_API_URL: curatorPassUrl(slug, active.pass) }, ...(model ? { model } : {}), domain: consolidationDomain(slug) };
  }

  async settle(_agent: AgentConfig, exec: AgentExecution, outcome: RunOutcome, result?: CLIResultMessage): Promise<RunOutcome> {
    const active = this.active.get(exec);
    if (!active) return outcome;
    this.active.delete(exec);
    revokeCuratorPass(active.pass);
    const { slug, run } = active;
    run.finishedAt = this.now();
    if (exec.sessionId) run.sessionId = exec.sessionId;
    if (result) {
      if (result.total_cost_usd > 0) run.costUsd = result.total_cost_usd;
      const u = result.usage;
      if (u && (u.input_tokens || u.output_tokens)) {
        run.tokens = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
      }
    }
    try {
      if (active.coreRunsBefore) run.decided = await this.decidedSince(slug, active.coreRunsBefore);
      if (!outcome.success) {
        run.status = "error";
        run.error = outcome.error ?? "The run failed";
      } else {
        await this.verify(active);
      }
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
    }
    saveRun(slug, run);
    if (run.status === "success") return outcome;
    return { ...outcome, success: false, error: run.error ?? outcome.error };
  }

  /** Post-sync of a finished run: commit made, fast-forwarded into the wiki, brain reloaded. */
  private async verify(active: ActiveRun): Promise<void> {
    const { slug, run, wikiDir } = active;
    const branch = active.branch!;
    const dir = curatorDir(slug);
    const ahead = await commitsAhead(dir, branch);
    if (!ahead) {
      const dirty = (await git(["status", "--porcelain"], dir, "Could not read the curator clone's status")).length > 0;
      if (run.pending) {
        run.status = "no_commit";
        run.error = `The agent made no commit, with ${run.pending} note${run.pending === 1 ? "" : "s"} waiting${dirty ? " (it left uncommitted changes in the curator clone)" : ""}`;
      } else {
        run.status = "success";
      }
      return;
    }
    run.commit = await git(["rev-parse", "--short", "HEAD"], dir, "Could not read the curator clone's commit");
    const sync = await this.syncIntoWiki(slug, dir, wikiDir, branch);
    run.status = sync.ok ? "success" : "not_synced";
    if (!sync.ok) run.error = sync.error;
  }

  /** `git pull --ff-only <clone> <branch>` in the wiki folder, then the brain reloads the wiki. */
  private async syncIntoWiki(slug: string, dir: string, wikiDir: string, branch: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const pull = await runGit(["pull", "-q", "--ff-only", dir, branch], wikiDir, 120_000);
    if (pull.code !== 0) {
      return { ok: false, error: `Consolidated but not synced: git pull --ff-only into ${wikiDir} failed (the wiki was probably changed by hand meanwhile): ${gitMessage(pull)}` };
    }
    try {
      await this.curator(slug, "/admin/refresh", { method: "POST", body: {} });
    } catch (err) {
      return { ok: false, error: `The wiki was updated, but the brain did not reload it: ${(err as Error).message}` };
    }
    return { ok: true };
  }

  /** "Retry sync" after a not-synced run: the clone's commits into the wiki, recorded as a run. */
  async retrySync(slug: string): Promise<{ ok: true; run: ConsolidationRun } | { ok: false; status: 404 | 409; error: string }> {
    const brain = getBrain(slug);
    if (brain?.kind !== "embedded") return { ok: false, status: 404, error: "No embedded brain with this name" };
    const agent = this.agentOf(brain);
    if (this.starting.has(slug) || (agent && this.executor.isRunInProgress(agent.id))) {
      return { ok: false, status: 409, error: "A consolidation run is in progress" };
    }
    const dir = curatorDir(slug);
    if (!existsSync(join(dir, ".git"))) return { ok: false, status: 409, error: "There is no curator clone yet: nothing to sync" };
    this.starting.add(slug);
    try {
      const wikiDir = brain.embedded!.wikiDir;
      const run: ConsolidationRun = { id: randomBytes(6).toString("hex"), trigger: "manual", status: "running", startedAt: this.now() };
      try {
        const branch = await wikiBranch(wikiDir);
        if (!(await commitsAhead(dir, branch))) {
          run.status = "success";
          run.error = "Nothing to sync: the wiki already has every consolidation";
        } else {
          run.commit = await git(["rev-parse", "--short", "HEAD"], dir, "Could not read the curator clone's commit");
          const sync = await this.syncIntoWiki(slug, dir, wikiDir, branch);
          run.status = sync.ok ? "success" : "not_synced";
          if (!sync.ok) run.error = sync.error;
        }
      } catch (err) {
        run.status = "error";
        run.error = (err as Error).message;
      }
      run.finishedAt = this.now();
      saveRun(slug, run);
      return { ok: true, run };
    } finally {
      this.starting.delete(slug);
    }
  }

  /** The ids of the brain's consolidation runs (the core's), or undefined when they cannot be read. */
  private async coreRunIds(slug: string): Promise<Set<string> | undefined> {
    try {
      const { runs } = await this.curator<{ runs: { run_id: string }[] }>(slug, "/consolidation/runs");
      return new Set(runs.map((r) => r.run_id));
    } catch {
      return undefined;
    }
  }

  /** The decisions recorded by the brain's consolidation runs opened during this run (summed). */
  private async decidedSince(slug: string, before: Set<string>): Promise<Record<string, number> | undefined> {
    try {
      const { runs } = await this.curator<{ runs: { run_id: string }[] }>(slug, "/consolidation/runs");
      const mine = runs.filter((r) => !before.has(r.run_id));
      if (!mine.length) return undefined;
      const total: Record<string, number> = {};
      for (const r of mine) {
        const view = await this.curator<{ counts: Record<string, number> }>(slug, `/consolidation/runs/${encodeURIComponent(r.run_id)}`);
        for (const [k, v] of Object.entries(view.counts ?? {})) total[k] = (total[k] ?? 0) + v;
      }
      return total;
    } catch (err) {
      if (err instanceof CuratorError) return undefined;
      throw err;
    }
  }
}
