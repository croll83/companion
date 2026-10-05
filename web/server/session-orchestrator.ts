import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { AgentExecutor } from "./agent-executor.js";
import type { BackendType, CreationStepId } from "./session-types.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import * as sessionLinearIssues from "./session-linear-issues.js";
import { getConnection, resolveApiKey } from "./linear-connections.js";
import { buildLinearSystemPrompt } from "./linear-prompt-builder.js";
import { transitionLinearIssue, fetchLinearTeamStates } from "./routes/linear-routes.js";
import { discoverCommandsAndSkills } from "./commands-discovery.js";
import { getSettings } from "./settings-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import { companionBus } from "./event-bus.js";
import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";
import { isSessionWorking } from "./session-work.js";
import { getCodexEffortLevels, getCodexDefaultEffort } from "./codex-models.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_AUTO_RELAUNCHES = 3;
const RELAUNCH_GRACE_MS = 10_000;
const RELAUNCH_COOLDOWN_MS = 5_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionOrchestratorDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  sessionStore: SessionStore;
  worktreeTracker: WorktreeTracker;
  prPoller: {
    watch(sessionId: string, cwd: string, branch: string): void;
    unwatch(sessionId: string): void;
  };
  agentExecutor: AgentExecutor;
}

export interface CreateSessionRequest {
  backend?: string;
  model?: string;
  /** Reasoning-effort level for effort-capable Claude models. */
  effort?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
  envSlug?: string;
  linearConnectionId?: string;
  linearIssue?: unknown;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  resumeSessionAt?: string;
  forkSession?: boolean;
}

export type CreateSessionResult =
  | { ok: true; session: SdkSessionInfo }
  | { ok: false; error: string; status: number };

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface ArchiveSessionOptions {
  force?: boolean;
  linearTransition?: string;
}

export interface ArchiveSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
  linearTransition?: {
    ok: boolean;
    skipped?: boolean;
    error?: string;
    issue?: { id: string; identifier: string; stateName: string; stateType: string };
  };
}

export interface DeleteSessionResult {
  ok: boolean;
  worktree?: { cleaned?: boolean; dirty?: boolean; path?: string };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Single entry point for session lifecycle operations: create, resume,
 * reconnect, and terminate. Coordinates between CliLauncher (process
 * management), WsBridge (message routing), and SessionStore (persistence).
 */
export class SessionOrchestrator {
  private launcher: CliLauncher;
  private wsBridge: WsBridge;
  private sessionStore: SessionStore;
  private worktreeTracker: WorktreeTracker;
  private prPoller: SessionOrchestratorDeps["prPoller"];
  private agentExecutor: AgentExecutor;

  // Auto-relaunch state
  private relaunchingSet = new Set<string>();
  private autoRelaunchCounts = new Map<string, number>();
  // Sessions that have already been notified about relaunch exhaustion.
  // Prevents repeated "keeps crashing" warnings for dead sessions.
  private relaunchExhaustedNotified = new Set<string>();

  // Tracks sessions intentionally killed (idle-kill, manual delete/archive)
  // so the proactive keepalive doesn't relaunch them.
  private intentionalKills = new Set<string>();
  // Timers for proactive keepalive relaunches (for cancellation on delete)
  private keepaliveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Idempotency guard for initialize()
  private _initialized = false;

  // Event listeners
  private exitCallbacks: ((sessionId: string, exitCode: number | null) => void)[] = [];

  constructor(deps: SessionOrchestratorDeps) {
    this.launcher = deps.launcher;
    this.wsBridge = deps.wsBridge;
    this.sessionStore = deps.sessionStore;
    this.worktreeTracker = deps.worktreeTracker;
    this.prPoller = deps.prPoller;
    this.agentExecutor = deps.agentExecutor;
  }

  // ── Initialization (event wiring) ──────────────────────────────────────────

