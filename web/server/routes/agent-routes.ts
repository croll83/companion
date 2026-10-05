import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import * as agentStore from "../agent-store.js";
import type { AgentExecutor } from "../agent-executor.js";
import type { AgentConfig, AgentConfigCreateInput, AgentConfigExport } from "../agent-types.js";
import { validateSchedule } from "../agent-schedule.js";
import { getSettings, updateSettings } from "../settings-manager.js";
import * as staging from "../linear-staging.js";
import { getOAuthConnection, createOAuthConnection } from "../linear-oauth-connections.js";
import { isTrustedRequest, socketAddress } from "../network-trust.js";
import { accessDenied, agentAccessLevel, mcpCallerOf, sessionAccessLevel } from "../companion-mcp-auth.js";

/** What the routes need to know about a session (the launcher's record). */
export type AgentSessionLookup = (sessionId: string) => { backendType?: string; codexSandbox?: string } | undefined;

/**
 * Agents that sessions may have created through the `companion` MCP tools
 * (createdBy "session:<id>"), all sessions together. Agents created by the
 * user do not count.
 */
export const MAX_AGENTS_BY_SESSIONS = 20;

/** Default and largest size of a run result returned by GET /executions/:sessionId/result. */
const RESULT_DEFAULT_CHARS = 4000;
const RESULT_MAX_CHARS = 20_000;

/** Fields the user can set when creating/updating an agent */
const EDITABLE_FIELDS = [
  "name", "description", "icon", "version",
  "backendType", "model", "permissionMode", "cwd",
  "envSlug", "env", "allowedTools", "codexInternetAccess",
  "prompt", "contextMode", "sourceSessionId", "mcpServers",
  "triggers", "enabled",
] as const;

/** A built-in Claude tool name, as `--tools` accepts it (no permission patterns). */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Reject what would otherwise fail later and silently: a schedule croner
 * cannot arm (or a one-time date already past, when `rejectPast`),
 * allowedTools entries `--tools` cannot take, and a "fork" context without a
 * usable source session (`forkSourceError`, checked against the agent as it
 * will be saved). Returns an error or null.
 */
function validateAgentFields(
  fields: Partial<AgentConfig>,
  opts: { rejectPast: boolean; saved?: Partial<AgentConfig>; forkSourceError?: AgentExecutor["forkSourceError"] },
): string | null {
  const scheduleError = validateSchedule(fields.triggers?.schedule, { rejectPast: opts.rejectPast });
  if (scheduleError) return scheduleError;
  if (fields.contextMode !== undefined && fields.contextMode !== "brief" && fields.contextMode !== "fork") {
    return 'contextMode must be "brief" or "fork"';
  }
  if (fields.sourceSessionId !== undefined && fields.sourceSessionId !== null && typeof fields.sourceSessionId !== "string") {
    return "sourceSessionId must be a session id";
  }
  const saved = { ...opts.saved, ...fields };
  if (saved.contextMode === "fork") {
    if (!saved.sourceSessionId) return 'contextMode "fork" needs a sourceSessionId (the session to fork)';
    const forkError = opts.forkSourceError?.(saved.sourceSessionId, saved.backendType ?? "claude");
    if (forkError) return forkError;
  }
  if (fields.allowedTools !== undefined) {
    if (!Array.isArray(fields.allowedTools)) return "allowedTools must be an array of tool names";
    const bad = fields.allowedTools.find((t) => typeof t !== "string" || !TOOL_NAME_PATTERN.test(t));
    if (bad !== undefined) {
      return `Invalid tool name "${String(bad)}": use built-in tool names such as Read, Grep or Bash (permission patterns like Bash(git *) are not supported)`;
    }
  }
  return null;
}

function pickEditable(body: Record<string, unknown>): Partial<AgentConfig> {
  const result: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result as Partial<AgentConfig>;
}

function buildCreateInput(
  body: Record<string, unknown>,
  overrides?: Partial<Pick<AgentConfigCreateInput, "enabled" | "version">>,
): AgentConfigCreateInput {
  return {
    version: overrides?.version ?? 1,
    name: (body.name as string | undefined) || "",
    description: (body.description as string | undefined) || "",
    icon: body.icon as string | undefined,
    backendType: (body.backendType as AgentConfig["backendType"] | undefined) || "claude",
    model: (body.model as string | undefined) || "",
    permissionMode: (body.permissionMode as string | undefined) || "bypassPermissions",
    cwd: (body.cwd as string | undefined) || "",
    envSlug: body.envSlug as string | undefined,
    env: body.env as Record<string, string> | undefined,
    allowedTools: body.allowedTools as string[] | undefined,
    codexInternetAccess: body.codexInternetAccess as boolean | undefined,
    prompt: (body.prompt as string | undefined) || "",
    contextMode: body.contextMode as AgentConfig["contextMode"] | undefined,
    sourceSessionId: body.sourceSessionId as string | undefined,
    mcpServers: body.mcpServers as AgentConfig["mcpServers"] | undefined,
    triggers: body.triggers as AgentConfig["triggers"] | undefined,
    enabled: overrides?.enabled ?? ((body.enabled as boolean | undefined) ?? true),
  };
}

