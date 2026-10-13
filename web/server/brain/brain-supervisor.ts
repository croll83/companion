import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brainDataDir, brainDir, brainLogPath, brainServerName, getBrain, listBrains, type BrainConfig } from "./brain-store.js";
import { embeddedKeys, ensureEmbeddedSecret } from "./brain-token.js";
import { childBaseUrl, setChildPort } from "./brain-endpoints.js";
import { refreshBrainSkill } from "./brain-skill-fetch.js";

/**
 * Runs the embedded brains: one child process per brain, the bundle
 * dist/brain/brain.js under the Bun that runs Companion (process.execPath):
 *
 *   <bun> <package>/dist/brain/brain.js --brain-dir=<COMPANION_HOME/brains/slug>
 *
 * A child, not in-process: Companion hosts every session (KillMode=control-group),
 * so a stuck SQLite call or a crash of a brain must never take them down.
 *
 *  - Configuration through the environment (core/config.ts): the wiki folder,
 *    the data folder, the keys derived from the brain's secret, the names,
 *    BRAIN_PROTOCOL. The child listens on 127.0.0.1 on an ephemeral port and
 *    prints `{"brain_ready":true,"port":N,...}` on stdout.
 *  - stdout and stderr are always drained into brains/<slug>/logs/brain.log
 *    (size-capped, one rotation): a pipe left unread would block the child.
 *    stdin is a pipe Companion never writes: when Companion dies it closes,
 *    and the child exits (BRAIN_EXIT_WITH_PARENT).
 *  - Health: GET /healthz every 30 s; 3 failures in a row kill the child.
 *  - Crashes restart it with a backoff from 1 s to 60 s; 5 crashes within 10
 *    minutes put the brain in `failed`, with a cause and an action for the
 *    page (e.g. "wiki folder missing").
 *  - data/brain.pid is a lockfile: a live PID left behind is killed only when
 *    /proc/<pid>/cmdline shows OUR bundle and THIS brain's folder; a child of
 *    another install (another bundle path) is left alone and the brain fails
 *    with a cause, so a dev instance never takes a live brain over.
 *
 * Uses node:child_process (the same under Bun) so the test can run a fake
 * child under vitest.
 */

export type BrainRunState = "stopped" | "starting" | "running" | "unhealthy" | "backoff" | "failed";

export interface BrainRuntimeStatus {
  state: BrainRunState;
  pid?: number;
  /** The child's ephemeral port (for troubleshooting; sessions never use it). */
  port?: number;
  startedAt?: number;
  /** Crashes in the last 10 minutes. */
  crashes: number;
  /** Why the brain is failed or restarting, in a sentence. */
  cause?: string;
  /** What the user can do about it. */
  action?: string;
  lastExitCode?: number | null;
}

export interface SupervisorOptions {
  bundlePath?: string;
  execPath?: string;
  spawn?: typeof nodeSpawn;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  healthIntervalMs?: number;
  readyTimeoutMs?: number;
  backoffStartMs?: number;
  backoffMaxMs?: number;
  crashWindowMs?: number;
  maxCrashes?: number;
  /** Uptime after which a crash starts the backoff over. */
  stableMs?: number;
  logMaxBytes?: number;
  /** Called each time a child becomes ready (refresh the skill fetched from it). */
  onReady?: (slug: string) => void;
}

interface Entry {
  slug: string;
  state: BrainRunState;
  wanted: boolean;
  child?: ChildProcess;
  pid?: number;
  port?: number;
  startedAt?: number;
  crashTimes: number[];
  backoffMs: number;
  cause?: string;
  action?: string;
  lastExitCode?: number | null;
  restartTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
  healthTimer?: ReturnType<typeof setInterval>;
  healthFailures: number;
  stderrTail: string[];
  waiters: Set<() => void>;
  exited?: Promise<void>;
}

/** Package root: server/brain/ → ../.. (honours __COMPANION_PACKAGE_ROOT like server/index.ts). */
function defaultBundlePath(): string {
  const root = process.env.__COMPANION_PACKAGE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(root, "dist", "brain", "brain.js");
}

