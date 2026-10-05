import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  realpathSync,
  writeFileSync,
  unlinkSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { SessionStore } from "./session-store.js";
import type { BackendType } from "./session-types.js";
import { isValidEffort, supportsUltracode } from "./effort.js";
import { isValidCodexEffort } from "./codex-models.js";
import { claudeTranscriptExists } from "./claude-session-history.js";
import type { RecorderManager } from "./recorder.js";
import { CodexAdapter } from "./codex-adapter.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { companionBus } from "./event-bus.js";
import { markClaudeCliRuntimeIncompatible, parseClaudeVersion } from "./claude-cli-check.js";
import { getSettings } from "./settings-manager.js";
import { DEFAULT_CLI_BRIDGE_MODE } from "./cli-bridge-mode.js";
import { resolveSessionEnv } from "./session-env.js";
import {
  getLegacyCodexHome,
  resolveCompanionCodexSessionHome,
  authRefreshedAt,
} from "./codex-home.js";

/**
 * Who asked for this kill/relaunch.
 *
 * Both paths SIGTERM a possibly-live CLI, and the log used to name only the
 * session. When a session died mid-answer there was no way to tell a user
 * Reconnect from an auto-relaunch from a model change, which left the
 * "sessions die on refresh" bug unattributable for weeks.
 */
function callerOf(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(3, 7);
  return lines
    .map((l) => l.trim().replace(/^at\s+/, "").split(" ")[0])
    .filter((f) => f && !f.startsWith("("))
    .join(" < ") || "unknown";
}

/** Whether WebSocket transport is enabled for Codex sessions. */
function isCodexWsTransportEnabled(): boolean {
  const val = (process.env.COMPANION_CODEX_TRANSPORT || "ws").toLowerCase();
  return val === "ws" || val === "websocket";
}

/** Find a free TCP port in the given range by attempting to listen on each. */
async function findFreePort(
  start = 4500,
  end = 4600,
  isReserved?: (port: number) => boolean,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (isReserved?.(port)) continue;
    try {
      const server = Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
        },
      });
      server.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

function sanitizeSpawnArgsForLog(args: string[]): string {
  const secretKeyPattern = /(token|key|secret|password)/i;
  const out = [...args];
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "-e" && i + 1 < out.length) {
      const envPair = out[i + 1];
      const eqIdx = envPair.indexOf("=");
      if (eqIdx > 0) {
        const k = envPair.slice(0, eqIdx);
        if (secretKeyPattern.test(k)) {
          out[i + 1] = `${k}=***`;
        }
      }
    }
  }
  return out.join(" ");
}

const CODEX_WS_PROXY_PATH = fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url));

/**
 * Build the command and environment that start a Codex app-server.
 * Prefers the `node` binary that sits next to the codex launcher (avoids
 * shebang/PATH issues with nvm installs) and puts that directory first on PATH.
 */
function buildCodexSpawn(
  binary: string,
  args: string[],
  env: Record<string, string> | undefined,
  codexHome: string,
): { spawnCmd: string[]; spawnEnv: Record<string, string | undefined> } {
  const binaryDir = resolve(binary, "..");
  const siblingNode = join(binaryDir, "node");
  const enrichedPath = getEnrichedPath();
  const pathSep = process.platform === "win32" ? ";" : ":";
  const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

  let spawnCmd: string[];
  if (existsSync(siblingNode)) {
    let codexScript: string;
    try {
      codexScript = realpathSync(binary);
    } catch {
      codexScript = binary;
    }
    spawnCmd = [siblingNode, codexScript, ...args];
  } else {
    // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn
    const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
    spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
  }

  return {
    spawnCmd,
    spawnEnv: {
      ...process.env,
      CLAUDECODE: undefined,
      ...env,
      CODEX_HOME: codexHome,
      PATH: spawnPath,
    },
  };
}

/**
 * Another session's conversation a new session starts from as a COPY
 * (agent "fork" runs). Used only until the new session has its own
 * cliSessionId: from then on relaunches resume the fork, never the source.
 */
export interface ForkSource {
  /** Companion session id of the source (for logs and the UI). */
  sessionId: string;
  /** Claude transcript id / Codex thread id to copy. */
  cliSessionId: string;
  /**
   * Codex only: the source thread's rollout file. Every Companion session
   * has its own CODEX_HOME, where the source thread is unknown, so the file
   * is copied into the new session's home before `thread/fork` (forking by
   * `path` does not work: Codex still looks the thread up by id).
   */
  rolloutPath?: string;
}

export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  /** Reasoning-effort level for effort-capable models (fable-5, Opus 4.6+). */
  effort?: string;
  /** Claude only: standing dynamic-workflow orchestration (see buildUltracodeArgs). */
  ultracode?: boolean;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  /**
   * Consecutive quick exits right after a `--resume` launch. Reset by any run
   * that survives the startup window. See the exit handler for why one quick
   * exit is NOT enough to discard cliSessionId.
   */
  resumeFailures?: number;
  archived?: boolean;
  /** User-facing session name */
  name?: string;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** If session was created from an existing Claude thread/session. */
  resumeSessionAt?: string;
  /** Whether the resumed session used --fork-session. */
  forkSession?: boolean;
  /** Start from a copy of another session's conversation (see ForkSource). */
  forkSource?: ForkSource;
  /** If this session was spawned by an agent */
  agentId?: string;
  /** Human-readable name of the agent that spawned this session */
  agentName?: string;
  /**
   * Claude only: built-in tools the session is limited to (`--tools`).
   * Persisted so every relaunch keeps the restriction.
   */
  tools?: string[];
  /**
   * Explicitly chosen env profile. Only the slug is persisted: the variables
   * are re-read from the profile at every spawn and relaunch.
   */
  envSlug?: string;
  /** Linear connection whose API key is injected as LINEAR_API_KEY at every spawn. */
  linearConnectionId?: string;
  /** Main repo root of a worktree session, used to match project env profiles. */
  repoRoot?: string;
  /** Names (never values) of the env profiles applied at the last spawn. */
  envProfiles?: string[];

  // Codex WebSocket transport fields
  /** Port used for Codex WebSocket transport. */
  codexWsPort?: number;
  /** Full WebSocket URL for the Codex app-server. */
  codexWsUrl?: string;

  /** One-shot token validated on the CLI WS upgrade when cliBridgeMode === "jsonHandoff". */
  bridgeToken?: string;
  /** Path to temp bridge descriptor file used in jsonHandoff mode; deleted on exit. */
  bridgeConfigPath?: string;
}