type AgentWithRuntime = AgentConfig & {
  nextRunAt?: number | null;
  /** A run of this agent is launching or waiting for its result. */
  running?: boolean;
  /** Why the schedule is not running as configured (past, invalid, skipped). */
  scheduleError?: string | null;
};

/** Strip sensitive Linear OAuth credentials before sending to the browser */
function sanitizeAgent(agent: AgentWithRuntime): Record<string, unknown> {
  if (!agent.triggers?.linear) return agent as unknown as Record<string, unknown>;
  const { oauthClientSecret, webhookSecret, accessToken, refreshToken, ...safeLinear } = agent.triggers.linear;

  // Resolve connection info for display and flag derivation
  const conn = safeLinear.oauthConnectionId
    ? getOAuthConnection(safeLinear.oauthConnectionId)
    : null;
  const oauthConnectionName = conn?.name;
  const oauthConnectionStatus = conn?.status;

  return {
    ...agent,
    triggers: {
      ...agent.triggers,
      linear: {
        ...safeLinear,
        hasAccessToken: !!(accessToken || oauthConnectionStatus === "connected"),
        hasClientSecret: !!(oauthClientSecret || conn?.oauthClientSecret),
        hasWebhookSecret: !!(webhookSecret || conn?.webhookSecret),
        oauthConnectionName,
        oauthConnectionStatus,
      },
    },
  } as unknown as Record<string, unknown>;
}

/** Strip internal tracking fields to produce a portable export */
function toExport(agent: AgentConfig): AgentConfigExport {
  const {
    id: _id,
    createdAt: _ca,
    updatedAt: _ua,
    totalRuns: _tr,
    consecutiveFailures: _cf,
    lastRunAt: _lr,
    lastSessionId: _ls,
    enabled: _en,
    createdBy: _cb,
    ...exportable
  } = agent;
  // Strip Linear OAuth credentials from export (keep oauthConnectionId for reference)
  if (exportable.triggers?.linear) {
    const { oauthClientId, oauthClientSecret, webhookSecret, accessToken, refreshToken, ...safeLinear } = exportable.triggers.linear;
    exportable.triggers = { ...exportable.triggers, linear: safeLinear };
  }
  return exportable;
}

