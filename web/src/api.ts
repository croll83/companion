import type { SdkSessionInfo } from "./types.js";
import type { ContentBlock } from "./types.js";
import type { CliBridgeMode } from "../server/cli-bridge-mode.js";
import { captureEvent, captureException } from "./analytics.js";

const BASE = "/api";
const AUTH_STORAGE_KEY = "companion_auth_token";

function getAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function handle401(status: number): void {
  if (status === 401 && typeof window !== "undefined") {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    // Dynamic import to avoid circular dependency
    import("./store.js").then(({ useStore }) => {
      useStore.getState().logout();
    }).catch(() => {});
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function trackApiSuccess(method: string, path: string, durationMs: number, status: number): void {
  captureEvent("api_request_succeeded", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
  });
}

function trackApiFailure(
  method: string,
  path: string,
  durationMs: number,
  error: unknown,
  status?: number,
): void {
  captureEvent("api_request_failed", {
    method,
    path,
    status,
    duration_ms: Math.round(durationMs),
    error: error instanceof Error ? error.message : String(error),
  });
  captureException(error, { method, path, status });
}

/** `&projectId=…` (wins) or `&teamId=…`, or "" without a scope. */
function scopeQuery(scope?: { teamId?: string; projectId?: string }): string {
  if (scope?.projectId) return `&projectId=${encodeURIComponent(scope.projectId)}`;
  if (scope?.teamId) return `&teamId=${encodeURIComponent(scope.teamId)}`;
  return "";
}

async function post<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("POST", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("POST", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("POST", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function get<T = unknown>(path: string): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { ...getAuthHeaders() },
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("GET", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("GET", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("GET", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function put<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PUT", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PUT", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PUT", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function patch<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("PATCH", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("PATCH", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("PATCH", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

async function del<T = unknown>(path: string, body?: object): Promise<T> {
  const startedAt = nowMs();
  let failureTracked = false;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...getAuthHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const apiError = new Error(err.error || res.statusText);
      trackApiFailure("DELETE", path, nowMs() - startedAt, apiError, res.status);
      failureTracked = true;
      throw apiError;
    }
    trackApiSuccess("DELETE", path, nowMs() - startedAt, res.status);
    return res.json();
  } catch (error) {
    if (!failureTracked) {
      trackApiFailure("DELETE", path, nowMs() - startedAt, error);
    }
    throw error;
  }
}

export interface CreateSessionOpts {
  model?: string;
  /** Reasoning-effort level for effort-capable Claude models. */
  effort?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  codexBinary?: string;
  codexInternetAccess?: boolean;
  allowedTools?: string[];
  envSlug?: string;
  branch?: string;
  createBranch?: boolean;
  useWorktree?: boolean;
  backend?: "claude" | "codex";
  resumeSessionAt?: string;
  forkSession?: boolean;
  /** Domain slug (default GLOBAL). */
  domain?: string;
  /** "new": create `folderName` inside the domain folder; "existing": attach `cwd` as is. */
  folderMode?: "new" | "existing";
  folderName?: string;
  linearConnectionId?: string;
  linearIssue?: {
    identifier: string;
    title: string;
    stateName: string;
    teamName: string;
    url: string;
  };
}

export interface BackendInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface BackendModelInfo {
  value: string;
  label: string;
  description: string;
  /** Codex: the model's reasoning-effort levels, from its catalogue (absent = none listed). */
  efforts?: string[];
  /** Codex: the level the model runs at when none is chosen. */
  defaultEffort?: string;
}

export interface ClaudeDiscoveredSession {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  lastActivityAt: number;
  sourceFile: string;
}

export interface ClaudeSessionHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
  /** The transcript line had no usable time: `timestamp` is only a sort key. */
  timestampUnknown?: boolean;
  model?: string;
  stopReason?: string | null;
}

export interface ClaudeSessionHistoryPage {
  sourceFile: string;
  messages: ClaudeSessionHistoryMessage[];
  nextCursor: number;
  hasMore: boolean;
  totalMessages: number;
}

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branch: string;
  isNew: boolean;
}

/** Where an env profile applies automatically. Absent = unassigned (explicit pick only). */
export type EnvScope = "global" | "project";

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  scope?: EnvScope;
  /** Project folders, when scope === "project". */
  folders?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListResult {
  path: string;
  dirs: DirEntry[];
  home: string;
  error?: string;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  isServiceMode: boolean;
  updateInProgress: boolean;
  lastChecked: number;
  channel: "stable" | "prerelease";
}

export interface UsageLimits {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  } | null;
}

export interface EditorStartResult {
  available: boolean;
  installed: boolean;
  mode: "host";
  url?: string;
  message?: string;
}

export interface AppSettings {
  anthropicApiKeyConfigured: boolean;
  anthropicModel: string;
  claudeCodeOAuthTokenConfigured: boolean;
  openaiApiKeyConfigured: boolean;
  codexDeviceAuthConfigured: boolean;
  onboardingCompleted: boolean;
  linearApiKeyConfigured: boolean;
  linearConnectionCount: number;
  linearAutoTransition: boolean;
  linearAutoTransitionStateName: string;
  linearArchiveTransition: boolean;
  linearArchiveTransitionStateName: string;
  linearOAuthConfigured: boolean;
  linearOAuthCredentialsSaved: boolean;
  aiValidationEnabled: boolean;
  aiValidationAutoApprove: boolean;
  aiValidationAutoDeny: boolean;
  publicUrl: string;
  updateChannel: "stable" | "prerelease";
  cliBridgeMode: CliBridgeMode;
  telegramBotTokenConfigured: boolean;
  /** IANA zone for chat times; "" = Automatic (the viewing device's zone). */
  timeZone: string;
  /** Give sessions the built-in `companion` MCP tools (wake-ups, agents). */
  companionMcpEnabled?: boolean;
}

export interface HostsCheckResult {
  ok: boolean;
  hostsPath: string;
  suggestedCommand: string;
  hostname: string;
}

export interface ClaudeCliCheckResult {
  ok: boolean;
  found: boolean;
  version: string | null;
  missingFlags: string[];
  reason: string | null;
  suggestedCommand: string;
}

/**
 * Result of GET /api/system/bun-runtime-check. Bun < `minimum` has a
 * subprocess-stream bug (oven-sh/bun#32743) that can drop live sessions.
 * `reason: "unknown"` means the version couldn't be parsed (reported ok=true).
 */
export interface BunRuntimeCheckResult {
  version: string | null;
  minimum: string;
  ok: boolean;
  reason: "ok" | "outdated" | "unknown";
  isServiceMode: boolean;
}

export interface LinearOAuthConnectionSummary {
  id: string;
  name: string;
  oauthClientId: string;
  status: "connected" | "disconnected";
  hasAccessToken: boolean;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LinearConnectionSummary {
  id: string;
  name: string;
  apiKeyLast4: string;
  workspaceName: string;
  workspaceId: string;
  viewerName: string;
  viewerEmail: string;
  connected: boolean;
  autoTransition: boolean;
  autoTransitionStateId: string;
  autoTransitionStateName: string;
  archiveTransition: boolean;
  archiveTransitionStateId: string;
  archiveTransitionStateName: string;
}

/** Telegram bridge binding for a session (mirrors server TelegramBinding). */
export interface TelegramBinding {
  groupId: number;
  topicId: number | null;
  allowlist: number[];
  requireMention: boolean;
  enabled: boolean;
}

export interface SessionFolderPreview {
  ok: true;
  from: string;
  to: string;
  backend: string;
  /** A turn or background job is running and the restart would interrupt it. */
  interruptsWork: boolean;
  /** The memory the session keeps using after the move (none for legacy Codex sessions). */
  memory?: { dir: string; notes: number };
}

/** A note of a legacy Claude session's folder memory (server/legacy-memory.ts). */
export interface LegacyMemoryNote {
  file: string;
  name: string;
  description: string;
  type: string;
  preview: string;
  /** Present when a target domain was given: a file with this name is already in its memory. */
  existsInDomain?: boolean;
}

export type LegacyMemory =
  | { backend: "claude"; dir: string; notes: LegacyMemoryNote[] }
  | { backend: "codex"; notes: []; info: string };

export interface LegacyMemoryCopyResult {
  copied: string[];
  skipped: { file: string; reason: string }[];
}

export interface DomainMcpServerView {
  name: string;
  /** "account": the user's own Claude config or a claude.ai connector (Claude-only). */
  source: "global" | "domain" | "account";
  enabled: boolean;
  /** The domain chose this state itself (else it follows GLOBAL; for GLOBAL, the default "on"). */
  own: boolean;
  /** Off only because GLOBAL turns it off (the domain has no choice of its own). */
  disabledGlobally?: boolean;
  type: string;
  /** URL, or command and args (env and headers are never sent). */
  target: string;
  /** Account servers: health from the last `claude mcp list`. */
  health?: string;
}

/** A Claude Code marketplace plugin installed for the user, turned on/off per domain. */
export interface PluginInfo {
  /** `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  description?: string;
  skills: string[];
  mcpServers: { name: string; type: string; target: string }[];
  /** On in the user's own settings.json: the state when no domain decides. */
  enabledByUser: boolean;
}

export interface SkillGroupInfo {
  id: "user" | "claude-ai" | "design";
  label: string;
  description: string;
  skills: string[];
  /** One-line description per skill (from SKILL.md), when known. */
  descriptions: Record<string, string>;
  /** How Codex sessions get the group: linked, turned off in config.toml, or Claude-only. */
  codex: "linked" | "toggled" | "unsupported";
}

export interface DomainSummary {
  slug: string;
  name: string;
  createdAt: number;
  description?: string;
  /** MCP servers turned on/off by the domain itself (name → on). */
  mcp: Record<string, boolean>;
  chrome: boolean;
  /** Claude only, used when chrome is on: "local" (default) or a browser deviceId. */
  chromeBrowser: string;
  plugins?: Record<string, boolean>;
  skillGroups?: Record<string, boolean>;
  /** Single skills turned on/off by the domain itself, keyed "<group>:<name>". */
  skillChoices?: Record<string, boolean>;
  path: string;
  sessionCount: number;
  totalSessions: number;
  memoryNotes: number;
  skills: string[];
  /** The domain's own skills with their descriptions. */
  ownSkills: { name: string; description: string }[];
  mcpServers: DomainMcpServerView[];
  mcpError?: string;
  skillGroupStates: Record<string, { on: boolean; own: boolean; onCount: number }>;
  /** Each single skill ("<group>:<name>"): on, and whether the domain chose it itself. */
  skillStates: Record<string, { on: boolean; own: boolean }>;
  /** Effective state of each installed plugin, and whether it is this domain's own choice. */
  pluginStates: Record<string, { on: boolean; own: boolean }>;
  /** The domain's brain choice: a slug, null (none), absent (GLOBAL's default). */
  brain?: string | null;
  /** The brain its sessions use (own choice, else GLOBAL's); null when none. */
  effectiveBrain?: { slug: string; name: string; own: boolean } | null;
  /** The Linear team/project the domain is linked to (ids and names only, never a key). */
  linear?: DomainLinearLink;
}

/** A per-domain transition rule; absent on the link = the connection's setting applies. */
export interface DomainLinearRule {
  enabled: boolean;
  stateId: string;
  stateName: string;
}

export interface DomainLinearLink {
  connectionId: string;
  teamId: string;
  teamKey?: string;
  teamName?: string;
  /** Absent = the whole team. */
  projectId?: string;
  projectName?: string;
  autoTransition?: DomainLinearRule;
  archiveTransition?: DomainLinearRule;
}

export interface DomainLinearView extends DomainLinearLink {
  connectionName: string;
  workspaceName: string;
  /** The connection the link points at was removed. */
  broken?: "connection_missing";
}

/** The rule that actually applies, and where it comes from. */
export interface EffectiveLinearRule extends DomainLinearRule {
  source: "domain" | "connection" | "settings";
}

export interface DomainLinearInfo {
  link: DomainLinearView | null;
  rules?: { start: EffectiveLinearRule; archive: EffectiveLinearRule };
}

/** Body of PUT /domains/:slug/linear. A rule: null = connection's setting, {enabled:false} = off. */
export interface DomainLinearInput {
  connectionId: string;
  teamId: string;
  projectId?: string;
  autoTransition?: { enabled: boolean; stateId?: string } | null;
  archiveTransition?: { enabled: boolean; stateId?: string } | null;
}

export interface BoardLabel {
  id: string;
  name: string;
  color: string;
  /** The label group ("Soak" for "soak 24h"). */
  group?: string;
}

export interface BoardIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  /** 0 = none, 1 = urgent … 4 = low. */
  priority: number;
  priorityLabel: string;
  stateId: string;
  stateName: string;
  stateType: string;
  updatedAt: string;
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  labels: BoardLabel[];
  teamId: string;
  teamKey: string;
  teamName: string;
  projectId?: string;
  projectName?: string;
}

export interface BoardState extends LinearWorkflowState {
  position?: number;
  /** Canceled / duplicate: behind the "Show canceled" toggle. */
  hidden: boolean;
}

export interface BoardSession {
  sessionId: string;
  name: string;
  archived: boolean;
  backendType: string;
  domain: string;
}

export interface DomainBoard {
  link: DomainLinearView;
  team: { id: string; key: string; name: string };
  states: BoardState[];
  viewer: { id: string; name: string; avatarUrl: string | null };
  issues: BoardIssue[];
  truncated: boolean;
  /** issueId → Companion sessions linked to it. */
  sessions: Record<string, BoardSession[]>;
  fetchedAt: number;
}

export interface TakenIssue extends BoardIssue {
  description: string;
}

type Choices = Record<string, boolean | null>;

/** A change to a domain: text fields, and partial on/off maps (null = back to the inherited state). */
export interface DomainPatch {
  name?: string;
  description?: string;
  chrome?: boolean;
  chromeBrowser?: string;
  mcp?: Choices;
  plugins?: Choices;
  skillGroups?: Choices;
  skillChoices?: Choices;
  /** One brain per domain: a slug replaces the current one, null = none, "inherit" = GLOBAL's (not for GLOBAL). */
  brain?: string | null;
}

export interface DomainsResponse {
  root: string;
  skillGroups: SkillGroupInfo[];
  plugins: PluginInfo[];
  /** The cached list of account MCP servers: when it was read, and whether it is being refreshed. */
  accountMcp?: { at: number; stale: boolean; error?: string };
  domains: DomainSummary[];
  /** Every brain, for the Brain select of a domain. */
  brains?: { slug: string; name: string }[];
}

export type BrainAuthMode = "none" | "bearer" | "oauth";

/** How sessions authenticate to a remote brain. OAuth: a pre-registered client; each CLI signs in from a session. */
export type BrainAuth = { mode: "none" } | { mode: "bearer" } | { mode: "oauth"; clientId: string; callbackPort?: number };

/** Where a brain's skill comes from; "server" = fetched from `<base>/skill`. */
export interface BrainSkillInfo {
  source: "generated" | "custom" | "server";
  custom?: string;
  /** The last good fetch of the server's skill. */
  server?: { fetchedAt: number; etag?: string; contentHash: string | null; serverVersion?: string; name?: string };
  /** Why the server's skill is not (or not freshly) in use. */
  note?: string;
}

export type BrainLanguage = "auto" | "it" | "en" | "none";

/** What Companion's supervisor knows of an embedded brain's process. */
export interface BrainRuntimeInfo {
  state: "stopped" | "starting" | "running" | "unhealthy" | "backoff" | "failed";
  pid?: number;
  /** The child's ephemeral port (troubleshooting only: sessions use Companion's port). */
  port?: number;
  startedAt?: number;
  crashes: number;
  cause?: string;
  action?: string;
  lastExitCode?: number | null;
}

/** A brain (remote, or embedded: run by Companion on a wiki folder), as GET /brains returns it. Never carries a token or key. */
export interface BrainInfo {
  slug: string;
  name: string;
  kind: "embedded" | "remote";
  createdAt: number;
  about: string;
  remote?: { baseUrl: string; mcpUrl?: string; healthUrl?: string; auth: BrainAuth };
  embedded?: { wikiDir: string; autostart: boolean; redactSecrets: boolean; language: BrainLanguage };
  /** Embedded brains: the child process. */
  runtime?: BrainRuntimeInfo;
  skill: BrainSkillInfo;
  urls: { mcpUrl: string; healthUrl: string; apiUrl: string; skillUrl: string };
  hasToken: boolean;
  /** MCP server and skill name (`<slug>-brain`). */
  serverName: string;
  tokenEnvVar: string;
  /** The SKILL.md sessions get. Plain text from a server: never render it as HTML. */
  skillText: string;
  /** Domains whose sessions use it; own = chosen by the domain (else GLOBAL's default). */
  domains: { slug: string; name: string; own: boolean }[];
  /** Installed plugins serving the same MCP URL, and where each is on. */
  collisions: { pluginId: string; pluginName: string; servers: string[]; domains: string[] }[];
  consolidation?: BrainConsolidationConfig;
  /** For the list: whether it consolidates, and when it last did. */
  consolidationSummary?: { enabled: boolean; lastSuccessAt?: number; lastStatus?: BrainConsolidationRunStatus };
}

/** A brain's consolidation settings (server/brain/brain-store.ts ConsolidationConfig). */
export interface BrainConsolidationConfig {
  enabled: boolean;
  /** 5-field cron, in Companion's time zone. */
  schedule: string;
  mode: "local" | "master" | "pr";
  backend: "claude" | "codex";
  /** Absent: the latest Sonnet (Claude) or Codex's first model, resolved at every run. */
  model?: string;
  /** Reasoning effort of the runs (default "high"), settled against the resolved model. */
  effort: string;
  threshold: number;
  agentId?: string;
}

export type BrainConsolidationRunStatus = "running" | "success" | "skipped" | "not_synced" | "no_commit" | "error";

/** One consolidation run (embedded brains), or one run of the linked agent (remote brains). */
export interface BrainConsolidationRun {
  id: string;
  trigger: "schedule" | "manual" | "threshold" | "catch-up" | "webhook" | "linear";
  status: BrainConsolidationRunStatus;
  startedAt: number;
  finishedAt?: number;
  pending?: number;
  sessionId?: string;
  backend?: "claude" | "codex";
  model?: string;
  /** The reasoning effort the run was launched with. */
  effort?: string;
  decided?: Record<string, number>;
  commit?: string;
  costUsd?: number;
  tokens?: { input: number; output: number };
  error?: string;
  /** The wiki's lint right after the sync. */
  lint?: { errors: number; warnings: number };
}

/** GET /brains/:slug/consolidation. */
export interface BrainConsolidationView {
  config: BrainConsolidationConfig;
  agent: { id: string; name: string; backendType: "claude" | "codex"; model: string; enabled: boolean } | null;
  resolvedModel: string | null;
  /** The effort the next run would use (null: the model has no effort control). */
  resolvedEffort: string | null;
  /** The configured effort is not one resolvedModel takes: runs use resolvedEffort, its default. */
  effortFallback: boolean;
  running: boolean;
  runningSessionId?: string;
  nextRunAt: number | null;
  lastSuccessAt?: number;
  runs: BrainConsolidationRun[];
  domain: string;
}

export type BrainConsolidationPatch = Partial<Pick<BrainConsolidationConfig, "enabled" | "schedule" | "backend" | "effort" | "threshold">> & {
  /** null or "": the default model. */
  model?: string | null;
  /** Remote brains: the agent to link (null unlinks). */
  agentId?: string | null;
};

export interface BrainHealth {
  reachable: boolean;
  status?: number;
  healthStatus?: string;
  version?: string;
  pages?: number;
  content_hash?: string;
  error?: string;
  checkedAt: number;
  /** Notes in the brain's inbox by status (embedded brains report them). */
  inbox?: Record<string, number>;
  /** The server reported another wiki version, so its skill was fetched again. */
  skillRefresh?: "updated" | "unchanged" | "failed";
  /** Embedded brains: the child process. */
  runtime?: BrainRuntimeInfo;
}

export interface BrainTestResult {
  health: BrainHealth;
  mcp: {
    ok: boolean;
    status?: number;
    serverName?: string;
    serverVersion?: string;
    protocolVersion?: string;
    hasInstructions?: boolean;
    transport?: "json" | "sse";
    sessionClosed?: boolean;
    /** OAuth brain answering 401 with a challenge: up, waiting for a sign-in. */
    signInRequired?: boolean;
    error?: string;
  };
}

/** Fields of the connect / edit form. `token`: a string sets it, null removes it, absent keeps it. */
export interface BrainInput {
  name?: string;
  about?: string;
  baseUrl?: string;
  mcpUrl?: string | null;
  healthUrl?: string | null;
  auth?: BrainAuth;
  token?: string | null;
  /** "server": fetch `<base>/skill` (a failure keeps the current skill, with a note). Absent on create: try the server first. */
  skill?: { source: "generated" } | { source: "server" } | { source: "custom"; custom: string };
  /** Embedded brains (changing one of these restarts the brain). */
  language?: BrainLanguage;
  redactSecrets?: boolean;
  autostart?: boolean;
}

/** "Embedded brain (existing wiki folder)": Companion runs the brain server on this folder. */
export interface EmbeddedBrainInput {
  kind: "embedded";
  name: string;
  about?: string;
  /** Absolute path (or ~/...) of a folder with SCHEMA.md and index.md. */
  wikiDir: string;
  language?: BrainLanguage;
  redactSecrets?: boolean;
}

/** "New brain": a wiki from Companion's template and its embedded brain. */
export interface NewBrainInput {
  name: string;
  about?: string;
  tags?: string[];
  /** Absolute or ~/ path; default ~/companion_brain_<slug>. */
  wikiDir?: string;
}

export interface NewBrainResult {
  brain: BrainInfo;
  wiki: { dir: string; language: BrainLanguage; tags: string[]; commit: string };
}

/** A fix of the guided lint (only adds to the wiki). */
export type BrainLintFixId = "create-schema" | "create-index" | "create-log" | "add-taxonomy" | "add-tags" | "index-pages";

/** One problem of a wiki, in a sentence, with a one-click fix when there is one. */
export interface BrainLintAdvice {
  id: string;
  level: "error" | "warn";
  sentence: string;
  paths: string[];
  count: number;
  fix?: { id: BrainLintFixId; label: string };
}

export interface BrainLintView {
  ok: boolean;
  errors: number;
  warnings: number;
  pages: number;
  advice: BrainLintAdvice[];
}

/** "Adopt existing folder": what the folder lacks before a brain can run on it. */
export interface BrainAdoptCheck {
  ok: true;
  path: string;
  ready: boolean;
  advice: BrainLintAdvice[];
  done?: string;
}

/** A page in the Pages tab list (with a snippet when it comes from a search). */
export interface BrainPageSummary {
  slug: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  updated: string | null;
  snippet?: string;
}

/** One page (or a navigation file) of an embedded brain. Data, never HTML. */
export interface BrainPageDoc extends BrainPageSummary {
  sources: string[];
  markdown: string;
}

export type BrainNoteStatus = "pending" | "needs_human" | "deferred" | "accepted" | "rejected" | "discarded" | "withdrawn";

/** A note of a brain's inbox, as the Inbox tab shows it. */
export interface BrainNote {
  note_id: string;
  kind: string;
  statement: string;
  pages?: string[];
  new_page_hint?: string;
  sources?: string[];
  evidence?: string;
  author: string;
  received_at: string;
  status: BrainNoteStatus;
  status_reason?: string | null;
  status_changed_at?: string | null;
  status_by?: string | null;
  client_name?: string;
  /** Consolidation runs that left the note undecided (after a few it waits for a person). */
  deferrals?: number;
  /** A person included it: the next run must accept or reject it, following the comment. */
  release?: { by: string; at: string; comment: string | null } | null;
}

/** "Add source": a text (pasted or from a file) or an URL (recorded as a note only). */
export type BrainSourceInput = { name: string; text: string; note?: string } | { url: string; title?: string; note?: string };

/** A browser connected to Claude in Chrome (from `list_connected_browsers`). */
export interface ConnectedBrowser {
  deviceId: string;
  name: string;
  osPlatform?: string;
  /** True when the browser runs on Companion's own machine. */
  isLocal: boolean;
  /** The browser Chrome actions use right now. */
  inUse: boolean;
}

export interface ArchiveInfo {
  hasLinkedIssue: boolean;
  issueNotDone: boolean;
  issue?: {
    id: string;
    identifier: string;
    stateName: string;
    stateType: string;
    teamId: string;
  };
  hasBacklogState?: boolean;
  archiveTransitionConfigured?: boolean;
  archiveTransitionStateName?: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearTeamStates {
  id: string;
  key: string;
  name: string;
  states: LinearWorkflowState[];
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  priorityLabel: string;
  stateName: string;
  stateType: string;
  teamName: string;
  teamKey: string;
  teamId: string;
  assigneeName?: string;
  updatedAt?: string;
  connectionId?: string;
}

export interface LinearConnectionInfo {
  connected: boolean;
  viewerId: string;
  viewerName: string;
  viewerEmail: string;
  teamName: string;
  teamKey: string;
}

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  userName: string;
  userAvatarUrl?: string | null;
}

export interface LinearIssueDetail {
  issue: LinearIssue | null;
  comments?: LinearComment[];
  assignee?: { name: string; avatarUrl?: string | null } | null;
  labels?: { id: string; name: string; color: string }[];
}

export interface LinearProject {
  id: string;
  name: string;
  state: string;
}

export interface LinearProjectMapping {
  repoRoot: string;
  projectId: string;
  projectName: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateLinearIssueInput {
  title: string;
  description?: string;
  teamId: string;
  priority?: number;
  projectId?: string;
  assigneeId?: string;
  stateId?: string;
  connectionId?: string;
}

export interface GitHubPRInfo {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: { name: string; status: string; conclusion: string | null }[];
  checksSummary: { total: number; success: number; failure: number; pending: number };
  reviewThreads: { total: number; resolved: number; unresolved: number };
}

export interface PRStatusResponse {
  available: boolean;
  pr: GitHubPRInfo | null;
}

export interface McpServerConfigAgent {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentInfo {
  id: string;
  version: 1;
  name: string;
  description: string;
  icon?: string;
  backendType: "claude" | "codex";
  model: string;
  /** Reasoning effort of the runs; absent = the model's default. Null in an update clears it. */
  effort?: string | null;
  permissionMode: string;
  cwd: string;
  envSlug?: string;
  /** Domain the runs work in (absent = GLOBAL). */
  domain?: string;
  env?: Record<string, string>;
  /** Claude only: built-in tools the agent is limited to (empty = all). */
  allowedTools?: string[];
  codexInternetAccess?: boolean;
  prompt: string;
  /** "brief" (default): fresh session. "fork": each run copies sourceSessionId's conversation. */
  contextMode?: "brief" | "fork";
  sourceSessionId?: string;
  /** Keep each run's session visible (default: archived ~15 min after a successful run). */
  keepRunSessions?: boolean;
  mcpServers?: Record<string, McpServerConfigAgent>;
  triggers?: {
    webhook?: {
      enabled: boolean;
      secret: string;
    };
    schedule?: {
      enabled: boolean;
      expression: string;
      recurring: boolean;
    };
    /** Linear Agent Interaction SDK trigger (per-agent OAuth app) */
    linear?: {
      enabled: boolean;
      /** Reference to a LinearOAuthConnection by ID (new model) */
      oauthConnectionId?: string;
      /** Resolved name of the referenced OAuth connection */
      oauthConnectionName?: string;
      /** Resolved status of the referenced OAuth connection */
      oauthConnectionStatus?: string;
      /** @deprecated OAuth app client ID (legacy inline model) */
      oauthClientId?: string;
      /** Whether the agent has an access token (OAuth connected) */
      hasAccessToken?: boolean;
      /** Whether the agent has a client secret configured */
      hasClientSecret?: boolean;
      /** Whether the agent has a webhook secret configured */
      hasWebhookSecret?: boolean;
    };
  };
  /** Absent/"user", or "session:<id>" when a session created it via the companion MCP tools. */
  createdBy?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  totalRuns: number;
  consecutiveFailures: number;
  nextRunAt?: number | null;
  /** A run of this agent is launching or waiting for its result. */
  running?: boolean;
  /** Why the schedule is not running as configured (past date, invalid, skipped run). */
  scheduleError?: string | null;
}

/** A message scheduled into a session (server/wakeup-store.ts). */
export interface SessionWakeup {
  id: string;
  sessionId: string;
  message: string;
  schedule: { at: string } | { cron: string };
  createdAt: number;
  /** "user" or "session:<id>" */
  createdBy: string;
  lastFiredAt?: number;
  nextRunAt?: number;
  enabled: boolean;
  status: "pending" | "delivered" | "skipped" | "missed";
  lastResult?: string;
}

export interface AgentExecution {
  sessionId: string;
  agentId: string;
  triggerType: "manual" | "webhook" | "schedule" | "linear";
  startedAt: number;
  completedAt?: number;
  success?: boolean;
  error?: string;
  /** Result subtype reported by the CLI (e.g. "success", "error_max_turns"). */
  subtype?: string;
}

export interface ExecutionListResult {
  executions: AgentExecution[];
  total: number;
}

/** Portable export format (no internal tracking fields) */
export type AgentExport = Omit<
  AgentInfo,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId" | "enabled" | "nextRunAt" | "running" | "scheduleError"
>;

export interface SavedPrompt {
  id: string;
  name: string;
  content: string;
  scope: "global" | "project";
  projectPath?: string;
  projectPaths?: string[];
  createdAt: number;
  updatedAt: number;
}

// ─── Claude Config Browser ──────────────────────────────────────────────────

export interface ClaudeConfigFile {
  path: string;
  content: string;
}

export interface ClaudeConfigSkill {
  slug: string;
  name: string;
  description: string;
  path: string;
  /** "synced" = synced from claude.ai (read-only), "link" = symlinked skill dir */
  source?: "synced" | "link";
  /** Manual-only skill (`disable-model-invocation: true`): run with /name, never by the model. */
  manualOnly?: boolean;
}

/** Mirrors ClaudeConfigListing in server/claude-config.ts */
export interface ClaudeConfigResponse {
  project: {
    root: string;
    cwd: string;
    claudeMd: ClaudeConfigFile[];
    claudeLocalMd: ClaudeConfigFile[];
    settings: ClaudeConfigFile | null;
    settingsLocal: ClaudeConfigFile | null;
    mcpJson: ClaudeConfigFile | null;
    commands: { name: string; path: string }[];
    agents: { name: string; path: string }[];
    skills: ClaudeConfigSkill[];
    agentsMd: ClaudeConfigFile[];
  };
  user: {
    root: string;
    claudeMd: ClaudeConfigFile | null;
    skills: ClaudeConfigSkill[];
    agents: { name: string; path: string }[];
    settings: ClaudeConfigFile | null;
    settingsLocal: ClaudeConfigFile | null;
    commands: { name: string; path: string }[];
    codex: {
      root: string;
      agentsMd: ClaudeConfigFile | null;
      config: { path: string; editable: boolean } | null;
    };
  };
}

export type ConfigFileFormat = "markdown" | "json" | "toml";

export type NewConfigFileType =
  | "claude-md"
  | "claude-local-md"
  | "settings"
  | "settings-local"
  | "mcp-json"
  | "command"
  | "agent"
  | "skill"
  | "agents-md";

// ─── SSE Session Creation ────────────────────────────────────────────────────

export interface CreationProgressEvent {
  step: string;
  label: string;
  status: "in_progress" | "done" | "error";
}

export interface CreateSessionStreamResult {
  sessionId: string;
  state: string;
  cwd: string;
  backendType?: "claude" | "codex";
  resumeSessionAt?: string;
  forkSession?: boolean;
}

/**
 * Create a session with real-time progress streaming via SSE.
 * Uses fetch + ReadableStream (EventSource is GET-only, this is POST).
 */
export async function createSessionStream(
  opts: CreateSessionOpts | undefined,
  onProgress: (progress: CreationProgressEvent) => void,
): Promise<CreateSessionStreamResult> {
  const res = await fetch(`${BASE}/sessions/create-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(opts ?? {}),
  });

  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: CreateSessionStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events: split on double newlines
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      let eventType = "";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (!data) continue;

      const parsed = JSON.parse(data);
      if (eventType === "progress") {
        onProgress(parsed as CreationProgressEvent);
      } else if (eventType === "done") {
        result = parsed as CreateSessionStreamResult;
      } else if (eventType === "error") {
        throw new Error((parsed as { error: string }).error || "Session creation failed");
      }
    }
  }

  if (!result) {
    throw new Error("Stream ended without session creation result");
  }

  return result;
}

/**
 * Verify an auth token with the server.
 * This does NOT use the auth header helpers since it's called before auth is established.
 */
/**
 * Attempt auto-authentication for localhost users.
 * The server returns the token if the request comes from 127.0.0.1/::1.
 * No auth header needed — this is a pre-auth endpoint.
 */
export async function autoAuth(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/auth/auto`);
    if (res.ok) {
      const data = await res.json() as { ok: boolean; token?: string };
      if (data.ok && data.token) return data.token;
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyAuthToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      const data = await res.json();
      return !!(data as { ok?: boolean }).ok;
    }
    return false;
  } catch {
    return false;
  }
}

export const api = {
  // Auth
  getAuthQr: () =>
    get<{ qrCodes: { label: string; url: string; qrDataUrl: string }[] }>("/auth/qr"),
  getAuthToken: () =>
    get<{ token: string }>("/auth/token"),
  regenerateAuthToken: () =>
    post<{ token: string }>("/auth/regenerate"),

  createSession: (opts?: CreateSessionOpts) =>
    post<{ sessionId: string; state: string; cwd: string }>(
      "/sessions/create",
      opts,
    ),

  listSessions: () => get<SdkSessionInfo[]>("/sessions"),
  discoverClaudeSessions: (limit = 200) =>
    get<{ sessions: ClaudeDiscoveredSession[] }>(
      `/claude/sessions/discover?limit=${encodeURIComponent(String(limit))}`,
    ),
  getClaudeSessionHistory: (sessionId: string, opts?: { cursor?: number; limit?: number }) => {
    const cursor = Math.max(0, Math.floor(opts?.cursor ?? 0));
    const limit = Math.max(1, Math.floor(opts?.limit ?? 40));
    return get<ClaudeSessionHistoryPage>(
      `/claude/sessions/${encodeURIComponent(sessionId)}/history?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
    );
  },

  killSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/kill`),

  deleteSession: (sessionId: string) =>
    del(`/sessions/${encodeURIComponent(sessionId)}`),

  relaunchSession: (sessionId: string, opts?: { force?: boolean }) =>
    post<{ ok: boolean; alreadyRunning?: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/relaunch${opts?.force ? "?force=1" : ""}`,
    ),

  /** What moving a session to `cwd` would do (no change made). */
  previewSessionFolder: (sessionId: string, cwd: string) =>
    get<SessionFolderPreview>(`/sessions/${encodeURIComponent(sessionId)}/folder?cwd=${encodeURIComponent(cwd)}`),

  /** Move a session to `cwd` and restart its CLI there on the same conversation. */
  changeSessionFolder: (sessionId: string, cwd: string) =>
    post<SessionFolderPreview>(`/sessions/${encodeURIComponent(sessionId)}/folder`, { cwd }),

  /** Move a (non-legacy) session to another domain; its CLI restarts on the same conversation. */
  changeSessionDomain: (sessionId: string, domain: string) =>
    post<{ ok: true; from: string; to: string; interruptsWork: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/domain`, { domain }),

  /** Migrate a legacy session (from before domains) into a domain; its CLI restarts on the same conversation. */
  migrateSessionToDomain: (sessionId: string, domain: string) =>
    post<{ ok: true; from: string; to: string; interruptsWork: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/migrate-domain`, { domain }),

  /**
   * The folder memory a legacy session would stop reading once migrated
   * (Claude); Codex has nothing to copy. With `domain`, notes already in that
   * domain's memory are flagged `existsInDomain`.
   */
  getLegacyMemory: (sessionId: string, domain?: string) =>
    get<LegacyMemory>(`/sessions/${encodeURIComponent(sessionId)}/legacy-memory${domain ? `?domain=${encodeURIComponent(domain)}` : ""}`),

  /** Copy notes of a legacy session's folder memory into a domain's memory (never overwriting). */
  copyLegacyMemory: (sessionId: string, domain: string, files: string[]) =>
    post<LegacyMemoryCopyResult>(`/sessions/${encodeURIComponent(sessionId)}/legacy-memory/copy`, { domain, files }),

  // Domains
  listDomains: () => get<DomainsResponse>("/domains"),
  /** A domain's Linear link and the transition rules that apply (no key). */
  getDomainLinear: (slug: string) => get<DomainLinearInfo>(`/domains/${encodeURIComponent(slug)}/linear`),
  /** Link a domain to a team (and project), validated against Linear. */
  setDomainLinear: (slug: string, input: DomainLinearInput) =>
    put<{ link: DomainLinearView }>(`/domains/${encodeURIComponent(slug)}/linear`, input),
  clearDomainLinear: (slug: string) => del<{ ok: true }>(`/domains/${encodeURIComponent(slug)}/linear`),
  listLinearTeamProjects: (teamId: string, connectionId: string) =>
    get<{ projects: LinearProject[] }>(
      `/linear/teams/${encodeURIComponent(teamId)}/projects?connectionId=${encodeURIComponent(connectionId)}`,
    ),
  /** The domain's board; `refresh` skips the server cache (Refresh button). */
  getDomainBoard: (slug: string, refresh = false) =>
    get<DomainBoard>(`/domains/${encodeURIComponent(slug)}/linear/board${refresh ? "?refresh=1" : ""}`),
  moveDomainIssue: (slug: string, issueId: string, stateId: string) =>
    post<{ ok: true }>(`/domains/${encodeURIComponent(slug)}/linear/issues/${encodeURIComponent(issueId)}/state`, { stateId }),
  /** "Take it": assign to me and start it (never moved backwards). */
  takeDomainIssue: (slug: string, issueId: string) =>
    post<{ ok: true; issue: TakenIssue; moved: boolean; connectionId: string }>(
      `/domains/${encodeURIComponent(slug)}/linear/issues/${encodeURIComponent(issueId)}/take`,
    ),
  createDomain: (name: string, description?: string) => post<DomainSummary>("/domains", { name, description }),
  /**
   * Change a domain. The on/off maps are partial: true/false sets a choice,
   * null removes it (back to GLOBAL's), keys not sent are left alone.
   */
  updateDomain: (slug: string, changes: DomainPatch) => patch<DomainSummary>(`/domains/${encodeURIComponent(slug)}`, changes),
  /** Create a skill of the domain's own (<domain>/skills/<name>/SKILL.md). */
  createDomainSkill: (slug: string, name: string, description: string) =>
    post<DomainSummary>(`/domains/${encodeURIComponent(slug)}/skills`, { name, description }),
  /** Remove a skill of the domain's own (moved to .removed-skills, never deleted). */
  removeDomainSkill: (slug: string, name: string) =>
    del<DomainSummary>(`/domains/${encodeURIComponent(slug)}/skills/${encodeURIComponent(name)}`),
  deleteDomain: (slug: string) => del<{ ok: true; keptOnDisk: string }>(`/domains/${encodeURIComponent(slug)}`),
  readDomainFile: (slug: string, name: string) =>
    get<{ path: string; content: string; format: ConfigFileFormat; readOnly: boolean }>(
      `/domains/${encodeURIComponent(slug)}/file?name=${encodeURIComponent(name)}`,
    ),
  writeDomainFile: (slug: string, name: string, content: string) =>
    put<{ ok: boolean; path: string }>(`/domains/${encodeURIComponent(slug)}/file`, { name, content }),
  /** Add or replace one server in the domain's mcp.json: a URL (HTTP) or a command (stdio). */
  setDomainMcpServer: (slug: string, name: string, server: { url: string } | { command: string; args?: string[] }) =>
    put<DomainSummary>(`/domains/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(name)}`, server),
  /** Re-read the MCP servers of the user's Claude config and claude.ai account (`claude mcp list`, ~10 s). */
  refreshAccountMcp: () => post<{ at: number; servers: number; error?: string }>("/account-mcp-servers/refresh", {}),

  // Brains (remote and embedded). Assigned to domains with updateDomain(slug, { brain }).
  listBrains: () => get<{ brains: BrainInfo[] }>("/brains"),
  createBrain: (input: BrainInput | EmbeddedBrainInput) => post<BrainInfo>("/brains", input),
  /** Embedded brains: start, stop or restart the brain's process. */
  brainProcess: (slug: string, action: "start" | "stop" | "restart") =>
    post<{ runtime: BrainRuntimeInfo }>(`/brains/${encodeURIComponent(slug)}/${action}`, {}),
  /** Embedded brains: the last lines of the brain's log. */
  brainLogs: (slug: string, lines = 100) => get<{ lines: string[] }>(`/brains/${encodeURIComponent(slug)}/logs?lines=${lines}`),
  updateBrain: (slug: string, input: BrainInput) => patch<BrainInfo>(`/brains/${encodeURIComponent(slug)}`, input),
  deleteBrain: (slug: string) => del<{ ok: true; clearedFrom: string[] }>(`/brains/${encodeURIComponent(slug)}`),
  brainHealth: (slug: string) => get<BrainHealth>(`/brains/${encodeURIComponent(slug)}/health`),
  testBrain: (slug: string) => post<BrainTestResult>(`/brains/${encodeURIComponent(slug)}/test`, {}),
  /** Fetch the brain's skill from its server again. */
  refreshBrainSkill: (slug: string) =>
    post<{ outcome: "updated" | "unchanged" | "failed"; error?: string; brain: BrainInfo }>(`/brains/${encodeURIComponent(slug)}/skill/refresh`, {}),
  /** Whether git is installed (a new wiki is a git repository). */
  brainGit: () => get<{ available: boolean; version?: string }>("/brains/git"),
  /** A new wiki from the template, and its embedded brain (started, on no domain). */
  createNewBrain: (input: NewBrainInput) => post<NewBrainResult>("/brains/new", input),
  /** What a folder lacks before it can be adopted; `fix` applies one first. */
  checkAdoptFolder: (input: { wikiDir: string; fix?: BrainLintFixId; name?: string; about?: string }) =>
    post<BrainAdoptCheck>("/brains/adopt-check", input),
  brainLint: (slug: string) => get<BrainLintView>(`/brains/${encodeURIComponent(slug)}/lint`),
  fixBrainLint: (slug: string, fix: BrainLintFixId) =>
    post<{ done: string; lint: BrainLintView }>(`/brains/${encodeURIComponent(slug)}/lint/fix`, { fix }),
  brainPages: (slug: string, q = "") =>
    get<{ pages: BrainPageSummary[]; query?: string }>(`/brains/${encodeURIComponent(slug)}/pages${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`),
  brainPage: (slug: string, page: string) =>
    get<BrainPageDoc>(`/brains/${encodeURIComponent(slug)}/pages/${encodeURIComponent(page)}`),
  brainInbox: (slug: string, status: BrainNoteStatus = "pending") =>
    get<{ counts: Record<string, number>; notes: BrainNote[] }>(`/brains/${encodeURIComponent(slug)}/inbox?status=${status}`),
  dismissBrainNote: (slug: string, noteId: string, reason?: string) =>
    post<{ note_id: string; status: "discarded" }>(`/brains/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(noteId)}/dismiss`, reason ? { reason } : {}),
  includeBrainNote: (slug: string, noteId: string, comment?: string) =>
    post<{ ok: true; note_id: string; status: "pending" }>(`/brains/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(noteId)}/include`, comment ? { comment } : {}),
  addBrainSource: (slug: string, input: BrainSourceInput) =>
    post<{ path?: string; note_id: string; duplicate: boolean }>(`/brains/${encodeURIComponent(slug)}/sources`, input),
  brainConsolidation: (slug: string) => get<BrainConsolidationView>(`/brains/${encodeURIComponent(slug)}/consolidation`),
  /** Embedded: the settings (turning it on creates the agent). Remote: {agentId} links an agent. */
  updateBrainConsolidation: (slug: string, input: BrainConsolidationPatch) =>
    put<BrainConsolidationView>(`/brains/${encodeURIComponent(slug)}/consolidation`, input),
  /** "Consolidate now": skipped (and recorded) when no note waits. */
  runBrainConsolidation: (slug: string) =>
    post<{ started: boolean; run?: BrainConsolidationRun; consolidation: BrainConsolidationView }>(`/brains/${encodeURIComponent(slug)}/consolidation/run`, {}),
  /** Retry the sync of a not-synced run into the wiki folder. */
  syncBrainConsolidation: (slug: string) =>
    post<{ run: BrainConsolidationRun; consolidation: BrainConsolidationView }>(`/brains/${encodeURIComponent(slug)}/consolidation/sync`, {}),
  /** Where the plugin is on, the brain replaces it (plugin turned off there). */
  adoptPluginAsBrain: (slug: string, pluginId: string) =>
    post<{ adoptedIn: string[]; brain: BrainInfo }>(`/brains/${encodeURIComponent(slug)}/adopt-plugin`, { pluginId }),
  removeDomainMcpServer: (slug: string, name: string) =>
    del<DomainSummary>(`/domains/${encodeURIComponent(slug)}/mcp/${encodeURIComponent(name)}`),

  /** Browsers connected to Claude in Chrome, listed by a short isolated Claude query. `force` bypasses the brief cache. */
  listChromeBrowsers: (force?: boolean) =>
    get<{ browsers: ConnectedBrowser[]; error?: string }>(`/chrome-browsers${force ? "?force=1" : ""}`),

  archiveSession: (sessionId: string, opts?: { force?: boolean; linearTransition?: "none" | "backlog" | "configured" }) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/archive`, opts),

  getArchiveInfo: (sessionId: string) =>
    get<ArchiveInfo>(`/sessions/${encodeURIComponent(sessionId)}/archive-info`),

  unarchiveSession: (sessionId: string) =>
    post(`/sessions/${encodeURIComponent(sessionId)}/unarchive`),

  renameSession: (sessionId: string, name: string) =>
    patch<{ ok: boolean; name: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/name`,
      { name },
    ),

  // ─── Telegram bridge ───────────────────────────────────────────────────────
  getTelegramStatus: () =>
    get<{ tokenConfigured: boolean; running: boolean; boundSessionIds: string[] }>("/telegram/status"),

  getTelegramBinding: (sessionId: string) =>
    get<{ binding: TelegramBinding | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/telegram`,
    ),

  setTelegramBinding: (sessionId: string, binding: TelegramBinding) =>
    put<{ ok: boolean; binding: TelegramBinding }>(
      `/sessions/${encodeURIComponent(sessionId)}/telegram`,
      binding,
    ),

  deleteTelegramBinding: (sessionId: string) =>
    del<{ ok: boolean; removed: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/telegram`,
    ),

  resolveTelegramUsername: (username: string) =>
    post<{ id: number; username: string | null }>("/telegram/resolve-username", { username }),

  listDirs: (path?: string) =>
    get<DirListResult>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  getHome: () => get<{ home: string; cwd: string }>("/fs/home"),

  // Environments
  listEnvs: () => get<CompanionEnv[]>("/envs"),
  getEnv: (slug: string) =>
    get<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`),
  createEnv: (
    name: string,
    variables: Record<string, string>,
    placement?: { scope: EnvScope; folders?: string[] },
  ) => post<CompanionEnv>("/envs", { name, variables, ...placement }),
  updateEnv: (
    slug: string,
    data: {
      name?: string;
      variables?: Record<string, string>;
      scope?: EnvScope;
      folders?: string[];
    },
  ) => put<CompanionEnv>(`/envs/${encodeURIComponent(slug)}`, data),
  deleteEnv: (slug: string) => del(`/envs/${encodeURIComponent(slug)}`),

  // Settings
  getSettings: () => get<AppSettings>("/settings"),
  updateSettings: (data: {
    anthropicApiKey?: string;
    anthropicModel?: string;
    claudeCodeOAuthToken?: string;
    openaiApiKey?: string;
    onboardingCompleted?: boolean;
    linearApiKey?: string;
    linearAutoTransition?: boolean;
    linearAutoTransitionStateId?: string;
    linearAutoTransitionStateName?: string;
    linearArchiveTransition?: boolean;
    linearArchiveTransitionStateId?: string;
    linearArchiveTransitionStateName?: string;
    linearOAuthClientId?: string;
    linearOAuthClientSecret?: string;
    linearOAuthWebhookSecret?: string;
    publicUrl?: string;
    updateChannel?: "stable" | "prerelease";
    cliBridgeMode?: CliBridgeMode;
    telegramBotToken?: string;
    timeZone?: string;
    companionMcpEnabled?: boolean;
  }) => put<AppSettings>("/settings", data),
  verifyAnthropicKey: (apiKey: string) =>
    post<{ valid: boolean; error?: string }>("/settings/anthropic/verify", { apiKey }),

  // Hosts file diagnostic — used to render a banner when the embedded TLS
  // proxy's allowlisted hostname is not mapped to 127.0.0.1.
  getHostsCheck: () => get<HostsCheckResult>("/system/hosts-check"),

  getClaudeCliCheck: (force?: boolean) =>
    get<ClaudeCliCheckResult>(`/system/claude-cli-check${force ? "?force=1" : ""}`),

  // Bun runtime version check — drives the BunRuntimeAlert banner.
  getBunRuntimeCheck: () => get<BunRuntimeCheckResult>("/system/bun-runtime-check"),

  // Linear connections CRUD
  listLinearConnections: () =>
    get<{ connections: LinearConnectionSummary[] }>("/linear/connections"),
  createLinearConnection: (data: { name: string; apiKey: string }) =>
    post<{ connection: LinearConnectionSummary; verified: boolean; error?: string }>(
      "/linear/connections",
      data,
    ),
  updateLinearConnection: (id: string, data: Record<string, unknown>) =>
    put<{ connection: LinearConnectionSummary }>(`/linear/connections/${encodeURIComponent(id)}`, data),
  deleteLinearConnection: (id: string) =>
    del<{ ok: boolean }>(`/linear/connections/${encodeURIComponent(id)}`),
  verifyLinearConnection: (id: string) =>
    post<{ connection: LinearConnectionSummary; verified: boolean; error?: string }>(
      `/linear/connections/${encodeURIComponent(id)}/verify`,
      {},
    ),

  /** Search issues; `scope` limits it to a project or team (a linked domain's). */
  searchLinearIssues: (query: string, limit = 8, connectionId?: string, scope?: { teamId?: string; projectId?: string }) =>
    get<{ issues: LinearIssue[] }>(
      `/linear/issues?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}${scopeQuery(scope)}`,
    ),
  getLinearConnection: (connectionId?: string) =>
    get<LinearConnectionInfo>(`/linear/connection${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  getLinearStates: (connectionId?: string) =>
    get<{ teams: LinearTeamStates[] }>(`/linear/states${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  /**
   * Auto-transition on session start. With the session's domain (and the
   * issue's team) the domain's own rule applies, else the connection's.
   */
  transitionLinearIssue: (issueId: string, connectionId?: string, ctx?: { domain?: string; teamId?: string }) => {
    const q = new URLSearchParams();
    if (connectionId) q.set("connectionId", connectionId);
    if (ctx?.domain) q.set("domain", ctx.domain);
    if (ctx?.teamId) q.set("teamId", ctx.teamId);
    const qs = q.toString();
    return post<{ ok: boolean; skipped: boolean }>(
      `/linear/issues/${encodeURIComponent(issueId)}/transition${qs ? `?${qs}` : ""}`,
      {},
    );
  },
  listLinearProjects: (connectionId?: string) =>
    get<{ projects: LinearProject[] }>(`/linear/projects${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`),
  /** Recent open issues of a project, or of a whole team (projectId "" + teamId). */
  getLinearProjectIssues: (projectId: string, limit = 15, connectionId?: string, teamId?: string) =>
    get<{ issues: LinearIssue[] }>(
      `/linear/project-issues?${scopeQuery({ projectId, teamId }).slice(1)}${projectId || teamId ? "&" : ""}limit=${encodeURIComponent(String(limit))}${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}`,
    ),
  getLinearProjectMapping: (repoRoot: string) =>
    get<{ mapping: LinearProjectMapping | null }>(
      `/linear/project-mappings?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  upsertLinearProjectMapping: (data: {
    repoRoot: string;
    projectId: string;
    projectName: string;
  }) => put<{ mapping: LinearProjectMapping }>("/linear/project-mappings", data),
  removeLinearProjectMapping: (repoRoot: string) =>
    del<{ ok: boolean }>("/linear/project-mappings", { repoRoot }),

  // Linear issue <-> session association
  linkLinearIssue: (sessionId: string, issue: LinearIssue, connectionId?: string) =>
    put<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/linear-issue`, {
      ...issue,
      ...(connectionId !== undefined ? { connectionId } : {}),
    }),
  unlinkLinearIssue: (sessionId: string) =>
    del<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/linear-issue`),
  getLinkedLinearIssue: (sessionId: string, refresh = false) =>
    get<LinearIssueDetail>(
      `/sessions/${encodeURIComponent(sessionId)}/linear-issue${refresh ? "?refresh=true" : ""}`,
    ),
  createLinearIssue: (input: CreateLinearIssueInput) =>
    post<{ ok: boolean; issue: LinearIssue }>("/linear/issues", input),
  addLinearComment: (issueId: string, body: string, connectionId?: string) =>
    post<{ ok: boolean; comment: LinearComment }>(
      `/linear/issues/${encodeURIComponent(issueId)}/comments`,
      { body, connectionId },
    ),

  // Git operations
  getRepoInfo: (path: string) =>
    get<GitRepoInfo>(`/git/repo-info?path=${encodeURIComponent(path)}`),
  listBranches: (repoRoot: string) =>
    get<GitBranchInfo[]>(
      `/git/branches?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  gitFetch: (repoRoot: string) =>
    post<{ success: boolean; output: string }>("/git/fetch", { repoRoot }),
  gitPull: (cwd: string) =>
    post<{
      success: boolean;
      output: string;
      git_ahead: number;
      git_behind: number;
    }>("/git/pull", { cwd }),

  // Git worktrees
  listWorktrees: (repoRoot: string) =>
    get<GitWorktreeInfo[]>(
      `/git/worktrees?repoRoot=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (
    repoRoot: string,
    branch: string,
    opts?: { baseBranch?: string; createBranch?: boolean },
  ) =>
    post<WorktreeCreateResult>("/git/worktree", {
      repoRoot,
      branch,
      ...opts,
    }),
  removeWorktree: (repoRoot: string, worktreePath: string, force?: boolean) =>
    del("/git/worktree", { repoRoot, worktreePath, force }),

  // GitHub PR status
  getPRStatus: (cwd: string, branch: string) =>
    get<PRStatusResponse>(
      `/git/pr-status?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}`,
    ),

  // Backends
  getBackends: () => get<BackendInfo[]>("/backends"),
  getBackendModels: (backendId: string) =>
    get<BackendModelInfo[]>(`/backends/${encodeURIComponent(backendId)}/models`),

  // Editor
  startEditor: (sessionId: string) =>
    post<EditorStartResult>(
      `/sessions/${encodeURIComponent(sessionId)}/editor/start`,
    ),

  // Editor filesystem
  getFileTree: (path: string) =>
    get<{ path: string; tree: TreeNode[] }>(
      `/fs/tree?path=${encodeURIComponent(path)}`,
    ),
  readFile: (path: string) =>
    get<{ path: string; content: string }>(
      `/fs/read?path=${encodeURIComponent(path)}`,
    ),
  getFileBlob: async (path: string): Promise<string> => {
    const res = await fetch(`${BASE}/fs/raw?path=${encodeURIComponent(path)}`, {
      headers: { ...getAuthHeaders() },
    });
    if (!res.ok) {
      handle401(res.status);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || res.statusText);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  writeFile: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/write", { path, content }),
  getFileDiff: (path: string, base?: "last-commit" | "default-branch") =>
    get<{ path: string; diff: string }>(
      `/fs/diff?path=${encodeURIComponent(path)}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
    ),
  getChangedFiles: (cwd: string, base?: "last-commit" | "default-branch") =>
    get<{ files: Array<{ path: string; status: string }> }>(
      `/fs/changed-files?cwd=${encodeURIComponent(cwd)}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
    ),
  getClaudeMdFiles: (cwd: string) =>
    get<{ cwd: string; files: { path: string; content: string }[] }>(
      `/fs/claude-md?cwd=${encodeURIComponent(cwd)}`,
    ),
  saveClaudeMd: (path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/claude-md", { path, content }),
  getClaudeConfig: (cwd: string, sessionId?: string) =>
    get<ClaudeConfigResponse>(
      `/fs/claude-config?cwd=${encodeURIComponent(cwd)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  // Session-scoped config files: only known Claude/Codex config paths are accepted
  readConfigFile: (sessionId: string, path: string) =>
    get<{ path: string; content: string; format: ConfigFileFormat; readOnly: boolean }>(
      `/fs/config-file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
    ),
  writeConfigFile: (sessionId: string, path: string, content: string) =>
    put<{ ok: boolean; path: string }>("/fs/config-file", { sessionId, path, content }),
  createConfigFile: (
    sessionId: string,
    scope: "project" | "user",
    type: NewConfigFileType,
    name?: string,
  ) => post<{ ok: boolean; path: string }>("/fs/config-file", { sessionId, scope, type, name }),

  // Usage limits
  getUsageLimits: () => get<UsageLimits>("/usage-limits"),
  getSessionUsageLimits: (sessionId: string) =>
    get<UsageLimits>(`/sessions/${encodeURIComponent(sessionId)}/usage-limits`),

  // Terminal
  spawnTerminal: (cwd: string, cols?: number, rows?: number) =>
    post<{ terminalId: string }>("/terminal/spawn", { cwd, cols, rows }),
  killTerminal: (terminalId: string) =>
    post<{ ok: boolean }>("/terminal/kill", { terminalId }),
  getTerminal: (terminalId?: string) =>
    get<{ active: boolean; terminalId?: string; cwd?: string }>(
      terminalId
        ? `/terminal?terminalId=${encodeURIComponent(terminalId)}`
        : "/terminal",
    ),

  // Update checking
  checkForUpdate: () => get<UpdateInfo>("/update-check"),
  forceCheckForUpdate: () => post<UpdateInfo>("/update-check"),
  triggerUpdate: () =>
    post<{ ok: boolean; message: string }>("/update"),

  // Background process management
  killProcess: (sessionId: string, taskId: string) =>
    post<{ ok: boolean; taskId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(taskId)}/kill`,
    ),
  killAllProcesses: (sessionId: string, taskIds: string[]) =>
    post<{ ok: boolean; results: { taskId: string; ok: boolean; error?: string }[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/kill-all`,
      { taskIds },
    ),

  // System dev process scanning
  getSystemProcesses: (sessionId: string) =>
    get<{ ok: boolean; processes: { pid: number; command: string; fullCommand: string; ports: number[]; cwd?: string; startedAt?: number }[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/system`,
    ),
  killSystemProcess: (sessionId: string, pid: number) =>
    post<{ ok: boolean; pid: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/processes/system/${pid}/kill`,
    ),

  // Agents
  listAgents: () => get<AgentInfo[]>("/agents"),
  getAgent: (id: string) => get<AgentInfo>(`/agents/${encodeURIComponent(id)}`),
  createAgent: (data: Partial<AgentInfo> & { stagingId?: string; cloneFromAgentId?: string }) =>
    post<AgentInfo>("/agents", data),
  updateAgent: (id: string, data: Partial<AgentInfo>) =>
    put<AgentInfo>(`/agents/${encodeURIComponent(id)}`, data),
  deleteAgent: (id: string) => del(`/agents/${encodeURIComponent(id)}`),
  toggleAgent: (id: string) => post<AgentInfo>(`/agents/${encodeURIComponent(id)}/toggle`),
  runAgent: (id: string, input?: string) =>
    post<{ ok: boolean; message: string }>(`/agents/${encodeURIComponent(id)}/run`, { input }),
  getAgentExecutions: (id: string) =>
    get<AgentExecution[]>(`/agents/${encodeURIComponent(id)}/executions`),
  importAgent: (data: AgentExport) => post<AgentInfo>("/agents/import", data),
  exportAgent: (id: string) => get<AgentExport>(`/agents/${encodeURIComponent(id)}/export`),
  regenerateAgentWebhookSecret: (id: string) =>
    post<AgentInfo>(`/agents/${encodeURIComponent(id)}/regenerate-secret`),

  // Executions (cross-agent, for Runs view)
  listExecutions: (opts?: { agentId?: string; triggerType?: string; status?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set("agentId", opts.agentId);
    if (opts?.triggerType) params.set("triggerType", opts.triggerType);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return get<ExecutionListResult>(`/executions${qs ? `?${qs}` : ""}`);
  },

  // Linear OAuth (Agent Interaction SDK)
  getLinearOAuthStatus: (stagingId?: string) => {
    const params = new URLSearchParams();
    if (stagingId) params.set("stagingId", stagingId);
    const qs = params.toString();
    return get<{ configured: boolean; hasClientId: boolean; hasClientSecret: boolean; hasWebhookSecret: boolean; hasAccessToken: boolean }>(
      `/linear/oauth/status${qs ? `?${qs}` : ""}`,
    );
  },
  getLinearOAuthAuthorizeUrl: (returnTo?: string, stagingId?: string) => {
    const params = new URLSearchParams();
    if (returnTo) params.set("returnTo", returnTo);
    if (stagingId) params.set("stagingId", stagingId);
    const qs = params.toString();
    return get<{ url: string }>(`/linear/oauth/authorize-url${qs ? `?${qs}` : ""}`);
  },
  disconnectLinearOAuth: () =>
    post<{ ok: boolean }>("/linear/oauth/disconnect"),

  // Linear OAuth staging slots (per-wizard credential storage)
  createLinearStaging: (creds: { clientId: string; clientSecret: string; webhookSecret: string }) =>
    post<{ stagingId: string }>("/linear/oauth/staging", creds),
  getLinearStagingStatus: (id: string) =>
    get<{ exists: boolean; hasAccessToken: boolean; hasClientId: boolean; hasClientSecret: boolean }>(`/linear/oauth/staging/${encodeURIComponent(id)}/status`),
  deleteLinearStaging: (id: string) =>
    del(`/linear/oauth/staging/${encodeURIComponent(id)}`),

  // Linear OAuth connections (standalone OAuth app management)
  listLinearOAuthConnections: () =>
    get<{ connections: LinearOAuthConnectionSummary[] }>("/linear/oauth-connections"),
  createLinearOAuthConnection: (data: { name: string; oauthClientId: string; oauthClientSecret: string; webhookSecret: string }) =>
    post<{ connection: LinearOAuthConnectionSummary }>("/linear/oauth-connections", data),
  updateLinearOAuthConnection: (id: string, data: Record<string, unknown>) =>
    put<{ connection: LinearOAuthConnectionSummary }>(`/linear/oauth-connections/${encodeURIComponent(id)}`, data),
  deleteLinearOAuthConnection: (id: string) =>
    del<{ ok: boolean }>(`/linear/oauth-connections/${encodeURIComponent(id)}`),
  getLinearOAuthConnectionAuthorizeUrl: (id: string, returnTo?: string) =>
    get<{ url: string }>(`/linear/oauth-connections/${encodeURIComponent(id)}/authorize-url${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`),

  // Skills
  listSkills: () =>
    get<{ slug: string; name: string; description: string; path: string }[]>("/skills"),

  // Cross-session messaging (a dead session is relaunched and gets it queued)
  sendSessionMessage: (sessionId: string, content: string) =>
    post<{ ok: boolean; delivery?: "sent" | "queued" }>(`/sessions/${encodeURIComponent(sessionId)}/message`, { content }),

  // Scheduled messages into a session ("wake-ups")
  listSessionWakeups: (sessionId: string) =>
    get<{ wakeups: SessionWakeup[] }>(`/sessions/${encodeURIComponent(sessionId)}/wakeups`),
  createSessionWakeup: (sessionId: string, data: { message: string; at?: string; cron?: string }) =>
    post<{ wakeup: SessionWakeup }>(`/sessions/${encodeURIComponent(sessionId)}/wakeups`, data),
  cancelSessionWakeup: (sessionId: string, wakeupId: string) =>
    del<{ ok: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/wakeups/${encodeURIComponent(wakeupId)}`),

  // Saved prompts
  listPrompts: (cwd?: string, scope?: "global" | "project" | "all") => {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    if (scope) params.set("scope", scope);
    const query = params.toString();
    return get<SavedPrompt[]>(`/prompts${query ? `?${query}` : ""}`);
  },
  createPrompt: (data: { name: string; content: string; scope: "global" | "project"; cwd?: string; projectPaths?: string[] }) =>
    post<SavedPrompt>("/prompts", data),
  updatePrompt: (id: string, data: { name?: string; content?: string; scope?: "global" | "project"; projectPaths?: string[] }) =>
    put<SavedPrompt>(`/prompts/${encodeURIComponent(id)}`, data),
  deletePrompt: (id: string) =>
    del<{ ok: boolean }>(`/prompts/${encodeURIComponent(id)}`),
};
