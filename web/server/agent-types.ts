// ─── Agent Types ─────────────────────────────────────────────────────────────

export interface McpServerConfigAgent {
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentConfig {
  /** Unique slug-based ID (derived from name) */
  id: string;
  /** Schema version for forward compat */
  version: 1;
  /** Human-readable name */
  name: string;
  /** Short description of what this agent does */
  description: string;
  /** Emoji or icon identifier */
  icon?: string;

  // ── Session Config ──
  /** "claude" or "codex" */
  backendType: "claude" | "codex";
  /** Model to use (e.g. "claude-sonnet-4-6") */
  model: string;
  /**
   * Claude agents always run with bypassPermissions: an unattended run has
   * nobody to answer approval prompts, so any other mode would just block.
   * For Codex this picks the sandbox: "bypassPermissions" → danger-full-access,
   * anything else → workspace-write (approvals are never asked either way).
   */
  permissionMode: string;
  /** Working directory path, or "temp" for an auto-created temp dir */
  cwd: string;
  /** Optional environment slug (references ~/.companion/envs/) */
  envSlug?: string;
  /** Extra environment variables */
  env?: Record<string, string>;
  /**
   * Claude only: the built-in tools the agent may use, passed as `--tools`
   * (which really removes the others; `--allowedTools` only pre-approves and
   * restricts nothing under bypassPermissions). Empty = all tools. MCP tools
   * are not affected. Codex has no per-tool switch, so it ignores this.
   */
  allowedTools?: string[];
  /** Codex-specific: internet access */
  codexInternetAccess?: boolean;

  // ── Prompt ──
  /** Prompt template. Use {{input}} as placeholder for trigger-provided input */
  prompt: string;
  /**
   * What each run starts from:
   *  - "brief" (default): a fresh session; the prompt must be self-contained.
   *  - "fork": a COPY of sourceSessionId's conversation (Claude
   *    `--resume <id> --fork-session`, Codex `thread/fork`), run in that
   *    session's folder. The source session is never modified.
   */
  contextMode?: "brief" | "fork";
  /** Companion session id each "fork" run copies the conversation of. */
  sourceSessionId?: string;

  // ── MCP Servers ──
  /** MCP server configs to set on the session after CLI connects */
  mcpServers?: Record<string, McpServerConfigAgent>;

  // ── Triggers ──
  triggers?: {
    /** Webhook trigger config */
    webhook?: {
      enabled: boolean;
      /** Auto-generated secret token for URL auth */
      secret: string;
    };
    /** Cron/schedule trigger config */
    schedule?: {
      enabled: boolean;
      /**
       * 5-field cron expression (minute precision, no seconds field) or, for
       * a one-shot, a local date-time ("YYYY-MM-DDTHH:mm"). Both run in the
       * global timeZone setting ("" = the server's local zone).
       */
      expression: string;
      /** true = recurring cron, false = one-shot */
      recurring: boolean;
    };
    /** Linear Agent Interaction SDK trigger (per-agent OAuth app) */
    linear?: {
      enabled: boolean;
      /** Reference to a LinearOAuthConnection by ID (new model) */
      oauthConnectionId?: string;
      /** @deprecated OAuth app client ID from Linear — use oauthConnectionId instead */
      oauthClientId?: string;
      /** @deprecated OAuth app client secret — use oauthConnectionId instead */
      oauthClientSecret?: string;
      /** @deprecated Webhook signing secret — use oauthConnectionId instead */
      webhookSecret?: string;
      /** @deprecated OAuth access token — use oauthConnectionId instead */
      accessToken?: string;
      /** @deprecated OAuth refresh token — use oauthConnectionId instead */
      refreshToken?: string;
    };
  };

  // ── Tracking ──
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastSessionId?: string;
  totalRuns: number;
  consecutiveFailures: number;
}

/** Input for creating an agent (without auto-generated fields) */
export type AgentConfigCreateInput = Omit<
  AgentConfig,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId"
>;

/** The portable/shareable JSON format (no internal tracking fields) */
export type AgentConfigExport = Omit<
  AgentConfig,
  "id" | "createdAt" | "updatedAt" | "totalRuns" | "consecutiveFailures" | "lastRunAt" | "lastSessionId" | "enabled"
>;

/**
 * One run of an agent. A run is complete on the first turn result of its
 * session (or when the CLI exits first); the session itself is kept.
 */
export interface AgentExecution {
  /** The session ID created for this execution ("" if the launch failed) */
  sessionId: string;
  /** The agent ID that triggered this */
  agentId: string;
  /** Trigger type that initiated this execution */
  triggerType: "manual" | "webhook" | "schedule" | "linear";
  /** When the execution started */
  startedAt: number;
  /** When the execution completed */
  completedAt?: number;
  /** Whether the execution succeeded (the turn result was not an error) */
  success?: boolean;
  /** Error message if it failed */
  error?: string;
  /** Result subtype reported by the CLI (e.g. "success", "error_max_turns") */
  subtype?: string;
  /**
   * Temp working directory created for a cwd:"temp" agent. Deleted once the
   * run is done and its session is archived or gone.
   */
  tempCwd?: string;
}