export function registerAgentRoutes(
  api: Hono,
  agentExecutor?: AgentExecutor,
  getSession?: AgentSessionLookup,
): void {
  /**
   * For a request from a session's `companion` MCP server: why it may not
   * act on an agent that runs at `target` level (see accessDenied), or null.
   */
  const deniedForCaller = (caller: string | null, agents: Array<Partial<AgentConfig>>, what: string): string | null => {
    if (!caller) return null;
    const info = getSession?.(caller);
    if (!info) return null;
    const level = sessionAccessLevel(info);
    for (const agent of agents) {
      const denied = accessDenied(level, agentAccessLevel(agent), what);
      if (denied) return denied;
    }
    return null;
  };

  const forkSourceError: AgentExecutor["forkSourceError"] | undefined = agentExecutor
    ? (sourceSessionId, backendType) => agentExecutor.forkSourceError(sourceSessionId, backendType)
    : undefined;

  /** The agent as the browser sees it: live run/schedule state, no secrets. */
  const present = (agent: AgentConfig) => sanitizeAgent({
    ...agent,
    nextRunAt: agentExecutor?.getNextRunTime(agent.id)?.getTime() ?? null,
    running: agentExecutor?.isRunInProgress(agent.id) ?? false,
    scheduleError: agentExecutor?.getScheduleIssue(agent.id) ?? null,
  });

  // ── CRUD ────────────────────────────────────────────────────────────────

  api.get("/agents", (c) => {
    return c.json(agentStore.listAgents().map(present));
  });

  api.get("/agents/:id", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(present(agent));
  });

  api.post("/agents", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const input = buildCreateInput(body);
      const invalid = validateAgentFields(input, { rejectPast: true, forkSourceError });
      if (invalid) return c.json({ error: invalid }, 400);
      const caller = mcpCallerOf(c.req.header("Authorization"));
      if (caller) {
        const denied = deniedForCaller(caller, [input], "create an agent");
        if (denied) return c.json({ error: denied }, 403);
        const bySessions = agentStore.listAgents().filter((a) => a.createdBy?.startsWith("session:")).length;
        if (bySessions >= MAX_AGENTS_BY_SESSIONS) {
          return c.json({
            error: `Sessions have already created ${MAX_AGENTS_BY_SESSIONS} agents (the limit for agents created by sessions). Delete agents that are no longer needed, or ask the user to create this one from the Agents page.`,
          }, 409);
        }
        input.createdBy = `session:${caller}`;
      }
      const agent = agentStore.createAgent(input);

      // If this is a Linear agent, resolve credentials:
      // New model: oauthConnectionId already set in triggers.linear
      // Legacy model: resolve from staging/clone/global
      if (agent.triggers?.linear?.enabled) {
        // New model: oauthConnectionId passed directly — nothing more to do
        if (agent.triggers.linear.oauthConnectionId) {
          // Already stored via triggers, just proceed
        } else if (!agent.triggers.linear.oauthClientId) {
          // Legacy model: resolve credentials from staging/clone/global
          let linearCreds: {
            oauthClientId: string;
            oauthClientSecret: string;
            webhookSecret: string;
            accessToken: string;
            refreshToken: string;
          } | null = null;

          // Priority 1: staging slot → create OAuth connection from it
          if (body.stagingId) {
            const slot = staging.consumeSlot(body.stagingId);
            if (slot?.clientId) {
              // Create a new OAuth connection from the staging slot
              const conn = createOAuthConnection({
                name: `${agent.name} OAuth App`,
                oauthClientId: slot.clientId,
                oauthClientSecret: slot.clientSecret,
                webhookSecret: slot.webhookSecret,
                accessToken: slot.accessToken,
                refreshToken: slot.refreshToken,
              });
              const updated = agentStore.updateAgent(agent.id, {
                triggers: {
                  ...agent.triggers,
                  linear: {
                    ...agent.triggers.linear,
                    oauthConnectionId: conn.id,
                  },
                },
              });
              if (updated) {
                if (updated.enabled && updated.triggers?.schedule?.enabled) {
                  agentExecutor?.scheduleAgent(updated);
                }
                return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
              }
            }
          }

          // Priority 2: clone from existing agent
          if (!linearCreds && body.cloneFromAgentId) {
            const source = agentStore.getAgent(body.cloneFromAgentId);
            // Prefer cloning the oauthConnectionId reference
            if (source?.triggers?.linear?.oauthConnectionId) {
              const updated = agentStore.updateAgent(agent.id, {
                triggers: {
                  ...agent.triggers,
                  linear: {
                    ...agent.triggers.linear,
                    oauthConnectionId: source.triggers.linear.oauthConnectionId,
                  },
                },
              });
              if (updated) {
                if (updated.enabled && updated.triggers?.schedule?.enabled) {
                  agentExecutor?.scheduleAgent(updated);
                }
                return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
              }
            } else if (source?.triggers?.linear?.oauthClientId) {
              linearCreds = {
                oauthClientId: source.triggers.linear.oauthClientId,
                oauthClientSecret: source.triggers.linear.oauthClientSecret || "",
                webhookSecret: source.triggers.linear.webhookSecret || "",
                accessToken: source.triggers.linear.accessToken || "",
                refreshToken: source.triggers.linear.refreshToken || "",
              };
            }
          }

          // Priority 3: global staging (backward compat)
          if (!linearCreds) {
            const settings = getSettings();
            if (settings.linearOAuthClientId) {
              linearCreds = {
                oauthClientId: settings.linearOAuthClientId,
                oauthClientSecret: settings.linearOAuthClientSecret,
                webhookSecret: settings.linearOAuthWebhookSecret,
                accessToken: settings.linearOAuthAccessToken,
                refreshToken: settings.linearOAuthRefreshToken,
              };
            }
          }

          if (linearCreds) {
            const updated = agentStore.updateAgent(agent.id, {
              triggers: {
                ...agent.triggers,
                linear: {
                  ...agent.triggers.linear,
                  ...linearCreds,
                },
              },
            });
            if (updated) {
              // Clear global staging if we used it (no stagingId and no clone source)
              if (!body.stagingId && !body.cloneFromAgentId) {
                updateSettings({
                  linearOAuthClientId: "",
                  linearOAuthClientSecret: "",
                  linearOAuthWebhookSecret: "",
                  linearOAuthAccessToken: "",
                  linearOAuthRefreshToken: "",
                });
              }
              if (updated.enabled && updated.triggers?.schedule?.enabled) {
                agentExecutor?.scheduleAgent(updated);
              }
              return c.json(sanitizeAgent({ ...updated, nextRunAt: null }), 201);
            }
          }
        }
      }

      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      }
      return c.json(sanitizeAgent({ ...agent, nextRunAt: null }), 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/agents/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const allowed = pickEditable(body);
      const saved = agentStore.getAgent(id) ?? undefined;
      // `triggers` replaces the whole object. A client that does not send the
      // Linear trigger (the MCP tools never do: they only see it without its
      // credentials) must not wipe it.
      if (allowed.triggers && saved?.triggers?.linear && !("linear" in allowed.triggers)) {
        allowed.triggers = { ...allowed.triggers, linear: saved.triggers.linear };
      }
      const invalid = validateAgentFields(allowed, {
        rejectPast: true,
        saved,
        forkSourceError,
      });
      if (invalid) return c.json({ error: invalid }, 400);
      if (saved) {
        const denied = deniedForCaller(mcpCallerOf(c.req.header("Authorization")), [saved, { ...saved, ...allowed }], "change an agent");
        if (denied) return c.json({ error: denied }, 403);
      }
      const agent = agentStore.updateAgent(id, allowed);
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      // Stop old timer (id may differ after a rename)
      if (agent.id !== id) {
        agentExecutor?.stopAgent(id);
      }
      // Reschedule if enabled
      if (agent.enabled && agent.triggers?.schedule?.enabled) {
        agentExecutor?.scheduleAgent(agent);
      } else {
        agentExecutor?.stopAgent(agent.id);
      }
      return c.json(present(agent));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/agents/:id", (c) => {
    const id = c.req.param("id");
    const existing = agentStore.getAgent(id);
    if (existing) {
      const denied = deniedForCaller(mcpCallerOf(c.req.header("Authorization")), [existing], "delete an agent");
      if (denied) return c.json({ error: denied }, 403);
    }
    agentExecutor?.stopAgent(id);
    const deleted = agentStore.deleteAgent(id);
    if (!deleted) return c.json({ error: "Agent not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Toggle ──────────────────────────────────────────────────────────────

  api.post("/agents/:id/toggle", (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const updated = agentStore.updateAgent(id, { enabled: !agent.enabled });
    if (updated?.enabled && updated.triggers?.schedule?.enabled) {
      agentExecutor?.scheduleAgent(updated);
    } else if (updated) {
      agentExecutor?.stopAgent(updated.id);
    }
    return c.json(updated ? present(updated) : updated);
  });

  // ── Run (manual trigger) ───────────────────────────────────────────────

  api.post("/agents/:id/run", async (c) => {
    const id = c.req.param("id");
    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const denied = deniedForCaller(mcpCallerOf(c.req.header("Authorization")), [agent], "run an agent");
    if (denied) return c.json({ error: denied }, 403);
    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : undefined;
    // Runs even if the agent is disabled, but not on top of a run in progress.
    const result = agentExecutor?.executeAgentManually(id, input);
    if (result && !result.ok) return c.json({ error: result.error }, result.status);
    // The run's session exists as soon as the launch started (undefined if
    // it failed synchronously; the run is then already recorded as failed).
    const sessionId = agentExecutor?.runSessionOf?.(id);
    return c.json({ ok: true, message: "Agent triggered", ...(sessionId ? { sessionId } : {}) });
  });

  // ── Executions ─────────────────────────────────────────────────────────

  api.get("/agents/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(agentExecutor?.getExecutions(id) ?? []);
  });

  /** List executions across all agents with filtering and pagination (for Runs view). */
  api.get("/executions", (c) => {
    const agentId = c.req.query("agentId");
    const triggerType = c.req.query("triggerType");
    const rawStatus = c.req.query("status");
    const status = (rawStatus === "running" || rawStatus === "success" || rawStatus === "error")
      ? rawStatus : undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 500);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    return c.json(agentExecutor?.listAllExecutions({ agentId, triggerType, status, limit, offset }) ?? { executions: [], total: 0 });
  });

  /** The final answer of a run (the result of its first turn), truncated to ?maxChars. */
  api.get("/executions/:sessionId/result", (c) => {
    const requested = Number(c.req.query("maxChars"));
    const maxChars = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), RESULT_MAX_CHARS)
      : RESULT_DEFAULT_CHARS;
    const result = agentExecutor?.getRunResult(c.req.param("sessionId"), maxChars);
    if (!result) return c.json({ error: "Run not found" }, 404);
    return c.json(result);
  });

  // ── Import / Export ────────────────────────────────────────────────────

  api.post("/agents/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      // Accept an exported agent JSON and create a new agent from it.
      // Fields of removed features (skills, branch, ...) are simply ignored.
      const input = buildCreateInput(body, {
        version: (body.version as AgentConfigCreateInput["version"] | undefined) || 1,
        enabled: false, // Imported agents start disabled for safety
      });
      // A past one-time date is fine here: the agent starts disabled.
      const invalid = validateAgentFields(input, { rejectPast: false });
      if (invalid) return c.json({ error: invalid }, 400);
      const agent = agentStore.createAgent(input);
      return c.json(sanitizeAgent({ ...agent, nextRunAt: null }), 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get("/agents/:id/export", (c) => {
    const agent = agentStore.getAgent(c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(toExport(agent));
  });

  // ── Webhook Secret ─────────────────────────────────────────────────────

  api.post("/agents/:id/regenerate-secret", (c) => {
    const id = c.req.param("id");
    const agent = agentStore.regenerateWebhookSecret(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(present(agent));
  });
}

// ── Webhook trigger ─────────────────────────────────────────────────────────

/** Webhook triggers allowed per agent per window (failed launches included). */
const WEBHOOK_RATE_LIMIT = 10;
const WEBHOOK_RATE_WINDOW_MS = 60_000;
/** Largest webhook body accepted (the input ends up in the prompt). */
const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** Fixed-window counter per key; returns seconds to wait, or 0 if allowed. */
function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): number => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
    }
    recent.push(now);
    hits.set(key, recent);
    return 0;
  };
}