/** The BRAIN_PROTOCOL Companion speaks; must equal the bundle's (core/version.ts, checked by a test). */
export const BRAIN_PROTOCOL_EXPECTED = 1;
const STDERR_TAIL = 20;

/** A failure explained for the page: the cause in a sentence and what to do. */
export function explainFailure(stderr: string[], brain: BrainConfig | undefined): { cause: string; action: string } {
  const text = stderr.join("\n");
  if (/BRAIN_PROTOCOL mismatch/.test(text)) {
    return { cause: "Companion and the brain bundle come from different versions.", action: "Finish the update and restart Companion, or rebuild it (bun run build)." };
  }
  if (/SCHEMA\.md not found|ENOENT.*wiki/i.test(text)) {
    return { cause: `The wiki folder ${brain?.embedded?.wikiDir ?? ""} is missing or is not a wiki (no SCHEMA.md).`, action: "Restore the folder, or delete this brain and create it again on the right folder." };
  }
  const last = stderr.filter((l) => l.trim()).at(-1)?.replace(/^brain:\s*/, "").slice(0, 300);
  return { cause: last ? `The brain keeps stopping: ${last}` : "The brain keeps stopping without an error message.", action: "Look at the log below, fix the cause, then press Start." };
}

/** Is `pid` alive (signal 0)? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cmdline(pid: number): string[] | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

export class BrainSupervisor {
  private entries = new Map<string, Entry>();
  private o: Required<Omit<SupervisorOptions, "onReady" | "spawn">> & Pick<SupervisorOptions, "onReady" | "spawn">;

  constructor(opts: SupervisorOptions = {}) {
    this.o = {
      bundlePath: opts.bundlePath ?? defaultBundlePath(),
      execPath: opts.execPath ?? process.execPath,
      // Resolved at spawn time, not here: the singleton is built when the module loads.
      spawn: opts.spawn,
      fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
      healthIntervalMs: opts.healthIntervalMs ?? 30_000,
      readyTimeoutMs: opts.readyTimeoutMs ?? 20_000,
      backoffStartMs: opts.backoffStartMs ?? 1000,
      backoffMaxMs: opts.backoffMaxMs ?? 60_000,
      crashWindowMs: opts.crashWindowMs ?? 10 * 60_000,
      maxCrashes: opts.maxCrashes ?? 5,
      stableMs: opts.stableMs ?? 60_000,
      logMaxBytes: opts.logMaxBytes ?? 1_000_000,
      onReady: opts.onReady,
    };
  }

  private entry(slug: string): Entry {
    let e = this.entries.get(slug);
    if (!e) {
      e = { slug, state: "stopped", wanted: false, crashTimes: [], backoffMs: this.o.backoffStartMs, healthFailures: 0, stderrTail: [], waiters: new Set() };
      this.entries.set(slug, e);
    }
    return e;
  }

  status(slug: string): BrainRuntimeStatus {
    const e = this.entries.get(slug);
    if (!e) return { state: "stopped", crashes: 0 };
    const now = Date.now();
    return {
      state: e.state,
      ...(e.pid ? { pid: e.pid } : {}),
      ...(e.port ? { port: e.port } : {}),
      ...(e.startedAt ? { startedAt: e.startedAt } : {}),
      crashes: e.crashTimes.filter((t) => now - t < this.o.crashWindowMs).length,
      ...(e.cause ? { cause: e.cause } : {}),
      ...(e.action ? { action: e.action } : {}),
      ...(e.lastExitCode !== undefined ? { lastExitCode: e.lastExitCode } : {}),
    };
  }

  private setState(e: Entry, state: BrainRunState): void {
    e.state = state;
    for (const w of [...e.waiters]) w();
  }

  /**
   * Wait until the brain is running, up to `timeoutMs`. False at once when it
   * is stopped or failed (nothing will change by itself), false on timeout.
   */
  waitRunning(slug: string, timeoutMs: number): Promise<boolean> {
    const e = this.entries.get(slug);
    if (!e || !e.wanted || e.state === "failed") return Promise.resolve(false);
    if (e.state === "running") return Promise.resolve(true);
    return new Promise((res) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        e.waiters.delete(check);
        res(ok);
      };
      const check = () => {
        if (e.state === "running") done(true);
        else if (e.state === "failed" || e.state === "stopped") done(false);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      e.waiters.add(check);
    });
  }

  // ── Log ───────────────────────────────────────────────────────────────────

  private log(slug: string, line: string): void {
    const path = brainLogPath(slug);
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        if (statSync(path).size > this.o.logMaxBytes) renameSync(path, `${path}.1`);
      } catch {
        /* no log yet */
      }
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* the brain folder is gone (deleted brain): nothing to log to */
    }
  }

  /** The last `lines` lines of the brain's log (the previous file first when the current one is short). */
  logTail(slug: string, lines = 200): string[] {
    const read = (p: string) => {
      try {
        return readFileSync(p, "utf-8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const path = brainLogPath(slug);
    const cur = read(path);
    const all = cur.length >= lines ? cur : [...read(`${path}.1`), ...cur];
    return all.slice(-lines);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Start (or keep running) an embedded brain. Resets a `failed` state. Never throws. */
  start(slug: string): void {
    const e = this.entry(slug);
    e.wanted = true;
    if (e.child || e.restartTimer) return;
    e.crashTimes = [];
    e.backoffMs = this.o.backoffStartMs;
    e.cause = undefined;
    e.action = undefined;
    this.safeSpawn(e);
  }

  /** spawnChild, with any unexpected error turned into a failed state (never thrown at the caller). */
  private safeSpawn(e: Entry): void {
    try {
      this.spawnChild(e);
    } catch (err) {
      this.fail(e, { cause: `The brain could not be started: ${(err as Error).message}`, action: "Look at the log below, fix the cause, then press Start." });
    }
  }

  /** Stop a brain and wait for its child to exit (SIGTERM, then SIGKILL after 5 s). */
  async stop(slug: string): Promise<void> {
    const e = this.entries.get(slug);
    if (!e) return;
    e.wanted = false;
    this.clearTimers(e);
    const child = e.child;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000);
      await e.exited;
      clearTimeout(killer);
    }
    e.cause = undefined;
    e.action = undefined;
    this.setState(e, "stopped");
  }

  async restart(slug: string): Promise<void> {
    await this.stop(slug);
    this.start(slug);
  }

  /** Start every embedded brain with autostart (at Companion's startup). Does not wait for them. */
  startAll(): void {
    for (const b of listBrains()) {
      if (b.kind === "embedded" && b.embedded?.autostart) this.start(b.slug);
    }
  }

  /** Synchronous SIGTERM to every child: for the process shutdown path. */
  stopAll(): void {
    for (const e of this.entries.values()) {
      e.wanted = false;
      this.clearTimers(e);
      try {
        e.child?.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }

  private clearTimers(e: Entry): void {
    if (e.restartTimer) clearTimeout(e.restartTimer);
    if (e.readyTimer) clearTimeout(e.readyTimer);
    if (e.healthTimer) clearInterval(e.healthTimer);
    e.restartTimer = e.readyTimer = e.healthTimer = undefined;
  }

  private fail(e: Entry, why: { cause: string; action: string }): void {
    e.wanted = false;
    e.cause = why.cause;
    e.action = why.action;
    this.log(e.slug, `[supervisor] failed: ${why.cause}`);
    this.setState(e, "failed");
  }

  /** Before a spawn: free the lockfile. False (brain failed) when another install runs this brain. */
  private takeLock(e: Entry): boolean {
    const pidFile = join(brainDataDir(e.slug), "brain.pid");
    let pid = 0;
    try {
      pid = Number(readFileSync(pidFile, "utf-8").trim());
    } catch {
      return true;
    }
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return true;
    const args = cmdline(pid);
    const dirArg = `--brain-dir=${brainDir(e.slug)}`;
    if (!args || !args.includes(dirArg)) return true; // a reused PID: not a brain of ours
    if (!args.includes(this.o.bundlePath)) {
      this.fail(e, { cause: `Another Companion installation already runs this brain (pid ${pid}).`, action: "Stop the other Companion instance that uses this folder, then press Start." });
      return false;
    }
    // Our own child, left behind by an earlier run of this install.
    this.log(e.slug, `[supervisor] stopping a leftover brain process (pid ${pid})`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone meanwhile */
    }
    return true;
  }

  private childEnv(brain: BrainConfig, keys: { tokenKey: string; curatorKey: string }): Record<string, string> {
    const env: Record<string, string> = {};
    // Only what the bundle needs: no session or service secrets of Companion's own environment.
    for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) if (process.env[k]) env[k] = process.env[k]!;
    const owner = process.env.USER || process.env.LOGNAME || "the user";
    return {
      ...env,
      BRAIN_WIKI_DIR: brain.embedded!.wikiDir,
      BRAIN_DATA_DIR: brainDataDir(brain.slug),
      BRAIN_HOST: "127.0.0.1",
      BRAIN_PORT: "0",
      BRAIN_PROTOCOL: String(BRAIN_PROTOCOL_EXPECTED),
      BRAIN_NAME: brainServerName(brain.slug),
      BRAIN_TITLE: `${brain.name} brain`.slice(0, 80),
      BRAIN_OWNER: owner.slice(0, 80),
      BRAIN_ABOUT: brain.about,
      BRAIN_LANGUAGE: brain.embedded!.language,
      BRAIN_REDACT_SECRETS: String(brain.embedded!.redactSecrets),
      BRAIN_TOKEN_KEY: keys.tokenKey,
      BRAIN_CURATOR_KEY: keys.curatorKey,
      BRAIN_EXIT_WITH_PARENT: "1",
    };
  }

  private spawnChild(e: Entry): void {
    const brain = getBrain(e.slug);
    if (!brain || brain.kind !== "embedded" || !brain.embedded) {
      this.fail(e, { cause: "This brain is not an embedded brain.", action: "Nothing to start." });
      return;
    }
    if (!existsSync(this.o.bundlePath)) {
      this.fail(e, { cause: `The brain program is missing (${this.o.bundlePath}).`, action: "Rebuild Companion (bun run build) or reinstall it." });
      return;
    }
    if (!existsSync(join(brain.embedded.wikiDir, "SCHEMA.md"))) {
      this.fail(e, explainFailure(["SCHEMA.md not found"], brain));
      return;
    }
    ensureEmbeddedSecret(e.slug);
    const keys = embeddedKeys(e.slug)!;
    if (!this.takeLock(e)) return;
    mkdirSync(brainDataDir(e.slug), { recursive: true, mode: 0o700 });

    this.setState(e, "starting");
    e.stderrTail = [];
    e.healthFailures = 0;
    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? nodeSpawn)(this.o.execPath, [this.o.bundlePath, `--brain-dir=${brainDir(e.slug)}`], {
        env: this.childEnv(brain, keys),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.onExit(e, null, `spawn failed: ${(err as Error).message}`);
      return;
    }
    e.child = child;
    e.pid = child.pid;
    e.startedAt = Date.now();
    if (child.pid) {
      try {
        writeFileSync(join(brainDataDir(e.slug), "brain.pid"), `${child.pid}\n`);
      } catch {
        /* best effort */
      }
    }
    this.log(e.slug, `[supervisor] started pid ${child.pid}`);
    child.on("error", (err) => this.log(e.slug, `[supervisor] process error: ${err.message}`));
    this.drain(child.stdout, (line) => {
      this.log(e.slug, line);
      if (e.port || !line.startsWith("{")) return;
      try {
        const msg = JSON.parse(line) as { brain_ready?: boolean; port?: number };
        if (msg.brain_ready && typeof msg.port === "number" && msg.port > 0) this.onReady(e, msg.port);
      } catch {
        /* an audit line */
      }
    });
    this.drain(child.stderr, (line) => {
      this.log(e.slug, `[stderr] ${line}`);
      e.stderrTail = [...e.stderrTail, line].slice(-STDERR_TAIL);
    });
    e.exited = new Promise((res) => {
      child.once("exit", (code) => {
        if (e.child === child) this.onExit(e, code, null);
        res();
      });
    });
    e.readyTimer = setTimeout(() => {
      e.readyTimer = undefined;
      if (e.child === child && !e.port) {
        e.stderrTail.push(`no ready line within ${Math.round(this.o.readyTimeoutMs / 1000)} s`);
        child.kill("SIGKILL");
      }
    }, this.o.readyTimeoutMs);
  }

  /** Read a stream line by line until it ends (never leave a child's pipe unread). */
  private drain(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
    if (!stream) return;
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
      if (buf.length > 65_536) {
        onLine(buf);
        buf = "";
      }
    });
    stream.on("end", () => {
      if (buf) onLine(buf);
      buf = "";
    });
  }

  private onReady(e: Entry, port: number): void {
    if (e.readyTimer) clearTimeout(e.readyTimer);
    e.readyTimer = undefined;
    e.port = port;
    // Up again: an earlier crash's explanation no longer applies (the crash count still shows).
    e.cause = undefined;
    e.action = undefined;
    setChildPort(e.slug, port);
    this.log(e.slug, `[supervisor] ready on port ${port}`);
    this.setState(e, "running");
    e.healthTimer = setInterval(() => void this.checkHealth(e), this.o.healthIntervalMs);
    try {
      this.o.onReady?.(e.slug);
    } catch {
      /* the hook's problem, not the brain's */
    }
  }

  private async checkHealth(e: Entry): Promise<void> {
    const base = childBaseUrl(e.slug);
    if (!base || !e.child) return;
    let ok = false;
    try {
      const res = await this.o.fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel().catch(() => undefined);
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!e.child) return;
    if (ok) {
      e.healthFailures = 0;
      if (e.state === "unhealthy") this.setState(e, "running");
      return;
    }
    e.healthFailures++;
    this.log(e.slug, `[supervisor] health check failed (${e.healthFailures})`);
    if (e.healthFailures >= 3) {
      e.stderrTail.push("health check failed 3 times");
      e.child.kill("SIGKILL");
    } else {
      this.setState(e, "unhealthy");
    }
  }

  private onExit(e: Entry, code: number | null, spawnError: string | null): void {
    this.clearTimers(e);
    const uptime = e.startedAt ? Date.now() - e.startedAt : 0;
    e.child = undefined;
    e.pid = undefined;
    e.port = undefined;
    e.startedAt = undefined;
    e.lastExitCode = code;
    setChildPort(e.slug, null);
    rmSync(join(brainDataDir(e.slug), "brain.pid"), { force: true });
    if (spawnError) e.stderrTail.push(spawnError);
    this.log(e.slug, `[supervisor] exited (code ${code})`);
    if (!e.wanted) {
      this.setState(e, "stopped");
      return;
    }
    const now = Date.now();
    if (uptime >= this.o.stableMs) e.backoffMs = this.o.backoffStartMs;
    e.crashTimes = [...e.crashTimes.filter((t) => now - t < this.o.crashWindowMs), now];
    const brain = getBrain(e.slug);
    // A configuration error (exit 2) will not fix itself: fail at once.
    if (code === 2 || e.crashTimes.length >= this.o.maxCrashes) {
      this.fail(e, explainFailure(e.stderrTail, brain));
      return;
    }
    const why = explainFailure(e.stderrTail, brain);
    e.cause = why.cause;
    e.action = why.action;
    this.setState(e, "backoff");
    const delay = e.backoffMs;
    e.backoffMs = Math.min(e.backoffMs * 2, this.o.backoffMaxMs);
    e.restartTimer = setTimeout(() => {
      e.restartTimer = undefined;
      if (e.wanted) this.safeSpawn(e);
    }, delay);
  }
}

/** Refresh a "server" skill each time its brain (re)starts: the child's skill follows its wiki. */
function refreshSkillOnReady(slug: string): void {
  const brain = getBrain(slug);
  if (brain?.skill.source !== "server") return;
  refreshBrainSkill(slug).catch((err: unknown) => console.warn(`[brain-supervisor] skill refresh of ${slug} failed:`, err));
}

export const brainSupervisor = new BrainSupervisor({ onReady: refreshSkillOnReady });