  initialize(): void {
    if (this._initialized) return;
    this._initialized = true;

    // When the CLI reports its internal session_id, store it for --resume
    companionBus.on("session:cli-id-received", ({ sessionId, cliSessionId }) => {
      this.launcher.setCLISessionId(sessionId, cliSessionId);
    });

    // When a Codex adapter is created, attach it to the WsBridge
    companionBus.on("backend:codex-adapter-created", ({ sessionId, adapter }) => {
      this.wsBridge.attachBackendAdapter(sessionId, adapter, "codex");
    });

    // When a host Claude CLI is spawned in stdio bridge mode, attach a
    // ClaudeAdapter to its stdin/stdout (no inbound WebSocket fires).
    companionBus.on("session:cli-stdio-ready", ({ sessionId, proc }) => {
      this.wsBridge.handleCLIStdioReady(sessionId, proc);
    });

    // When a CLI/Codex process exits, notify agent executor and external listeners
    // separately so a throw in one doesn't skip the other (bus isolates each handler).
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      this.agentExecutor.handleSessionExited(sessionId, exitCode);
    });
    companionBus.on("session:exited", ({ sessionId, exitCode }) => {
      for (const cb of this.exitCallbacks) {
        try {
          cb(sessionId, exitCode);
        } catch (err) {
          console.error("[orchestrator] exitCallback error:", err);
        }
      }
    });
    companionBus.on("session:exited", ({ sessionId }) => {
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.transition("terminated", "process_exited");
      }
      // Notify browsers the CLI is gone so they show the Reconnect button —
      // UNLESS an immediate relaunch is in progress. Suppression cases:
      //  - relaunchingSet has it: an auto-relaunch OR a model/effort change is
      //    respawning the process right now (a cli_disconnected here would flash
      //    the Reconnect UI mid-relaunch). Model/effort handlers add to the set
      //    for exactly this reason.
      //  - session gone / archived: deleted or archived sessions are torn down
      //    intentionally; no Reconnect affordance is wanted.
      // Idle-kill is deliberately NOT in relaunchingSet, so it DOES notify here
      // (the idle-kill watchdog also notifies directly, and notifyCliDisconnected
      // is deduped, so the double path is harmless).
      if (this.relaunchingSet.has(sessionId)) return;
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      this.wsBridge.notifyCliDisconnected(sessionId);
    });

    // Proactive keepalive disabled — sessions only relaunch when a browser
    // reconnects (session:relaunch-needed). This prevents 20+ idle CLI
    // processes from consuming all available RAM after a server restart.

    // Start watching PRs when git info is resolved
    companionBus.on("session:git-info-ready", ({ sessionId, cwd, branch }) => {
      this.prPoller.watch(sessionId, cwd, branch);
    });

    // Auto-relaunch CLI when a browser connects to a session with no CLI
    companionBus.on("session:relaunch-needed", async ({ sessionId }) => {
      await this.handleAutoRelaunch(sessionId);
    });

    // Model change: persist the new model on the session info and relaunch
    // the CLI with the new --model arg. The Claude CLI's `set_model`
    // control_request silently no-ops, so we kill & respawn with --resume.
    companionBus.on("session:model-change", async ({ sessionId, model }) => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      // Neither CLI can switch model in place (Claude's set_model no-ops, Codex
      // rejects it), so both relaunch — Claude with --resume, Codex with
      // thread/resume — and the conversation carries over.
      if (info.backendType !== "claude" && info.backendType !== "codex") return;
      if (info.backendType === "codex") {
        // The effort is passed at spawn (-c model_reasoning_effort), before the
        // new model reports its levels. A level the new model lacks (Astra's
        // `ultra` on Luna) must be settled now, not after Codex rejects it.
        const levels = getCodexEffortLevels(model);
        if (info.effort && levels.length > 0 && !levels.includes(info.effort as (typeof levels)[number])) {
          const fallback = getCodexDefaultEffort(model);
          log.info("orchestrator", "Effort not supported by new Codex model — using its default", {
            sessionId, model, from: info.effort, to: fallback,
          });
          if (fallback) this.launcher.setEffort(sessionId, fallback);
        }
      }
      log.info("orchestrator", "Model change → relaunching CLI", {
        sessionId,
        from: info.model,
        to: model,
      });
      this.launcher.setModel(sessionId, model);
      this.clearAutoRelaunchCount(sessionId);
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.mustTransition("starting", "model_change_relaunch");
      }
      // Mark as relaunching so the session:exited handler (fired when the old
      // process dies) suppresses cli_disconnected — this is an intentional
      // respawn, not a crash. Cleared in finally once relaunch returns.
      this.relaunchingSet.add(sessionId);
      try {
        await this.launcher.relaunch(sessionId);
      } finally {
        this.relaunchingSet.delete(sessionId);
      }
    });

    // Ultracode is applied in place by the CLI (no relaunch), but the CLI never
    // persists it — remember the confirmed state so the next relaunch re-passes it.
    companionBus.on("session:ultracode-changed", ({ sessionId, enabled }) => {
      this.launcher.setUltracode(sessionId, enabled);
    });

    // Claude effort changes at runtime now; only remember it for the next launch.
    companionBus.on("session:effort-applied", ({ sessionId, effort }) => {
      this.launcher.setEffort(sessionId, effort);
    });

    // Codex effort change: Codex takes effort only at launch
    // (`-c model_reasoning_effort`), so persist the new level and relaunch on
    // thread/resume to keep the conversation. Claude never comes through here —
    // its CLI changes effort at runtime (session:effort-applied above).
    companionBus.on("session:effort-change", async ({ sessionId, effort }) => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      if (info.backendType !== "codex") return;
      log.info("orchestrator", "Effort change → relaunching CLI", {
        sessionId,
        from: info.effort,
        to: effort,
      });
      this.launcher.setEffort(sessionId, effort);
      this.clearAutoRelaunchCount(sessionId);
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.mustTransition("starting", "effort_change_relaunch");
      }
      // See model-change above: suppress the spurious cli_disconnected from the
      // old process's exit during this intentional respawn.
      this.relaunchingSet.add(sessionId);
      try {
        await this.launcher.relaunch(sessionId);
      } finally {
        this.relaunchingSet.delete(sessionId);
      }
    });

    // Kill CLI process when idle with no browsers. Only the CLI process is
    // killed, so the session can be relaunched later.
    companionBus.on("session:idle-kill", async ({ sessionId }) => {
      const info = this.launcher.getSession(sessionId);
      if (!info || info.archived) return;
      log.info("orchestrator", "Idle-killing session", { sessionId, reason: "no browsers, no activity" });
      this.intentionalKills.add(sessionId);
      // Cancel the CLI disconnect debounce timer so it doesn't fire
      // session:relaunch-needed after we intentionally kill the process.
      this.wsBridge.cancelDisconnectTimer(sessionId);
      await this.launcher.kill(sessionId);
      // Clear relaunch counters so the session gets a fresh budget when the user
      // returns. Idle-kill is intentional cleanup, not a crash — the session
      // should be fully relaunchable.
      this.clearAutoRelaunchCount(sessionId);
    });

    // Auto-generate session title after first turn completes
    companionBus.on("session:first-turn-completed", async ({ sessionId, firstUserMessage }) => {
      await this.handleAutoNaming(sessionId, firstUserMessage);
    });

    // Reconnection watchdog disabled — sessions relaunch on-demand when a
    // browser connects (session:relaunch-needed from handleBrowserOpen).
    // this.startReconnectionWatchdog();
  }

  // ── Session Creation ───────────────────────────────────────────────────────

  async createSession(body: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.doCreateSession(body);
  }

  async createSessionStreaming(
    body: CreateSessionRequest,
    onProgress: ProgressCallback,
  ): Promise<CreateSessionResult> {
    return this.doCreateSession(body, onProgress);
  }

  private async doCreateSession(
    body: CreateSessionRequest,
    onProgress?: ProgressCallback,
  ): Promise<CreateSessionResult> {
    try {
      const resumeSessionAt =
        typeof body.resumeSessionAt === "string" && body.resumeSessionAt.trim()
          ? body.resumeSessionAt.trim()
          : undefined;
      const forkSession = body.forkSession === true;
      const backend = (body.backend ?? "claude") as BackendType;
      if (backend !== "claude" && backend !== "codex") {
        return { ok: false, error: `Invalid backend: ${String(body.backend)}`, status: 400 };
      }

      // --- Step: Resolve environment ---
      if (onProgress) await onProgress("resolving_env", "Resolving environment...", "in_progress");

      let envVars: Record<string, string> | undefined = body.env;
      const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug) : null;
      if (body.envSlug && companionEnv) {
        console.log(
          `[orchestrator] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
          Object.keys(companionEnv.variables).join(", "),
        );
        envVars = { ...companionEnv.variables, ...body.env };
      } else if (body.envSlug) {
        console.warn(`[orchestrator] Environment "${body.envSlug}" not found, ignoring`);
      }

      // Inject provider tokens from global settings (if not already set by env profile).
      const globalSettings = getSettings();
      if (backend === "claude" && globalSettings.claudeCodeOAuthToken && !("CLAUDE_CODE_OAUTH_TOKEN" in (envVars ?? {}))) {
        envVars = { ...envVars, CLAUDE_CODE_OAUTH_TOKEN: globalSettings.claudeCodeOAuthToken };
      }
      if (backend === "codex" && globalSettings.openaiApiKey && !("OPENAI_API_KEY" in (envVars ?? {}))) {
        envVars = { ...envVars, OPENAI_API_KEY: globalSettings.openaiApiKey };
      }

      // Inject LINEAR_API_KEY if a Linear connection is specified
      let linearSystemPrompt: string | undefined;
      if (body.linearConnectionId) {
        const conn = getConnection(body.linearConnectionId);
        if (conn?.apiKey) {
          envVars = { ...envVars, LINEAR_API_KEY: conn.apiKey };
          linearSystemPrompt = buildLinearSystemPrompt(conn, body.linearIssue as { identifier: string; title: string; stateName: string; teamName: string; url: string } | undefined);
        }
      }

      if (onProgress) await onProgress("resolving_env", "Environment resolved", "done");

      let cwd = body.cwd;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string } | undefined;

      // Validate branch name to prevent command injection
      if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
        return { ok: false, error: "Invalid branch name", status: 400 };
      }

      // --- Step: Git operations ---
      if (body.useWorktree && body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (onProgress) await onProgress("creating_worktree", "Creating worktree...", "in_progress");
          const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch, {
            baseBranch: repoInfo.defaultBranch,
            createBranch: body.createBranch,
            forceNew: true,
          });
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: body.branch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
          };
        }
        if (onProgress) await onProgress("creating_worktree", "Worktree ready", "done");
      } else if (body.branch && cwd) {
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          if (onProgress) await onProgress("fetching_git", "Fetching from remote...", "in_progress");
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[orchestrator] git fetch failed (non-fatal): ${fetchResult.output}`);
          }
          if (onProgress) await onProgress("fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

          if (repoInfo.currentBranch !== body.branch) {
            if (onProgress) await onProgress("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
            gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch, {
              createBranch: body.createBranch,
              defaultBranch: repoInfo.defaultBranch,
            });
            if (onProgress) await onProgress("checkout_branch", `On branch ${body.branch}`, "done");
          }

          if (onProgress) await onProgress("pulling_git", "Pulling latest changes...", "in_progress");
          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            console.warn(`[orchestrator] git pull warning (non-fatal): ${pullResult.output}`);
          }
          if (onProgress) await onProgress("pulling_git", "Up to date", "done");
        }
      }

      // --- Step: Launch CLI ---
      if (onProgress) await onProgress("launching_cli", `Launching ${backend === "codex" ? "Codex" : "Claude Code"}...`, "in_progress");

      let session: SdkSessionInfo;
      try {
        session = this.launcher.launch({
          model: body.model,
          effort: body.effort,
          permissionMode: body.permissionMode,
          cwd,
          claudeBinary: body.claudeBinary,
          codexBinary: body.codexBinary,
          codexInternetAccess: backend === "codex",
          codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
          allowedTools: body.allowedTools,
          env: envVars,
          backendType: backend,
          resumeSessionAt,
          forkSession,
          systemPrompt: backend === "codex" ? linearSystemPrompt : undefined,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Failed to launch CLI: ${reason}`, status: 503 };
      }

      // Post-launch wiring
      if (worktreeInfo) {
        this.worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      if (linearSystemPrompt && backend === "claude") {
        this.wsBridge.injectSystemPrompt(session.sessionId, linearSystemPrompt);
      }

      const discovered = await discoverCommandsAndSkills(cwd).catch(() => ({ slash_commands: [] as string[], skills: [] as string[] }));
      this.wsBridge.prePopulateCommands(session.sessionId, discovered.slash_commands, discovered.skills);

      if (onProgress) await onProgress("launching_cli", "Session started", "done");

      metricsCollector.recordSessionCreated(backend);
      metricsCollector.recordSessionSpawned(session.sessionId);

      return { ok: true, session };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error("orchestrator", "Failed to create session", { error: msg });
      return { ok: false, error: msg, status: 500 };
    }
  }

  // ── Kill ───────────────────────────────────────────────────────────────────

  async killSession(sessionId: string): Promise<{ ok: boolean }> {
    const killed = await this.launcher.kill(sessionId);
    return { ok: killed };
  }

  // ── Relaunch ───────────────────────────────────────────────────────────────

  async relaunchSession(
    sessionId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string; alreadyRunning?: boolean }> {
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) {
      return { ok: false, error: "Session is archived and cannot be relaunched" };
    }
    // Reconnect used to kill whatever was running, unconditionally. A browser
    // showing stale "disconnected" state (a parked tab, a phone coming back)
    // made that a way to SIGTERM a CLI in the middle of a terraform plan. If the
    // CLI is connected and has work in flight, fix the browser instead.
    // `force` keeps the old behaviour for a deliberate restart of a wedged CLI.
    const live = this.wsBridge.getSession(sessionId);
    if (!opts.force && live && this.wsBridge.isCliConnected(sessionId) && isSessionWorking(live)) {
      log.info("orchestrator", "Reconnect on a connected, working CLI — resyncing instead of killing", { sessionId });
      this.wsBridge.resyncCliConnected(sessionId);
      return { ok: true, alreadyRunning: true };
    }
    this.clearAutoRelaunchCount(sessionId);
    const session = this.wsBridge.getSession(sessionId);
    if (session?.stateMachine) {
      session.stateMachine.mustTransition("starting", "relaunch_initiated");
    }
    return this.launcher.relaunch(sessionId);
  }

  // ── Archive ────────────────────────────────────────────────────────────────

  async archiveSession(sessionId: string, options?: ArchiveSessionOptions): Promise<ArchiveSessionResult> {
    let linearTransitionResult: ArchiveSessionResult["linearTransition"];
    const linearTransition = options?.linearTransition;

    if (linearTransition && linearTransition !== "none") {
      const linkedIssue = sessionLinearIssues.getLinearIssue(sessionId);
      if (linkedIssue) {
        const resolved = resolveApiKey(linkedIssue.connectionId);
        if (resolved) {
          const { apiKey: linearApiKey, connectionId: resolvedConnId } = resolved;
          const settings = getSettings();
          const conn = resolvedConnId !== "legacy" ? getConnection(resolvedConnId) : null;
          let targetStateId = "";

          if (linearTransition === "backlog" && linkedIssue.teamId) {
            const teams = await fetchLinearTeamStates(linearApiKey);
            const team = teams.find((t) => t.id === linkedIssue.teamId);
            const backlogState = team?.states.find((s) => s.type === "backlog");
            if (backlogState) targetStateId = backlogState.id;
          } else if (linearTransition === "configured") {
            const archiveStateId = conn ? conn.archiveTransitionStateId : settings.linearArchiveTransitionStateId;
            targetStateId = archiveStateId.trim();
          }

          if (targetStateId) {
            try {
              linearTransitionResult = await transitionLinearIssue(linkedIssue.id, targetStateId, linearApiKey, resolvedConnId);
            } catch {
              linearTransitionResult = { ok: false, error: "Transition failed unexpectedly" };
            }
          } else {
            linearTransitionResult = { ok: true, skipped: true };
          }
        }
      }
    }

    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    this.prPoller.unwatch(sessionId);

    const worktreeResult = this.cleanupWorktree(sessionId, options?.force);
    this.launcher.setArchived(sessionId, true);
    this.sessionStore.setArchived(sessionId, true);

    return { ok: true, worktree: worktreeResult, linearTransition: linearTransitionResult };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async deleteSession(sessionId: string): Promise<DeleteSessionResult> {
    this.intentionalKills.add(sessionId);
    this.cancelKeepaliveTimer(sessionId);
    this.wsBridge.cancelDisconnectTimer(sessionId);
    await this.launcher.kill(sessionId);
    const worktreeResult = this.cleanupWorktree(sessionId, true);
    this.prPoller.unwatch(sessionId);
    sessionLinearIssues.removeLinearIssue(sessionId);
    this.launcher.removeSession(sessionId);
    this.wsBridge.closeSession(sessionId);
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
    this.relaunchingSet.delete(sessionId);
    this.intentionalKills.delete(sessionId);
    return { ok: true, worktree: worktreeResult };
  }

  // ── Unarchive ──────────────────────────────────────────────────────────────

  unarchiveSession(sessionId: string): { ok: boolean } {
    this.launcher.setArchived(sessionId, false);
    this.sessionStore.setArchived(sessionId, false);
    return { ok: true };
  }

  // ── Auto-relaunch count ────────────────────────────────────────────────────

  clearAutoRelaunchCount(sessionId: string): void {
    this.autoRelaunchCounts.delete(sessionId);
    this.relaunchExhaustedNotified.delete(sessionId);
  }

  // ── Event registration ─────────────────────────────────────────────────────

  /** Register a callback for session exit events. Returns unsubscribe function. */
  onSessionExited(cb: (sessionId: string, exitCode: number | null) => void): () => void {
    this.exitCallbacks.push(cb);
    return () => {
      const idx = this.exitCallbacks.indexOf(cb);
      if (idx !== -1) this.exitCallbacks.splice(idx, 1);
    };
  }

  // ── Query delegation ───────────────────────────────────────────────────────

  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.launcher.getSession(sessionId);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  shutdown(): void {
    // Timers are owned by the process lifecycle
  }

  // ── Private: Auto-relaunch ─────────────────────────────────────────────────

  private async handleAutoRelaunch(sessionId: string): Promise<void> {
    if (this.relaunchingSet.has(sessionId)) return;
    const info = this.launcher.getSession(sessionId);
    if (info?.archived) return;

    // If we've already notified the user about relaunch exhaustion, bail out
    // silently. Without this, every reconnect event from a dead session
    // re-logs the "limit reached" warning endlessly.
    if (this.relaunchExhaustedNotified.has(sessionId)) return;

    this.relaunchingSet.add(sessionId);

    await new Promise((r) => setTimeout(r, RELAUNCH_GRACE_MS));
    if (this.wsBridge.isCliConnected(sessionId)) { this.relaunchingSet.delete(sessionId); return; }
    const freshInfo = this.launcher.getSession(sessionId);

    // A CONFIRMED disconnect outranks every liveness signal below.
    //
    // Those signals describe the *process*; this one describes the *transport*.
    // When the CLI's stdout reaches EOF the process keeps running and its
    // launcher record still says "connected", but we can never read another
    // byte from it — the session is dead to us while looking perfectly healthy
    // to every check here. The guards then declined to relaunch, the UI sat on
    // "CLI disconnected", and the only way out was a manual Reconnect followed
    // by re-sending the message. Observed on 2026-09-23 with
    // `stdio reader ENDED cause=eof processAlive=true killed=false`.
    //
    // relaunch() SIGTERMs whatever is still running, so replacing a live but
    // unreachable process is safe.
    const phase = this.wsBridge.getSession(sessionId)?.stateMachine.phase;
    const disconnectConfirmed = phase === "terminated";

    if (!disconnectConfirmed && freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running")) {
      this.relaunchingSet.delete(sessionId); return;
    }
    // Only check PID liveness if the session is NOT already "exited".
    // After idle-kill or explicit kill(), the PID field stays set but the
    // process is dead. If the kernel recycles the PID to a different process,
    // kill(pid, 0) would incorrectly succeed, preventing any relaunch.
    if (!disconnectConfirmed && freshInfo && freshInfo.state !== "exited" && freshInfo.pid) {
      try { process.kill(freshInfo.pid, 0); this.relaunchingSet.delete(sessionId); return; } catch {}
    }

    const count = this.autoRelaunchCounts.get(sessionId) ?? 0;
    if (count >= MAX_AUTO_RELAUNCHES) {
      metricsCollector.recordRelaunchExhausted();
      log.warn("orchestrator", "Auto-relaunch limit reached", { sessionId, maxAttempts: MAX_AUTO_RELAUNCHES });
      this.wsBridge.broadcastToSession(sessionId, {
        type: "error",
        message: "Session keeps crashing. Please relaunch manually.",
      });
      this.relaunchExhaustedNotified.add(sessionId);
      this.relaunchingSet.delete(sessionId);
      return;
    }

    if (freshInfo && freshInfo.state !== "starting") {
      this.autoRelaunchCounts.set(sessionId, count + 1);
      metricsCollector.recordRelaunchAttempted();
      log.info("orchestrator", "Auto-relaunching CLI", { sessionId, attempt: count + 1, maxAttempts: MAX_AUTO_RELAUNCHES });
      const session = this.wsBridge.getSession(sessionId);
      if (session?.stateMachine) {
        session.stateMachine.mustTransition("starting", "relaunch_initiated");
      }
      try {
        const result = await this.launcher.relaunch(sessionId);
        if (!result.ok && result.error) {
          this.wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
        } else if (result.ok) {
          metricsCollector.recordRelaunchSucceeded();
          this.autoRelaunchCounts.delete(sessionId);
          this.relaunchExhaustedNotified.delete(sessionId);
          // Clear intentionalKills so future crashes can use proactive keepalive.
          // After a successful relaunch, the session is alive again — any prior
          // idle-kill intent no longer applies.
          this.intentionalKills.delete(sessionId);
        }
        // ok=false without error: keep count to preserve the retry budget
      } finally {
        setTimeout(() => this.relaunchingSet.delete(sessionId), RELAUNCH_COOLDOWN_MS);
      }
    } else {
      this.relaunchingSet.delete(sessionId);
    }
  }

  private cancelKeepaliveTimer(sessionId: string): void {
    const timer = this.keepaliveTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.keepaliveTimers.delete(sessionId);
    }
  }

  // ── Private: Auto-naming ───────────────────────────────────────────────────

  private async handleAutoNaming(sessionId: string, firstUserMessage: string): Promise<void> {
    if (sessionNames.getName(sessionId)) return;
    if (!getSettings().anthropicApiKey.trim()) return;
    const info = this.launcher.getSession(sessionId);
    const model = info?.model || "claude-sonnet-4-6";
    console.log(`[orchestrator] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
    const title = await generateSessionTitle(firstUserMessage, model);
    if (title && !sessionNames.getName(sessionId)) {
      console.log(`[orchestrator] Auto-named session ${sessionId}: "${title}"`);
      sessionNames.setName(sessionId, title);
      this.wsBridge.broadcastNameUpdate(sessionId, title);
    }
  }

  // ── Private: Worktree cleanup ──────────────────────────────────────────────

  private cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = this.worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    if (this.worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      this.worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      this.worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }
}