/** The `input` of a webhook call: JSON `{"input": "..."}` or a plain-text body. */
async function readWebhookInput(c: Context): Promise<{ input?: string } | { tooLarge: true }> {
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > WEBHOOK_MAX_BODY_BYTES) return { tooLarge: true };
  const text = await c.req.text().catch(() => "");
  if (Buffer.byteLength(text) > WEBHOOK_MAX_BODY_BYTES) return { tooLarge: true };
  if ((c.req.header("content-type") || "").includes("application/json")) {
    try {
      const body = JSON.parse(text) as { input?: unknown };
      return { input: typeof body?.input === "string" ? body.input : undefined };
    } catch {
      return {};
    }
  }
  return text.trim() ? { input: text.trim() } : {};
}

/**
 * POST /agents/:id/webhook/:secret — authenticated by the per-agent secret
 * alone, so it is registered BEFORE the auth middleware (like the Linear
 * webhook). It must never be reachable from the internet: only loopback and
 * the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48) are accepted, and a request
 * relayed by a local proxy/tunnel is judged by its forwarded client address.
 */
export function registerAgentWebhookRoute(api: Hono, agentExecutor?: AgentExecutor): void {
  const rateLimit = createRateLimiter(WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS);

  api.post("/agents/:id/webhook/:secret", async (c) => {
    if (!isTrustedRequest(socketAddress(c.env, c.req.raw), c.req.raw.headers)) {
      return c.json({ error: "Agent webhooks are accepted only from this machine or the tailnet" }, 403);
    }

    const id = c.req.param("id");
    const secret = c.req.param("secret");

    const agent = agentStore.getAgent(id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    // Validate webhook is enabled and secret matches
    if (!agent.triggers?.webhook?.enabled) {
      return c.json({ error: "Webhook not enabled for this agent" }, 403);
    }
    // Use constant-time comparison to prevent timing attacks
    const expected = Buffer.from(agent.triggers.webhook.secret);
    const received = Buffer.from(secret);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return c.json({ error: "Invalid webhook secret" }, 401);
    }

    const retryAfter = rateLimit(agent.id);
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: `Too many webhook calls for this agent; retry in ${retryAfter}s` }, 429);
    }

    const body = await readWebhookInput(c);
    if ("tooLarge" in body) {
      return c.json({ error: `Webhook body exceeds ${WEBHOOK_MAX_BODY_BYTES / 1024} KB` }, 413);
    }

    // Honours agent.enabled and refuses to overlap a run in progress.
    const result = agentExecutor?.startRun(agent.id, body.input, { triggerType: "webhook" });
    if (result && !result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, message: "Agent triggered via webhook" });
  });
}