export interface LaunchOptions {
  model?: string;
  /** Reasoning-effort level (Claude only); passed as `--effort` when the model supports it. */
  effort?: string;
  /** Claude only: standing dynamic-workflow orchestration (see buildUltracodeArgs). */
  ultracode?: boolean;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  allowedTools?: string[];
  /**
   * Claude only: restrict the built-in tool set (`--tools a,b,c`). Unlike
   * allowedTools (pre-approval only) this really removes the other tools.
   */
  tools?: string[];
  /**
   * Request/agent env, applied on top of the resolved env profiles. Persisted
   * (0600, outside launcher.json) so relaunches after a restart keep it.
   */
  env?: Record<string, string>;
  /** Explicitly chosen env profile slug (see SdkSessionInfo.envSlug). */
  envSlug?: string;
  /** Linear connection id for LINEAR_API_KEY injection. */
  linearConnectionId?: string;
  /** Main repo root for worktree sessions (project env profile matching). */
  repoRoot?: string;
  backendType?: BackendType;
  /** Codex sandbox mode. */
  codexSandbox?: "workspace-write" | "danger-full-access";
  /** Whether Codex internet/web search should be enabled for this session. */
  codexInternetAccess?: boolean;
  /** Optional override for CODEX_HOME used by Codex sessions. */
  codexHome?: string;
  /** Start from a specific prior Claude session/thread point. */
  resumeSessionAt?: string;
  /** Fork a new Claude session when resuming from prior context. */
  forkSession?: boolean;
  /** Start from a copy of another session's conversation (Claude and Codex). */
  forkSource?: ForkSource;
  /** Optional system prompt to inject into Codex sessions (e.g. Linear context). */
  systemPrompt?: string;
}

/**
 * Manages CLI backend processes (Claude Code via --sdk-url WebSocket,
 * or Codex via app-server stdio/WebSocket).
 */
export class CliLauncher {
  /** An exit faster than this after `--resume` counts as a failed resume attempt. */
  static readonly RESUME_QUICK_EXIT_MS = 5000;
  /** Consecutive quick exits (with the transcript present) before giving up on it. */
  static readonly RESUME_MAX_FAILURES = 3;
  /**
   * Graceful-shutdown window for the OLD process on relaunch before SIGKILL.
   * Env-overridable (COMPANION_RELAUNCH_GRACE_MS) so tests don't burn 5 real
   * seconds per relaunch.
   */
  static get RELAUNCH_GRACE_MS(): number {
    const v = Number(process.env.COMPANION_RELAUNCH_GRACE_MS);
    return Number.isFinite(v) && v > 0 ? v : 5000;
  }
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, Subprocess>();
  /** Recent stderr (bounded) per stdio session, used to detect a too-old CLI. */
  private recentStderr = new Map<string, string>();
  /** Sidecar Node proxy processes used by Codex WebSocket transport. */
  private codexWsProxies = new Map<string, Subprocess>();
  /** Host-mode Codex WS listen ports currently reserved by active sessions. */
  private claimedCodexWsPorts = new Set<number>();
  /**
   * Request/agent env per session. Mirrors what the store persists (0600
   * sidecar) so tests without a store and the hot path avoid a disk read.
   */
  private requestEnvs = new Map<string, Record<string, string>>();
  private port: number;
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  /** Path to the self-signed CA cert (NODE_EXTRA_CA_CERTS) when tlsLoopback is in use. */
  private tlsCaPath: string | null = null;
  constructor(port: number) {
    this.port = port;
  }

  /** Attach a persistent store for surviving server restarts. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /**
   * Register the embedded TLS proxy CA path. Spawned Claude CLI processes
   * receive this path via NODE_EXTRA_CA_CERTS so they trust our self-signed
   * wss://beacon.claude-ai.staging.ant.dev cert.
   */
  setTlsCaPath(caPath: string | null): void {
    this.tlsCaPath = caPath;
  }

  /** Persist launcher state to disk. */
  private persistState(): void {
    if (!this.store) return;
    const data = Array.from(this.sessions.values());
    this.store.saveLauncher(data);
  }

  private claimCodexWsPort(port: number): void {
    this.claimedCodexWsPorts.add(port);
  }

  private releaseCodexWsPort(info: SdkSessionInfo | undefined): void {
    if (!info) return;
    if (typeof info.codexWsPort !== "number") return;
    this.claimedCodexWsPorts.delete(info.codexWsPort);
    info.codexWsPort = undefined;
    info.codexWsUrl = undefined;
  }

  /**
   * Restore sessions from disk and check which PIDs are still alive.
   * Returns the number of recovered sessions.
   */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const data = this.store.loadLauncher<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      // Check if the process is still alive
      if (info.state !== "exited") {
        if (info.pid) {
          try {
            process.kill(info.pid, 0); // signal 0 = just check if alive
            info.state = "starting"; // WS not yet re-established, wait for CLI to reconnect
            this.sessions.set(info.sessionId, info);
            recovered++;
          } catch {
            // Process is dead
            info.state = "exited";
            info.exitCode = -1;
            this.sessions.set(info.sessionId, info);
          }
        } else {
          this.sessions.set(info.sessionId, info);
        }
      } else {
        // Already exited
        this.sessions.set(info.sessionId, info);
      }

