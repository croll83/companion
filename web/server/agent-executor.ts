import { Cron } from "croner";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { AgentConfig, AgentExecution } from "./agent-types.js";
import type { CliLauncher, ForkSource, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { BrowserIncomingMessage, CLIResultMessage } from "./session-types.js";
import * as agentStore from "./agent-store.js";
import * as envManager from "./env-manager.js";
import * as sessionNames from "./session-names.js";
import { ExecutionStore } from "./execution-store.js";
import { nextScheduledRun, scheduleTimeZone, scheduleTimeZoneLabel } from "./agent-schedule.js";
import { resolveForkSource } from "./session-fork.js";
import { isPathWithin } from "./path-scope.js";

/** Max consecutive failures before auto-disabling an agent */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Max time to wait for CLI to connect (ms) */
const CLI_CONNECT_TIMEOUT_MS = 30_000;
/** Poll interval when waiting for CLI connection */
const CLI_CONNECT_POLL_MS = 500;
/** Prefix of the working directories created for cwd:"temp" agents. */
const TEMP_CWD_PREFIX = "companion-agent-";
/** Longest error text kept on a run record. */
const MAX_ERROR_LENGTH = 2000;

export interface ExecuteAgentOptions {
  /**
   * Skip both the enabled and the overlap checks. Used by the Linear trigger,
   * where every Linear thread gets its own session.
   */
  force?: boolean;
  /** Run even if the agent is disabled (manual "Run now"). Overlap still applies. */
  ignoreEnabled?: boolean;
  triggerType?: AgentExecution["triggerType"];
  additionalEnv?: Record<string, string>;
  systemPrompt?: string;
}

/** Outcome of asking for a run: started, or refused with an HTTP-like status. */
export type StartRunResult =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

/**
 * The prompt sent for a run. `{{input}}` placeholders are replaced by the
 * trigger input (or removed when there is none). A prompt without the
 * placeholder still gets non-empty input, appended as a delimited block so
 * webhook payloads and Linear context are never silently dropped.
 */
export function buildAgentPrompt(template: string, input?: string): string {
  if (template.includes("{{input}}")) {
    // Function replacer: "$&"-style patterns in the input stay literal.
    return template.replace(/\{\{input\}\}/g, () => input ?? "");
  }
  if (input === undefined || !input.trim()) return template;
  return `${template}\n\nInput provided by the trigger:\n<trigger_input>\n${input}\n</trigger_input>`;
}

/**
 * True for a directory this executor created with mkdtemp for a "temp"
 * agent — the only kind of directory it will ever delete.
 */
export function isAgentTempDir(dir: string | undefined): dir is string {
  if (!dir) return false;
  const full = resolve(dir);
  return resolve(dirname(full)) === resolve(tmpdir()) && basename(full).startsWith(TEMP_CWD_PREFIX);
}

function resultErrorText(data: CLIResultMessage): string {
  const errors = Array.isArray(data.errors) ? data.errors.filter(Boolean).join("; ") : "";
  const text = errors || (typeof data.result === "string" && data.result.trim()) || `Run ended with ${data.subtype}`;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/** A run and its final answer (see AgentExecutor.getRunResult). */
export interface RunResult {
  sessionId: string;
  agentId: string;
  triggerType: AgentExecution["triggerType"];
  startedAt: number;
  completedAt?: number;
  status: "running" | "success" | "error";
  success?: boolean;
  error?: string;
  subtype?: string;
  /** The answer text (truncated to the requested size), or null if not available. */
  result: string | null;
  truncated: boolean;
}

function assistantText(entry: BrowserIncomingMessage): string {
  if (entry.type !== "assistant" || entry.parent_tool_use_id) return "";
  const content = entry.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The answer of a run's turn in a session history: the turn after the agent
 * prompt (`[agent:…]`), or the first turn when that prompt is not found.
 */
export function runAnswerText(history: BrowserIncomingMessage[]): string | null {
  const promptAt = history.findIndex((m) => m.type === "user_message" && m.content.startsWith("[agent:"));
  const from = promptAt >= 0 ? promptAt + 1 : 0;
  const resultAt = history.findIndex((m, i) => i >= from && m.type === "result");
  if (resultAt < 0) return null;
  const result = history[resultAt];
  if (result.type === "result" && typeof result.data.result === "string" && result.data.result.trim()) {
    return result.data.result;
  }
  for (let i = resultAt - 1; i >= from; i--) {
    const text = assistantText(history[i]);
    if (text.trim()) return text;
  }
  return null;
}

export class AgentExecutor {
  /**
   * After the CLI exits without a result, wait this long before failing the
   * run: the result line can still be on its way through the stdout reader.
   */
  static EXIT_GRACE_MS = 2000;

  private timers = new Map<string, Cron>();
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  /** In-memory execution history (last N per agent) */
  private executions = new Map<string, AgentExecution[]>();
  private static readonly MAX_EXECUTIONS_PER_AGENT = 50;
  /** Persistent execution store (JSONL on disk) */
  private executionStore = new ExecutionStore();
  /** Runs whose session exists and has not produced a result yet, by session id. */
  private activeRuns = new Map<string, AgentExecution>();
  /** Runs being launched (no session id yet), counted per agent id. */
  private launching = new Map<string, number>();
  /** Pending "CLI exited first" failures, by session id. */
  private exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Schedule problems to show on the agent (invalid, past or skipped), by agent id. */
  private scheduleIssues = new Map<string, string>();

  constructor(launcher: CliLauncher, wsBridge: WsBridge) {
    this.launcher = launcher;
    this.wsBridge = wsBridge;
    // A server restart kills every CLI: runs still open on disk can never
    // report a result, and leaving them "running" would block their agents.
    const closed = this.executionStore.finalizeInterrupted("Interrupted: the server restarted before the run finished");
    if (closed > 0) {
      console.log(`[agent-executor] Closed ${closed} run(s) interrupted by a server restart`);
    }
  }

  /** Start all enabled agents with schedule triggers from disk. Called once at server startup. */
  startAll(): void {
    const agents = agentStore.listAgents();
    let started = 0;
    for (const agent of agents) {
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        this.scheduleAgent(agent);
        started++;
      }
    }
    if (started > 0) {
      console.log(`[agent-executor] Started ${started} scheduled agent(s)`);
    }
    // Temp dirs of runs whose sessions were archived/deleted while we were down.
    // Only this instance's runs: history read from an older location may
    // belong to another instance whose sessions are unknown here.
    for (const exec of this.executionStore.own()) this.cleanupTempCwd(exec);
  }

  /** Re-arm every schedule, e.g. after the global timeZone setting changed. */
  rescheduleAll(): void {
    for (const agent of agentStore.listAgents()) this.scheduleAgent(agent);
  }

  /** Schedule (or reschedule) an agent's cron trigger in the global timeZone setting. */
  scheduleAgent(agent: AgentConfig): void {
    this.stopAgent(agent.id);

    const schedule = agent.triggers?.schedule;
    if (!agent.enabled || !schedule?.enabled || !schedule.expression) return;

    const timezone = scheduleTimeZone();
    try {
      if (schedule.recurring) {
        const cronTask = new Cron(schedule.expression.trim(), { mode: "5-part", timezone }, () => {
          this.fireSchedule(agent.id, false);
        });
        this.timers.set(agent.id, cronTask);
        console.log(`[agent-executor] Scheduled "${agent.name}" with cron "${schedule.expression}" (${scheduleTimeZoneLabel(timezone)})`);
        return;
      }
      const target = nextScheduledRun(schedule, timezone);
      if (!target) {
        const issue = `One-time run at ${schedule.expression} (${scheduleTimeZoneLabel(timezone)}) did not run: that time has passed`;
        this.scheduleIssues.set(agent.id, issue);
        console.warn(`[agent-executor] "${agent.name}": ${issue}`);
        return;
      }
      const cronTask = new Cron(target, () => {
        this.timers.delete(agent.id);
        this.disableOneShot(agent.id);
        this.fireSchedule(agent.id, true);
      });
      this.timers.set(agent.id, cronTask);
      console.log(`[agent-executor] Scheduled one-shot "${agent.name}" at ${target.toISOString()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.scheduleIssues.set(agent.id, `Schedule not armed: ${message}`);
      console.error(`[agent-executor] Failed to schedule "${agent.name}":`, err);
    }
  }

  /** A schedule fired: start a run, reporting (not hiding) a refused one. */
  private fireSchedule(agentId: string, oneShot: boolean): void {
    const result = this.startRun(agentId, undefined, { triggerType: "schedule" });
    if (result.ok) {
      this.scheduleIssues.delete(agentId);
      return;
    }
    const issue = `${oneShot ? "One-time" : "Scheduled"} run at ${new Date().toISOString()} skipped: ${result.error}`;
    this.scheduleIssues.set(agentId, issue);
    console.log(`[agent-executor] ${agentId}: ${issue}`);
  }

  /** A one-shot schedule is spent once it fires. */
  private disableOneShot(agentId: string): void {
    const current = agentStore.getAgent(agentId);
    if (!current?.triggers?.schedule) return;
    agentStore.updateAgent(agentId, {
      triggers: {
        ...current.triggers,
        schedule: { ...current.triggers.schedule, enabled: false },
      },
    });
  }

  /** Stop an agent's cron timer (and forget its schedule problems). */
  stopAgent(agentId: string): void {
    this.scheduleIssues.delete(agentId);
    const timer = this.timers.get(agentId);
    if (timer) {
      timer.stop();
      this.timers.delete(agentId);
    }
  }

  /** Why the agent's schedule is not running as configured, if it is not. */
  getScheduleIssue(agentId: string): string | null {
    return this.scheduleIssues.get(agentId) ?? null;
  }

  /** True while a run of this agent is launching or waiting for its result. */
  isRunInProgress(agentId: string): boolean {
    return this.activeRunSession(agentId) !== undefined;
  }

  /** Session id of the agent's run in progress, once it has one. */
  runSessionOf(agentId: string): string | undefined {
    return this.activeRunSession(agentId) || undefined;
  }

  /** Session of the agent's run in progress ("" while launching), or undefined. */
  private activeRunSession(agentId: string): string | undefined {
    for (const [sessionId, exec] of this.activeRuns) {
      if (exec.agentId === agentId) return sessionId;
    }
    return (this.launching.get(agentId) ?? 0) > 0 ? "" : undefined;
  }

  private checkStart(agent: AgentConfig | null, opts: ExecuteAgentOptions): StartRunResult {
    if (!agent) return { ok: false, status: 404, error: "Agent not found" };
    if (opts.force) return { ok: true };
    if (!agent.enabled && !opts.ignoreEnabled) {
      return { ok: false, status: 409, error: `Agent "${agent.name}" is disabled` };
    }
    const running = this.activeRunSession(agent.id);
    if (running !== undefined) {
      return {
        ok: false,
        status: 409,
        error: `A run of agent "${agent.name}" is still in progress${running ? ` (session ${running})` : ""}`,
      };
    }
    return { ok: true };
  }

  /**
   * Start a run in the background after the synchronous checks (exists,
   * enabled, no run in progress). The run is reserved before this returns,
   * so two triggers arriving together cannot both start one.
   */
  startRun(agentId: string, input?: string, opts: ExecuteAgentOptions = {}): StartRunResult {
    const gate = this.checkStart(agentStore.getAgent(agentId), opts);
    if (!gate.ok) return gate;
    this.executeAgent(agentId, input, opts).catch((err) => {
      console.error(`[agent-executor] Unhandled error running agent "${agentId}":`, err);
    });
    return { ok: true };
  }

  /** Execute an agent: create a session, configure MCP, send the prompt, track the result. */
  async executeAgent(
    agentId: string,
    input?: string,
    opts: ExecuteAgentOptions = {},
  ): Promise<SdkSessionInfo | undefined> {
    const agent = agentStore.getAgent(agentId);
    const gate = this.checkStart(agent, opts);
    if (!gate.ok || !agent) {
      if (agent && !gate.ok) console.log(`[agent-executor] Skipping "${agent.name}": ${gate.error}`);
      return undefined;
    }

    const triggerType = opts.triggerType || "manual";
    console.log(`[agent-executor] Executing agent "${agent.name}" (${agentId}) via ${triggerType}`);

    const execution: AgentExecution = {
      sessionId: "",
      agentId,
      triggerType,
      startedAt: Date.now(),
    };
    // Reserve synchronously (before any await) so overlapping triggers see it.
    this.launching.set(agentId, (this.launching.get(agentId) ?? 0) + 1);
    let reserved = true;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      const left = (this.launching.get(agentId) ?? 1) - 1;
      if (left > 0) this.launching.set(agentId, left);
      else this.launching.delete(agentId);
    };

    try {
      // Agent env (inline vars, then trigger-specific ones). Env profiles —
      // global, folder-matched and the agent's explicit envSlug — are resolved
      // by the launcher at every spawn/relaunch, like for any other session.
      let envVars: Record<string, string> | undefined;
      if (agent.env) {
        envVars = { ...agent.env };
      }
      if (opts.additionalEnv) {
        envVars = { ...envVars, ...opts.additionalEnv };
      }
      const envSlug = agent.envSlug && envManager.getEnv(agent.envSlug) ? agent.envSlug : undefined;

      // Context: "fork" copies the source session's conversation and runs in
      // its folder; "brief" (default) starts fresh in the agent's folder.
      let forkSource: ForkSource | undefined;
      let cwd = agent.cwd;
      if (agent.contextMode === "fork") {
        const fork = resolveForkSource(this.launcher, agent.sourceSessionId, agent.backendType);
        if (!fork.ok) throw new Error(`Cannot fork the source session: ${fork.error}`);
        forkSource = fork.source;
        cwd = fork.cwd;
      } else if (cwd === "temp" || !cwd) {
        cwd = mkdtempSync(join(tmpdir(), `${TEMP_CWD_PREFIX}${agent.id}-`));
        execution.tempCwd = cwd;
      }

      // Agents always run unattended, so Claude gets bypassPermissions: any
      // other mode would block on approvals nobody answers. Codex never asks
      // for approvals in Companion; its permissionMode picks the sandbox.
      if (agent.backendType === "claude" && agent.permissionMode && agent.permissionMode !== "bypassPermissions") {
        console.warn(
          `[agent-executor] Agent "${agent.name}" has permissionMode="${agent.permissionMode}" ` +
          `but agent sessions always run with bypassPermissions`,
        );
      }
      const sessionInfo = this.launcher.launch({
        model: agent.model,
        permissionMode: "bypassPermissions",
        cwd,
        env: envVars,
        envSlug,
        // Claude only (`--tools`); Codex has no per-tool restriction.
        tools: agent.backendType === "claude" && agent.allowedTools?.length ? agent.allowedTools : undefined,
        backendType: agent.backendType,
        codexInternetAccess: agent.backendType === "codex" ? (agent.codexInternetAccess ?? true) : undefined,
        codexSandbox: agent.backendType === "codex"
          ? (agent.permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write")
          : undefined,
        systemPrompt: agent.backendType === "codex" ? opts.systemPrompt : undefined,
        forkSource,
      });

      execution.sessionId = sessionInfo.sessionId;
      this.activeRuns.set(sessionInfo.sessionId, execution);
      release();
      this.addExecution(agentId, execution);

      // Tag the session as agent-originated
      sessionInfo.agentId = agentId;
      sessionInfo.agentName = agent.name;
      sessionNames.setName(sessionInfo.sessionId, `🤖 ${agent.name}`);

      agentStore.updateAgent(agentId, {
        lastRunAt: Date.now(),
        lastSessionId: sessionInfo.sessionId,
        totalRuns: agent.totalRuns + 1,
      });

      // Wait for CLI to connect
      await this.waitForCLIConnection(sessionInfo.sessionId);

      // Configure MCP servers if specified
      if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
        this.wsBridge.injectMcpSetServers(sessionInfo.sessionId, agent.mcpServers);
        // MCP servers need time to initialize before the CLI processes the prompt.
        // The CLI handles MCP setup asynchronously; this delay ensures servers are
        // ready. A proper health-check mechanism would be better long-term, but the
        // CLI doesn't expose an MCP-ready signal yet.
        const MCP_INIT_DELAY_MS = 2000;
        await new Promise((r) => setTimeout(r, MCP_INIT_DELAY_MS));
      }

      if (opts.systemPrompt && agent.backendType === "claude") {
        this.wsBridge.injectSystemPrompt(sessionInfo.sessionId, opts.systemPrompt);
      }

      // Send the prompt with agent prefix for traceability. The run stays
      // "running" until handleSessionResult (or the CLI exiting first).
      const fullPrompt = `[agent:${agent.id} ${agent.name}]\n\n${buildAgentPrompt(agent.prompt, input)}`;
      this.wsBridge.injectUserMessage(sessionInfo.sessionId, fullPrompt);

      return sessionInfo;
    } catch (err) {
      release();
      console.error(`[agent-executor] Agent "${agent.name}" failed:`, err);
      const error = err instanceof Error ? err.message : String(err);
      if (execution.sessionId) {
        this.finishRun(execution, { success: false, error });
      } else {
        // Never got a session: record the failed attempt as a closed run.
        this.finishRun(execution, { success: false, error }, { lastRunAt: Date.now() });
        this.addExecution(agentId, execution);
      }
      return undefined;
    }
  }

  /**
   * Manual "Run now": runs even when the agent is disabled, but not while
   * another run of it is still in progress.
   */
  executeAgentManually(agentId: string, input?: string): StartRunResult {
    return this.startRun(agentId, input, { ignoreEnabled: true, triggerType: "manual" });
  }

  /** Wait for CLI to be connected (poll up to timeout). */
  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        return;
      }
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }

    throw new Error(`CLI process did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }

  /** Get next run time for an agent. */
  getNextRunTime(agentId: string): Date | null {
    const timer = this.timers.get(agentId);
    if (!timer) return null;
    return timer.nextRun() || null;
  }

  /** Get recent executions for an agent. */
  getExecutions(agentId: string): AgentExecution[] {
    return this.executions.get(agentId) || [];
  }

  private addExecution(agentId: string, execution: AgentExecution): void {
    if (!this.executions.has(agentId)) {
      this.executions.set(agentId, []);
    }
    const list = this.executions.get(agentId)!;
    list.push(execution);
    if (list.length > AgentExecutor.MAX_EXECUTIONS_PER_AGENT) {
      list.splice(0, list.length - AgentExecutor.MAX_EXECUTIONS_PER_AGENT);
    }
    // Persist to disk
    this.executionStore.append(execution);
  }

  /** Query executions across all agents (for Runs view). */
  listAllExecutions(opts?: { agentId?: string; triggerType?: string; status?: "running" | "success" | "error"; limit?: number; offset?: number }) {
    return this.executionStore.list(opts);
  }

  /**
   * A turn result arrived. The first one for a run's session completes the
   * run (success = !is_error). The session is kept: the user can open it,
   * read the outcome and continue the conversation.
   */
  handleSessionResult(sessionId: string, message: BrowserIncomingMessage): void {
    if (message.type !== "result") return;
    const exec = this.activeRuns.get(sessionId);
    if (!exec) return;
    const data = message.data;
    const success = !data.is_error;
    this.finishRun(exec, {
      success,
      subtype: data.subtype,
      error: success ? undefined : resultErrorText(data),
    });
  }

  /**
   * A run and its final answer: the result of the run's turn (the first
   * turn after the agent prompt), from the session's message history.
   * Claude reports the answer in the result itself; Codex does not, so the
   * text of the turn's last assistant message is used instead. `result` is
   * null while the run is still going (or the history is gone). Returns null
   * for an unknown run.
   */
  getRunResult(sessionId: string, maxChars: number): RunResult | null {
    const exec = this.activeRuns.get(sessionId)
      ?? [...this.executions.values()].flat().find((e) => e.sessionId === sessionId)
      ?? this.executionStore.own().find((e) => e.sessionId === sessionId);
    if (!exec || !sessionId) return null;
    const text = exec.completedAt ? runAnswerText(this.wsBridge.getSession(sessionId)?.messageHistory ?? []) : null;
    const truncated = text !== null && text.length > maxChars;
    return {
      sessionId,
      agentId: exec.agentId,
      triggerType: exec.triggerType,
      startedAt: exec.startedAt,
      completedAt: exec.completedAt,
      status: !exec.completedAt ? "running" : exec.success ? "success" : "error",
      success: exec.success,
      error: exec.error,
      subtype: exec.subtype,
      result: truncated ? `${text.slice(0, maxChars)}…` : text,
      truncated,
    };
  }

  /**
   * The CLI exited. If its run had no result yet, fail the run — after a
   * short grace period in case the result line is still being read.
   */
  handleSessionExited(sessionId: string, exitCode: number | null): void {
    const exec = this.activeRuns.get(sessionId);
    if (!exec || this.exitTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.exitTimers.delete(sessionId);
      this.finishRun(exec, {
        success: false,
        error: exitCode
          ? `CLI exited with code ${exitCode} before the run finished`
          : "CLI exited before the run finished",
      });
    }, AgentExecutor.EXIT_GRACE_MS);
    this.exitTimers.set(sessionId, timer);
  }

  /**
   * A Codex session could not start its thread (e.g. the fork source's
   * rollout became unreadable): its run can never produce a result.
   */
  handleSessionInitFailed(sessionId: string, error: string): void {
    const exec = this.activeRuns.get(sessionId);
    if (!exec) return;
    this.finishRun(exec, { success: false, error: error.slice(0, MAX_ERROR_LENGTH) });
  }

  /**
   * Why an agent with contextMode "fork" could not run from this source
   * right now, or null if it could (used to validate the agent on save).
   */
  forkSourceError(sourceSessionId: string | undefined, backendType: AgentConfig["backendType"]): string | null {
    const fork = resolveForkSource(this.launcher, sourceSessionId, backendType);
    return fork.ok ? null : fork.error;
  }

  /**
   * A session was archived or deleted: its temp working directory can go,
   * if its run is over (a still-running run cleans up when it finishes).
   */
  handleSessionClosed(sessionId: string): void {
    for (const exec of this.executionStore.own()) {
      if (exec.sessionId === sessionId) this.cleanupTempCwd(exec);
    }
  }

  /**
   * An archived session is back. Its temp working directory may have been
   * cleaned up meanwhile; recreate it (empty) so the CLI can start there.
   */
  handleSessionUnarchived(sessionId: string): void {
    const cwd = this.launcher.getSession(sessionId)?.cwd;
    if (!isAgentTempDir(cwd) || existsSync(cwd)) return;
    try {
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
    } catch (err) {
      console.warn(`[agent-executor] Could not recreate temp dir ${cwd}:`, err);
    }
  }

  /** Close a run once; persist it, update the agent's counters, tidy up. */
  private finishRun(
    exec: AgentExecution,
    outcome: { success: boolean; error?: string; subtype?: string },
    agentUpdates: Partial<AgentConfig> = {},
  ): void {
    if (exec.completedAt) return;
    exec.completedAt = Date.now();
    exec.success = outcome.success;
    if (outcome.error !== undefined) exec.error = outcome.error;
    if (outcome.subtype !== undefined) exec.subtype = outcome.subtype;
    if (exec.sessionId) {
      this.activeRuns.delete(exec.sessionId);
      const timer = this.exitTimers.get(exec.sessionId);
      if (timer) clearTimeout(timer);
      this.exitTimers.delete(exec.sessionId);
      this.executionStore.update(exec.sessionId, {
        completedAt: exec.completedAt,
        success: exec.success,
        error: exec.error,
        subtype: exec.subtype,
      });
    }
    this.recordOutcome(exec.agentId, outcome.success, agentUpdates);
    this.cleanupTempCwd(exec);
  }

  /** Reset or bump consecutiveFailures; auto-disable after too many in a row. */
  private recordOutcome(agentId: string, success: boolean, extra: Partial<AgentConfig>): void {
    const agent = agentStore.getAgent(agentId);
    if (!agent) return;
    if (success) {
      if (agent.consecutiveFailures !== 0 || Object.keys(extra).length > 0) {
        agentStore.updateAgent(agentId, { ...extra, consecutiveFailures: 0 });
      }
      return;
    }
    const failures = agent.consecutiveFailures + 1;
    const updates: Partial<AgentConfig> = { ...extra, consecutiveFailures: failures };
    if (failures >= MAX_CONSECUTIVE_FAILURES && agent.enabled) {
      updates.enabled = false;
      this.stopAgent(agentId);
      console.warn(`[agent-executor] Agent "${agent.name}" disabled after ${failures} consecutive failures`);
    }
    agentStore.updateAgent(agentId, updates);
  }

  /**
   * Delete a finished run's temp working directory once nothing uses it: its
   * session is archived or gone, and no other live session sits in it.
   */
  private cleanupTempCwd(exec: AgentExecution): void {
    const dir = exec.tempCwd;
    if (!exec.completedAt || !isAgentTempDir(dir)) return;
    const own = exec.sessionId ? this.launcher.getSession(exec.sessionId) : undefined;
    if (own && !own.archived) return;
    // Any live session in the dir or below it (e.g. a repo cloned there and
    // opened as its own session) still uses it.
    const inUse = this.launcher.listSessions().some((s) =>
      !s.archived && [s.cwd, s.repoRoot].some((p) => !!p && isPathWithin(p, dir)));
    if (inUse || !existsSync(dir)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
      console.log(`[agent-executor] Removed temp dir ${dir} of finished run ${exec.sessionId || "(no session)"}`);
    } catch (err) {
      console.warn(`[agent-executor] Could not remove temp dir ${dir}:`, err);
    }
  }

  /** Stop all timers (for graceful shutdown). */
  destroy(): void {
    for (const timer of this.timers.values()) {
      timer.stop();
    }
    this.timers.clear();
    for (const timer of this.exitTimers.values()) clearTimeout(timer);
    this.exitTimers.clear();
    this.executions.clear();
    this.activeRuns.clear();
    this.launching.clear();
    this.scheduleIssues.clear();
  }
}