      // Avoid reusing ports already owned by recovered Codex sessions.
      if (
        info.backendType === "codex"
        && info.state !== "exited"
        && typeof info.codexWsPort === "number"
      ) {
        this.claimCodexWsPort(info.codexWsPort);
      }
    }
    if (recovered > 0) {
      console.log(`[cli-launcher] Recovered ${recovered} live session(s) from disk`);
    }
    return recovered;
  }

  /**
   * Launch a new CLI session (Claude Code or Codex).
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();
    const backendType = options.backendType || "claude";

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      effort: options.effort,
      ultracode: options.ultracode,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
      backendType,
    };

    if (options.resumeSessionAt) {
      info.resumeSessionAt = options.resumeSessionAt;
      info.forkSession = options.forkSession === true;
    }

    if (backendType === "codex") {
      info.codexInternetAccess = options.codexInternetAccess === true;
      info.codexSandbox = options.codexSandbox;
    }

    if (backendType === "claude" && options.tools && options.tools.length > 0) {
      info.tools = [...options.tools];
    }
    if (options.forkSource) info.forkSource = { ...options.forkSource };
    if (options.envSlug) info.envSlug = options.envSlug;
    if (options.linearConnectionId) info.linearConnectionId = options.linearConnectionId;
    if (options.repoRoot) info.repoRoot = options.repoRoot;

    this.sessions.set(sessionId, info);
    if (options.env && Object.keys(options.env).length > 0) {
      this.requestEnvs.set(sessionId, { ...options.env });
      this.store?.saveRequestEnv(sessionId, options.env);
    }

    const spawnOptions = { ...options, env: this.resolveSpawnEnv(sessionId, info) };
    if (backendType === "codex") {
      this.spawnCodex(sessionId, info, spawnOptions);
    } else {
      this.spawnCLI(sessionId, info, spawnOptions);
    }
    return info;
  }

  /**
   * Build the env overlay for a spawn from persisted references only (env
   * slug, cwd/repo root, Linear connection, the request-env sidecar) so the
   * first launch and every relaunch — including after a server restart —
   * resolve exactly the same way. Records the applied profile names.
   */
  private resolveSpawnEnv(sessionId: string, info: SdkSessionInfo): Record<string, string> {
    let requestEnv = this.requestEnvs.get(sessionId);
    if (!requestEnv && this.store) {
      requestEnv = this.store.loadRequestEnv(sessionId);
      if (requestEnv) this.requestEnvs.set(sessionId, requestEnv);
    }
    const { env, profileNames } = resolveSessionEnv({
      cwd: info.cwd,
      repoRoot: info.repoRoot,
      backendType: info.backendType,
      envSlug: info.envSlug,
      linearConnectionId: info.linearConnectionId,
      requestEnv,
    });
    info.envProfiles = profileNames.length > 0 ? profileNames : undefined;
    return env;
  }

  private forgetRequestEnv(sessionId: string): void {
    this.requestEnvs.delete(sessionId);
    this.store?.removeRequestEnv(sessionId);
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back to the same session in the WsBridge.
   */
  async relaunch(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    console.log(`[cli-launcher] relaunch() requested for ${sessionId} — by: ${callerOf()}`);
    const info = this.sessions.get(sessionId);
    if (!info) return { ok: false, error: "Session not found" };

    // Kill old process(es) if still alive.
    // Snapshot both handles first because killing the proxy can trigger the
    // WS session exit handler, which clears `this.processes`.
    const oldProc = this.processes.get(sessionId);
    const oldProxy = this.codexWsProxies.get(sessionId);
    if (oldProxy) {
      try {
        oldProxy.kill("SIGTERM");
        await Promise.race([
          oldProxy.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
      this.codexWsProxies.delete(sessionId);
    }
    if (oldProc) {
      // The old process MUST be gone before the new one starts: a Codex
      // app-server that is still shutting down keeps the thread-writer lock,
      // so a new app-server resuming the same thread hits "thread-store
      // conflict: already has an active writer" and the adapter falls back to
      // a FRESH thread — losing the whole context (observed 2026-09-11: a 2 s
      // grace was not enough, the old process outlived it as an orphan holding
      // the lock). Give it a real grace period, then escalate to SIGKILL and
      // wait for the exit for real.
      try {
        oldProc.kill("SIGTERM");
        const gone = await Promise.race([
          oldProc.exited.then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), CliLauncher.RELAUNCH_GRACE_MS)),
        ]);
        if (!gone) {
          console.warn(`[cli-launcher] relaunch: old process for ${sessionId} still alive after ${CliLauncher.RELAUNCH_GRACE_MS}ms — SIGKILL`);
          try { oldProc.kill("SIGKILL"); } catch {}
          await Promise.race([
            oldProc.exited,
            new Promise((r) => setTimeout(r, Math.min(2000, CliLauncher.RELAUNCH_GRACE_MS))),
          ]);
        }
      } catch {}
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance — kill by PID
      try { process.kill(info.pid, "SIGTERM"); } catch {}
    }

    // Release any Codex port claim before picking a new one.
    this.releaseCodexWsPort(info);

    info.state = "starting";

    const runtimeEnv = this.resolveSpawnEnv(sessionId, info);

    if (info.backendType === "codex") {
      this.spawnCodex(sessionId, info, {
        model: info.model,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        codexSandbox: info.codexSandbox,
        codexInternetAccess: info.codexInternetAccess,
        env: runtimeEnv,
      });
    } else {
      this.spawnCLI(sessionId, info, {
        model: info.model,
        effort: info.effort,
        ultracode: info.ultracode,
        permissionMode: info.permissionMode,
        cwd: info.cwd,
        resumeSessionId: info.cliSessionId,
        env: runtimeEnv,
      });
    }
    return { ok: true };
  }

  /**
   * Get all sessions in "starting" state (awaiting CLI WebSocket connection).
   */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  private spawnCLI(sessionId: string, info: SdkSessionInfo, options: LaunchOptions & { resumeSessionId?: string }): void {
    let binary = options.claudeBinary || "claude";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    // Use the numeric loopback (127.0.0.1) instead of "localhost": Claude Code v1.2.1+ rejects the literal hostname
    // "localhost" in --sdk-url as a CSWSH hardening measure (issue #655).
    //
    // Claude Code v2.1.142+ introduced a further restriction: --sdk-url is
    // rejected unless its host is one of a hardcoded set of Anthropic
    // hostnames (api.anthropic.com, beacon.claude-ai.staging.ant.dev, ...).
    // When `cliBridgeMode === "tlsLoopback"` we present that hostname via
    // an embedded TLS proxy listening on `COMPANION_TLS_PORT` (default
    // 8443). The user must add a single line to /etc/hosts to route the
    // hostname back to 127.0.0.1, and `NODE_EXTRA_CA_CERTS` is propagated
    // so the spawned CLI trusts our self-signed cert.
    const settings = getSettings();
    const bridgeMode = settings.cliBridgeMode ?? DEFAULT_CLI_BRIDGE_MODE;
    const tlsBridgeHost = (process.env.COMPANION_SDK_BRIDGE_HOST
      || "beacon.claude-ai.staging.ant.dev").trim() || "beacon.claude-ai.staging.ant.dev";
    const tlsBridgePort = Number(process.env.COMPANION_SDK_BRIDGE_PORT) || 8443;

    // stdio bridge mode: no --sdk-url at all; the NDJSON
    // protocol flows over the child's stdin/stdout. Immune to the Anthropic
    // endpoint allowlist that broke ws --sdk-url on Claude Code 2.1.142+/2.1.175.
    const useStdio = bridgeMode === "stdio";

    let sdkUrl: string;
    if (bridgeMode === "tlsLoopback") {
      sdkUrl = `wss://${tlsBridgeHost}:${tlsBridgePort}/ws/cli/${sessionId}`;
    } else {
      sdkUrl = `ws://127.0.0.1:${this.port}/ws/cli/${sessionId}`;
    }

    // Claude Code rejects bypassPermissions when running with root/sudo, so
    // downgrade it when this server itself runs as root.
    let effectivePermissionMode = options.permissionMode;
    const isRootProcess = typeof process.getuid === "function" && process.getuid() === 0;
    const shouldDowngradeRootBypass =
      isRootProcess
      && options.permissionMode === "bypassPermissions"
      && process.env.COMPANION_FORCE_BYPASS_AS_ROOT !== "1";

    if (shouldDowngradeRootBypass) {
      console.warn(
        `[cli-launcher] Session ${sessionId}: downgrading root permission mode ` +
        `from bypassPermissions to acceptEdits.`,
      );
      effectivePermissionMode = "acceptEdits";
      info.permissionMode = "acceptEdits";
    }

    // Optional: just-every/code-style JSON handoff. When enabled, write a temp
    // descriptor with a one-shot token and pass its path via
    // CLAUDE_BRIDGE_CONFIG env var instead of --sdk-url on argv.
    // This is forward-compatible if Anthropic further restricts --sdk-url
    // (e.g. drops it entirely or adds origin/handshake checks).
    const useJsonHandoff = bridgeMode === "jsonHandoff";
    let bridgeConfigPath: string | undefined;
    if (useJsonHandoff) {
      bridgeConfigPath = join(tmpdir(), `companion-bridge-${sessionId}.json`);
      const token = randomUUID();
      const descriptor = {
        version: 1,
        transport: "ws",
        url: sdkUrl,
        sessionId,
        token,
      };
      try {
        writeFileSync(bridgeConfigPath, JSON.stringify(descriptor), { mode: 0o600 });
        info.bridgeToken = token;
        info.bridgeConfigPath = bridgeConfigPath;
      } catch (err) {
        console.warn(`[cli-launcher] Failed to write bridge descriptor for ${sessionId}: ${err}. Falling back to --sdk-url.`);
        bridgeConfigPath = undefined;
      }
    }

    const args: string[] = [
      ...(bridgeConfigPath || useStdio ? [] : ["--sdk-url", sdkUrl]),
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      // Required on newer Claude Code versions to emit streaming chunk events.
      "--include-partial-messages",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    // Reasoning effort: only pass `--effort` when the chosen model actually
    // supports it; passing it to a non-supporting model is rejected. This seeds
    // the launch — later changes are applied at runtime (apply_flag_settings)
    // and recorded back here, so a relaunch resumes on the current level.
    if (options.effort && isValidEffort(options.model, options.effort)) {
      args.push("--effort", options.effort);
    }
    // Ultracode is a per-session setting the CLI never persists, and Companion
    // relaunches the CLI often (model/effort change, mid-turn recovery). Without
    // re-passing it here every relaunch would silently drop it.
    if (options.ultracode && supportsUltracode(options.model)) {
      args.push("--settings", JSON.stringify({ ultracode: true }));
    }
    if (effectivePermissionMode) {
      args.push("--permission-mode", effectivePermissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }
    // Read from the session record so relaunches keep the restriction.
    if (info.tools && info.tools.length > 0) {
      args.push("--tools", info.tools.join(","));
    }
    // Fork: start from a COPY of another session's transcript, until this
    // session has a transcript of its own (then --resume below takes over).
    const forkFrom = !options.resumeSessionId && !info.cliSessionId ? info.forkSource?.cliSessionId : undefined;
    if (options.resumeSessionAt) {
      args.push("--resume-session-at", options.resumeSessionAt);
    }
    if (options.forkSession || forkFrom) {
      args.push("--fork-session");
    }
    if (forkFrom) {
      args.push("--resume", forkFrom);
    }

    // When relaunching, pass --resume to restore the CLI's conversation context.
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }

    // Headless WS modes need the -p "" placeholder (the actual prompt arrives
    // over the transport). In stdio mode the CLI reads its input stream from
    // stdin, so passing -p would make it treat "" as a one-shot prompt.
    if (!useStdio) {
      args.push("-p", "");
    }

    // On Windows, .cmd/.bat files cannot be spawned directly by Bun.spawn;
    // they must be invoked via cmd.exe /c.
    const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
    const spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: undefined,
      // Have the CLI report its own turn state (session_state_changed:
      // idle | running | requires_action) instead of Companion inferring it.
      // Off by default in the CLI; see session-work.ts for how it is used.
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      ...options.env,
      PATH: getEnrichedPath(),
      ...(bridgeConfigPath ? { CLAUDE_BRIDGE_CONFIG: bridgeConfigPath } : {}),
      ...(bridgeMode === "tlsLoopback" && this.tlsCaPath
        ? { NODE_EXTRA_CA_CERTS: this.tlsCaPath }
        : {}),
    };

    console.log(
      `[cli-launcher] Spawning session ${sessionId}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: info.cwd,
      env: spawnEnv,
      // In stdio mode the child's stdin carries the NDJSON input stream.
      stdin: useStdio ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    if (useStdio) {
      // stdout is the protocol channel and is consumed by the ClaudeAdapter's
      // stdio reader. Pipe only stderr here — and tap it into a bounded buffer
      // so a too-old CLI ("unknown option") can be detected on early exit.
      this.recentStderr.set(sessionId, "");
      if (proc.stderr && typeof proc.stderr !== "number") {
        this.pipeStream(sessionId, proc.stderr, "stderr", (text) => {
          const prev = this.recentStderr.get(sessionId) ?? "";
          this.recentStderr.set(sessionId, (prev + text).slice(-4096));
        });
      }
      // Hand the live process to the bridge, which attaches a ClaudeAdapter to
      // its stdin/stdout (mirrors the /ws/cli open path for WS sessions).
      info.state = "connected";
      companionBus.emit("session:cli-stdio-ready", {
        sessionId,
        proc: proc as Subprocess<"pipe", "pipe", "pipe">,
      });
    } else {
      // Stream stdout/stderr for debugging
      this.pipeOutput(sessionId, proc);
    }

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // A quick exit right after `--resume` is AMBIGUOUS: the transcript may be
        // gone (cleanupPeriodDays pruned it), or the launch simply failed for a
        // reason that has nothing to do with the transcript — network down, API
        // 5xx, a relaunch racing another relaunch. Clearing cliSessionId is
        // irreversible: it throws away the whole conversation context. So it is
        // only done when the evidence is unambiguous:
        //  - the transcript file is genuinely missing on disk, or
        //  - resuming the SAME transcript has failed this many times in a row.
        // (2026-09-08: a 3.4 s exit during a network drop discarded a 13.7 MB,
        // perfectly intact transcript. This guard is the fix.)
        const uptime = Date.now() - spawnedAt;
        if (uptime < CliLauncher.RESUME_QUICK_EXIT_MS && options.resumeSessionId) {
          const resumeId = options.resumeSessionId;
          const transcriptOnDisk = claudeTranscriptExists(resumeId);
          const failures = (session.resumeFailures ?? 0) + 1;
          session.resumeFailures = failures;
          if (!transcriptOnDisk) {
            console.error(`[cli-launcher] Session ${sessionId} exited ${uptime}ms after --resume and transcript ${resumeId} is missing on disk. Clearing cliSessionId for fresh start.`);
            session.cliSessionId = undefined;
            session.resumeFailures = 0;
          } else if (failures >= CliLauncher.RESUME_MAX_FAILURES) {
            console.error(`[cli-launcher] Session ${sessionId} exited ${uptime}ms after --resume ${failures} times in a row (transcript present). Clearing cliSessionId for fresh start.`);
            session.cliSessionId = undefined;
            session.resumeFailures = 0;
          } else {
            console.warn(`[cli-launcher] Session ${sessionId} exited ${uptime}ms after --resume (attempt ${failures}/${CliLauncher.RESUME_MAX_FAILURES}); transcript is on disk — keeping cliSessionId for the next relaunch.`);
          }
        } else if (uptime >= CliLauncher.RESUME_QUICK_EXIT_MS) {
          // A run that survived the startup window proves the transcript resumes fine.
          session.resumeFailures = 0;
        }

        // Runtime backstop for stdio mode: a quick non-zero exit whose stderr
        // complains about an unknown/unsupported flag means the installed CLI
        // is too old for this Companion build. Flag it so the UI banner asks
        // the user to run `claude update`.
        if (useStdio && (exitCode ?? 1) !== 0 && uptime < 10000) {
          const stderr = this.recentStderr.get(sessionId) ?? "";
          if (/(unknown|unrecognized|invalid)\s+(option|argument|flag)|--(include-partial-messages|input-format|output-format)\b[^\n]*\b(unknown|unrecognized|invalid|not)\b/i.test(stderr)) {
            const detail = (stderr.match(/[^\n]*(?:unknown|unrecognized|invalid)[^\n]*/i)?.[0] ?? "unsupported CLI flag").trim().slice(0, 200);
            console.error(`[cli-launcher] Session ${sessionId}: Claude CLI appears too old for stdio mode — ${detail}`);
            markClaudeCliRuntimeIncompatible(parseClaudeVersion(stderr), detail);
          }
        }
      }
      this.recentStderr.delete(sessionId);
      this.processes.delete(sessionId);
      if (bridgeConfigPath) {
        try { unlinkSync(bridgeConfigPath); } catch { /* already gone */ }
      }
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Spawn a Codex app-server subprocess for a session.
   * Transport (stdio vs WebSocket) is selected by `COMPANION_CODEX_TRANSPORT`.
   */
  private prepareCodexHome(codexHome: string): void {
    mkdirSync(codexHome, { recursive: true });

    const legacyHome = getLegacyCodexHome();
    if (resolve(legacyHome) === resolve(codexHome) || !existsSync(legacyHome)) {
      return;
    }

    // Bootstrap only the user-level artifacts Codex needs (auth/config/skills),
    // while intentionally skipping sessions/sqlite to avoid stale rollout indexes.
    // NOTE: auth.json is deliberately NOT copied — see linkAuthJson().
    const fileSeeds = ["config.toml", "models_cache.json", "version.json"];
    for (const name of fileSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          copyFileSync(src, dest);
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name} from legacy home:`, e);
      }
    }

    const dirSeeds = ["skills", "vendor_imports", "prompts", "rules"];
    for (const name of dirSeeds) {
      try {
        const src = join(legacyHome, name);
        const dest = join(codexHome, name);
        if (!existsSync(dest) && existsSync(src)) {
          cpSync(src, dest, { recursive: true, dereference: true });
        }
      } catch (e) {
        console.warn(`[cli-launcher] Failed to bootstrap ${name}/ from legacy home:`, e);
      }
    }

    this.linkAuthJson(codexHome, legacyHome);
    this.linkGlobalAgentsMd(codexHome, legacyHome);
  }

  /**
   * Expose the user's global Codex instructions (~/.codex/AGENTS.md) to the
   * session. Codex reads global instructions from $CODEX_HOME/AGENTS.md, and
   * every Companion session gets its own CODEX_HOME, so without this link the
   * global file never reaches Companion-hosted Codex sessions.
   *
   * A link (not a copy) keeps sessions in step with later edits. A real file
   * already in the session home is the user's per-session override and is left
   * alone; a link whose global source is gone is removed.
   */
  private linkGlobalAgentsMd(codexHome: string, legacyHome: string): void {
    const src = join(legacyHome, "AGENTS.md");
    const dest = join(codexHome, "AGENTS.md");
    try {
      let destStat: ReturnType<typeof lstatSync> | null = null;
      try { destStat = lstatSync(dest); } catch { /* absent */ }
      if (destStat && !destStat.isSymbolicLink()) return; // per-session override

      const srcExists = existsSync(src);
      if (destStat) {
        if (srcExists && resolve(readlinkSync(dest)) === resolve(src)) return; // already correct
        unlinkSync(dest);
      }
      if (srcExists) symlinkSync(src, dest);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to link AGENTS.md to the global Codex home:`, e);
    }
  }

  /**
   * Point a session's auth.json at the user's global one instead of copying it.
   *
   * ChatGPT-plan OAuth rotates refresh tokens: every refresh mints a new one and
   * revokes the previous one server-side. A per-session *copy* therefore dies the
   * moment any other copy refreshes — permanently, because the dead token is on
   * disk, so reconnecting or respawning re-reads the same revoked credentials and
   * the user sees "your refresh token was revoked. Please log out and sign in
   * again." Sharing one file is what Codex itself expects from concurrent
   * processes (it re-reads auth.json before refreshing and skips the refresh when
   * another process already rotated it), and Codex writes auth.json in place, so
   * the symlink survives a rotation and every session sees the new token.
   *
   * Self-healing: a regular file left by an older Companion (or by a write that
   * replaced the link) is folded back into the global home when it holds the
   * newer rotation, then replaced by the symlink.
   */
  private linkAuthJson(codexHome: string, legacyHome: string): void {
    const src = join(legacyHome, "auth.json");
    const dest = join(codexHome, "auth.json");
    try {
      let destStat: ReturnType<typeof lstatSync> | null = null;
      try { destStat = lstatSync(dest); } catch { /* absent */ }

      if (destStat?.isSymbolicLink()) {
        if (resolve(readlinkSync(dest)) === resolve(src)) return; // already correct
        unlinkSync(dest);
      } else if (destStat) {
        // A real file: keep whichever credentials are newer before dropping it.
        if (!existsSync(src) || authRefreshedAt(dest) > authRefreshedAt(src)) {
          copyFileSync(dest, src);
        }
        unlinkSync(dest);
      }

      if (!existsSync(src)) return; // nothing to link to; Codex will prompt to log in
      symlinkSync(src, dest);
    } catch (e) {
      console.warn(`[cli-launcher] Failed to link auth.json to the global Codex home:`, e);
    }
  }

  /**
   * Codex fork (see ForkSource): while the session has no thread of its own,
   * copy the source rollout into this session's CODEX_HOME at the same
   * sessions/YYYY/MM/DD path, so `thread/fork` finds it by id. The source
   * file is only read. Returns the thread id to fork, or undefined.
   */
  private prepareCodexFork(codexHome: string, info: SdkSessionInfo): string | undefined {
    const fork = info.forkSource;
    if (info.cliSessionId || !fork) return undefined;
    if (fork.rolloutPath) {
      const marker = `${sep}sessions${sep}`;
      const at = fork.rolloutPath.lastIndexOf(marker);
      const rel = at >= 0 ? fork.rolloutPath.slice(at + marker.length) : basename(fork.rolloutPath);
      const dest = join(codexHome, "sessions", rel);
      try {
        if (!existsSync(dest)) {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(fork.rolloutPath, dest);
        }
      } catch (err) {
        // thread/fork then fails with Codex's own "no rollout found" error,
        // which fails the run with a clear message.
        console.warn(`[cli-launcher] Could not copy the fork source rollout ${fork.rolloutPath}:`, err);
      }
    }
    return fork.cliSessionId;
  }

  private spawnCodex(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
    const useWs = isCodexWsTransportEnabled();
    if (useWs) {
      this.spawnCodexWs(sessionId, info, options);
    } else {
      this.spawnCodexStdio(sessionId, info, options);
    }
  }

  /**
   * Spawn Codex with WebSocket transport.
   * Codex listens on `ws://127.0.0.1:PORT`, Companion connects as a client.
   */
  private async spawnCodexWs(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): Promise<void> {
    const connectTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_WS_CONNECT_TIMEOUT_MS ?? "", 10) || 30000);
    const pongTimeoutMs = Math.max(1000, parseInt(process.env.COMPANION_CODEX_PONG_TIMEOUT_MS ?? "", 10) || 30000);

    let binary = options.codexBinary || "codex";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    let codexPort: number;
    try {
      codexPort = await findFreePort(
        4500,
        4600,
        (port) => this.claimedCodexWsPorts.has(port),
      );
      this.claimCodexWsPort(codexPort);
      // Set immediately after claiming so any downstream failure can release it.
      info.codexWsPort = codexPort;
    } catch (err) {
      console.error(`[cli-launcher] Failed to find free port for Codex WS: ${err}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return;
    }

    const listenAddr = `ws://127.0.0.1:${codexPort}`;

    const args: string[] = ["app-server", "--listen", listenAddr];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    // Reasoning effort: Codex takes it as launch config (`model_reasoning_effort`),
    // not as a runtime call — same shape as Claude's `--effort` flag, so a change
    // means relaunch with thread/resume. Levels are per-model, hence the check.
    if (options.effort && isValidCodexEffort(options.model, options.effort)) {
      args.push("-c", `model_reasoning_effort=${options.effort}`);
    }
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    this.prepareCodexHome(codexHome);

    const { spawnCmd, spawnEnv } = buildCodexSpawn(binary, args, options.env, codexHome);

    console.log(
      `[cli-launcher] Spawning Codex WS session ${sessionId}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: info.cwd,
      env: spawnEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stdout/stderr for debugging (JSON-RPC goes over WebSocket now)
    this.pipeOutput(sessionId, proc);

    // Store WS metadata
    const wsUrl = `ws://127.0.0.1:${codexPort}`;
    info.codexWsUrl = wsUrl;

    // Connect to Codex app-server through a Node helper process that uses the
    // `ws` package directly (with perMessageDeflate disabled). This avoids a Bun
    // runtime compatibility issue where the `ws` client can mis-handle a valid
    // 101 upgrade response from Codex's Rust WS server.
    const proxyNodeCandidate = join(resolve(binary, ".."), "node");
    const proxyNode = existsSync(proxyNodeCandidate) ? proxyNodeCandidate : "node";
    const proxyProc = Bun.spawn([proxyNode, CODEX_WS_PROXY_PATH, wsUrl, String(connectTimeoutMs), String(pongTimeoutMs)], {
      cwd: info.cwd,
      env: {
        ...process.env,
        PATH: getEnrichedPath(),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.codexWsProxies.set(sessionId, proxyProc);
    // proxy stdout is the JSON-RPC protocol stream (consumed by CodexAdapter).
    // Only pipe stderr for diagnostics to avoid locking stdout.
    const proxyStderr = proxyProc.stderr;
    if (proxyStderr && typeof proxyStderr !== "number") {
      this.pipeStream(sessionId, proxyStderr, "stderr");
    }

    // Create CodexAdapter using stdio transport to the proxy process.
    const adapter = new CodexAdapter(proxyProc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      forkFromThreadId: this.prepareCodexFork(codexHome, info),
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
      killProcess: async () => {
        try {
          proxyProc.kill("SIGTERM");
        } catch {}
        try {
          proc.kill("SIGTERM");
        } catch {}
        await Promise.race([
          Promise.allSettled([proxyProc.exited, proc.exited]),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      },
    });

    // Handle init errors
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex WS session ${sessionId} init failed: ${error}`);
      companionBus.emit("session:init-failed", { sessionId, error });
      try { proxyProc.kill("SIGTERM"); } catch {}
      this.codexWsProxies.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
        this.releaseCodexWsPort(session);
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    info.state = "connected";

    // Monitor both the proxy connection process and Codex itself: whichever
    // exits first ends the session.
    let exitHandled = false;
    const handleWsSessionExit = (exitCode: number | null, source: "proxy" | "codex") => {
      if (exitHandled) return;
      exitHandled = true;
      console.log(`[cli-launcher] Codex WS session ${sessionId} exited via ${source} (code=${exitCode})`);

      // Notify the adapter that the transport is gone so it can clean up
      // pending promises and stop accepting messages immediately.
      adapter.handleTransportClose();

      // Kill the other process too — if the proxy exits, kill Codex and vice versa.
      // This prevents orphaned processes lingering after a partial crash.
      // Note: The SIGTERM will cause the sibling to exit, which fires its own
      // exit handler, but the `exitHandled` guard above ensures it's a no-op.
      if (source === "proxy") {
        try { proc.kill("SIGTERM"); } catch {}
      } else {
        try { proxyProc.kill("SIGTERM"); } catch {}
      }

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
        this.releaseCodexWsPort(session);
      }
      this.processes.delete(sessionId);
      this.codexWsProxies.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    };

    proxyProc.exited.then((exitCode) => {
      handleWsSessionExit(exitCode, "proxy");
    });

    proc.exited.then((exitCode) => {
      handleWsSessionExit(exitCode, "codex");
    });

    this.persistState();
  }

  /**
   * Spawn Codex with stdio transport (legacy).
   * Unlike Claude Code (which connects back via WebSocket), Codex uses stdin/stdout.
   */
  private spawnCodexStdio(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {

    let binary = options.codexBinary || "codex";
    const resolved = resolveBinary(binary);
    if (resolved) {
      binary = resolved;
    } else {
      console.error(`[cli-launcher] Binary "${binary}" not found in PATH`);
      info.state = "exited";
      info.exitCode = 127;
      this.persistState();
      return;
    }

    const args: string[] = ["app-server"];
    // Enable Codex multi-agent mode by default (product decision).
    args.push("--enable", "multi_agent");
    const internetEnabled = options.codexInternetAccess !== false;
    args.push("-c", `tools.webSearch=${internetEnabled ? "true" : "false"}`);
    // Reasoning effort: Codex takes it as launch config (`model_reasoning_effort`),
    // not as a runtime call — same shape as Claude's `--effort` flag, so a change
    // means relaunch with thread/resume. Levels are per-model, hence the check.
    if (options.effort && isValidCodexEffort(options.model, options.effort)) {
      args.push("-c", `model_reasoning_effort=${options.effort}`);
    }
    const codexHome = resolveCompanionCodexSessionHome(
      sessionId,
      options.codexHome,
    );
    this.prepareCodexHome(codexHome);

    const { spawnCmd, spawnEnv } = buildCodexSpawn(binary, args, options.env, codexHome);

    console.log(
      `[cli-launcher] Spawning Codex session ${sessionId}: ` +
      sanitizeSpawnArgsForLog(spawnCmd),
    );

    const proc = Bun.spawn(spawnCmd, {
      cwd: info.cwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    // Pipe stderr for debugging (stdout is used for JSON-RPC)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Create the CodexAdapter which handles JSON-RPC and message translation
    // Pass the raw permission mode — the adapter maps it to Codex's approval policy
    const adapter = new CodexAdapter(proc, sessionId, {
      model: options.model,
      cwd: info.cwd,
      approvalMode: options.permissionMode,
      threadId: info.cliSessionId,
      forkFromThreadId: this.prepareCodexFork(codexHome, info),
      sandbox: options.codexSandbox,
      recorder: this.recorder ?? undefined,
      systemPrompt: options.systemPrompt,
    });

    // Handle init errors — mark session as exited so UI shows failure.
    // Also clear cliSessionId so the next relaunch starts a fresh thread
    // instead of trying to resume one whose rollout may be missing.
    adapter.onInitError((error) => {
      console.error(`[cli-launcher] Codex session ${sessionId} init failed: ${error}`);
      companionBus.emit("session:init-failed", { sessionId, error });
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = 1;
        session.cliSessionId = undefined;
      }
      this.persistState();
    });

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:codex-adapter-created", { sessionId, adapter });

    // Mark as connected immediately (no WS handshake needed for stdio)
    info.state = "connected";

    // Monitor process exit
    proc.exited.then((exitCode) => {
      console.log(`[cli-launcher] Codex session ${sessionId} exited (code=${exitCode})`);
      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;
      }
      this.processes.delete(sessionId);
      this.persistState();
      companionBus.emit("session:exited", { sessionId, exitCode });
    });

    this.persistState();
  }

  /**
   * Mark a session as connected (called when CLI establishes WS connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      console.log(`[cli-launcher] Session ${sessionId} connected via WebSocket`);
      this.persistState();
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  /**
   * Kill a session's CLI process.
   */
  async kill(sessionId: string): Promise<boolean> {
    // Attribution: SIGTERMs used to be unlogged, making mid-turn kills
    // untraceable (see the 2026-09-02 lost-answer forensics).
    console.log(`[cli-launcher] kill() requested for ${sessionId} — by: ${callerOf()}`);
    const proxy = this.codexWsProxies.get(sessionId);
    if (proxy) {
      try { proxy.kill("SIGTERM"); } catch {}
      this.codexWsProxies.delete(sessionId);
    }

    const proc = this.processes.get(sessionId);
    if (!proc) return !!proxy;

    proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit, then force kill
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);

    if (!exited) {
      console.log(`[cli-launcher] Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
      this.releaseCodexWsPort(session);
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /**
   * List all sessions (active + recently exited).
   */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a session exists and is alive (not exited).
   */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /**
   * Set the archived flag on a session.
   */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      this.persistState();
    }
  }

  /**
   * Update the model on a session's stored info so the next spawn/relaunch
   * uses the new value. Used when the user switches models mid-session —
   * the Claude CLI's `set_model` control_request silently no-ops, so the
   * caller pairs this with `relaunch()` to actually swap the running CLI.
   */
  setModel(sessionId: string, model: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    info.model = model;
    this.persistState();
    return true;
  }

  /**
   * Update the reasoning-effort level on a session's stored info so the next
   * relaunch uses it. Like `setModel`, effort can only be applied at launch
   * (`--effort`), so the caller pairs this with `relaunch()`.
   */
  setUltracode(sessionId: string, enabled: boolean): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    info.ultracode = enabled;
    this.persistState();
    return true;
  }

  setEffort(sessionId: string, effort: string): boolean {
    const info = this.sessions.get(sessionId);
    if (!info) return false;
    info.effort = effort;
    this.persistState();
    return true;
  }

  /**
   * Remove a session from the internal map (after kill or cleanup).
   */
  removeSession(sessionId: string) {
    this.releaseCodexWsPort(this.sessions.get(sessionId));
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.codexWsProxies.delete(sessionId);
    this.forgetRequestEnv(sessionId);
    this.persistState();
  }

  /**
   * Remove exited sessions from the list.
   */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.releaseCodexWsPort(session);
        this.sessions.delete(id);
        this.forgetRequestEnv(id);
        this.codexWsProxies.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Kill all sessions.
   */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array> | null,
    label: "stdout" | "stderr",
    onText?: (text: string) => void,
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const log = label === "stdout" ? console.log : console.error;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          log(`[session:${sessionId}:${label}] ${text.trimEnd()}`);
        }
        onText?.(text);
      }
    } catch {
      // stream closed
    }
  }

  private pipeOutput(sessionId: string, proc: Subprocess, opts?: { skipStdout?: boolean }): void {
    const stdout = proc.stdout;
    const stderr = proc.stderr;
    // In stdio bridge mode the adapter owns stdout (the NDJSON protocol stream),
    // so a second reader here would steal bytes from it.
    if (!opts?.skipStdout && stdout && typeof stdout !== "number") {
      this.pipeStream(sessionId, stdout, "stdout");
    }
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }
  }
}
