#!/usr/bin/env bun
/**
 * The `companion` MCP server: lets a Claude Code or Codex session schedule
 * wake-ups into itself and create/manage Companion agents on its own.
 *
 * Started by the CLI (Claude: `--mcp-config`, Codex: `mcp_servers.companion`
 * in the session's config.toml) as `bun companion-mcp.ts`, with:
 *   COMPANION_API_URL     Companion's REST API, e.g. http://127.0.0.1:3456/api
 *   COMPANION_MCP_TOKEN   bearer token of this session (companion-mcp-auth.ts)
 *   COMPANION_SESSION_ID  the Companion session the CLI belongs to
 *
 * Transport: MCP stdio, i.e. newline-delimited JSON-RPC 2.0 on stdin/stdout
 * (logs go to stderr only). Implemented by hand on purpose — Companion's
 * updater never installs dependencies, so no MCP SDK. Supported: initialize,
 * notifications/initialized, ping, tools/list, tools/call.
 *
 * Standalone: imports only Node built-ins, so it starts fast and keeps
 * working whatever else in server/ changes.
 */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

// ── JSON-RPC / MCP plumbing ─────────────────────────────────────────────────

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_VERSION = "1.0.0";

type JsonObject = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: JsonObject;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A tool failure reported to the model (isError), not a protocol error. */
class ToolError extends Error {}

// ── Companion API client ────────────────────────────────────────────────────

export interface CompanionMcpConfig {
  apiUrl: string;
  token: string;
  sessionId: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Host for webhook URLs: the Tailscale IPv4 when available, else "localhost". */
  webhookHost?: () => Promise<string>;
  /** Clock (tests). */
  now?: () => number;
}

const API_TIMEOUT_MS = 30_000;

type Api = (method: string, path: string, body?: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function createApi(config: CompanionMcpConfig): Api {
  const doFetch = config.fetch ?? fetch;
  const base = config.apiUrl.replace(/\/+$/, "");
  return async (method, path, body) => {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ToolError(`Companion is not reachable at ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* plain text */
    }
    if (!res.ok) {
      const message = data && typeof data === "object" && typeof (data as JsonObject).error === "string"
        ? (data as JsonObject).error as string
        : `HTTP ${res.status}`;
      throw new ToolError(`Companion API ${method} ${path} failed (${res.status}): ${message}`);
    }
    return data;
  };
}

/** This host's Tailscale IPv4 (`tailscale ip -4`), or "localhost". */
export function tailscaleHost(): Promise<string> {
  return new Promise((resolveHost) => {
    try {
      execFile("tailscale", ["ip", "-4"], { timeout: 3000 }, (err, stdout) => {
        const ip = String(stdout ?? "").split("\n")[0]?.trim() ?? "";
        resolveHost(!err && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : "localhost");
      });
    } catch {
      resolveHost("localhost");
    }
  });
}

// ── Argument helpers ────────────────────────────────────────────────────────

function str(args: JsonObject, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`);
  return value;
}

function bool(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolError(`"${key}" must be true or false`);
  return value;
}

function num(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ToolError(`"${key}" must be a number`);
  return value;
}

const enc = encodeURIComponent;

function iso(ms: unknown): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * The one schedule given as at / in_minutes / cron, or undefined for none.
 * `in_minutes` becomes an absolute UTC time here (models rarely know "now").
 */
function scheduleArgs(args: JsonObject, now: number): { at: string } | { cron: string } | undefined {
  const at = str(args, "at");
  const inMinutes = num(args, "in_minutes");
  const cron = str(args, "cron");
  const given = [at, inMinutes, cron].filter((v) => v !== undefined).length;
  if (given > 1) throw new ToolError("Give only one of at, in_minutes or cron");
  if (inMinutes !== undefined) {
    if (inMinutes < 1) throw new ToolError("in_minutes must be at least 1");
    return { at: new Date(now + Math.round(inMinutes * 60_000)).toISOString() };
  }
  if (at !== undefined) return { at };
  if (cron !== undefined) return { cron };
  return undefined;
}

function reply(summary: string, data?: unknown): string {
  return data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
}

// ── Tools ───────────────────────────────────────────────────────────────────

interface ToolContext {
  api: Api;
  sessionId: string;
  now: () => number;
  webhookUrl: (agentId: string, secret: string) => Promise<string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject;
  run(args: JsonObject, ctx: ToolContext): Promise<string>;
}

const SCHEDULE_PROPS = {
  at: {
    type: "string",
    description: "Run once at this time: ISO 8601, preferably with an offset (2026-10-05T14:30:00+02:00 or …Z). Without an offset it is read in Companion's time zone setting.",
  },
  in_minutes: { type: "number", description: "Run once, this many minutes from now (alternative to at)." },
  cron: {
    type: "string",
    description: "Repeat on a 5-field cron expression: minute hour day-of-month month day-of-week (e.g. \"0 9 * * 1-5\" = weekdays at 09:00), in Companion's time zone setting.",
  },
} as const;

const SESSION_ID_PROP = {
  session_id: { type: "string", description: "Target Companion session id. Default: this session." },
} as const;

const AGENT_ID_PROP = { agent_id: { type: "string", description: "Agent id (from list_agents or create_agent)." } } as const;

function wakeupSummary(w: JsonObject): JsonObject {
  return {
    id: w.id,
    status: w.status,
    schedule: w.schedule,
    nextRunAt: iso(w.nextRunAt),
    lastFiredAt: iso(w.lastFiredAt),
    createdBy: w.createdBy,
    lastResult: w.lastResult,
    message: w.message,
  };
}

function agentSummary(a: JsonObject): JsonObject {
  const triggers = (a.triggers ?? {}) as JsonObject;
  const schedule = triggers.schedule as JsonObject | undefined;
  const webhook = triggers.webhook as JsonObject | undefined;
  return {
    id: a.id,
    name: a.name,
    description: a.description || undefined,
    enabled: a.enabled,
    backend: a.backendType,
    model: a.model || "(default)",
    cwd: a.cwd,
    contextMode: a.contextMode ?? "brief",
    schedule: schedule?.enabled ? { expression: schedule.expression, recurring: schedule.recurring } : undefined,
    nextRunAt: iso(a.nextRunAt),
    webhook: webhook?.enabled ? true : undefined,
    running: a.running || undefined,
    scheduleError: a.scheduleError || undefined,
    lastRunAt: iso(a.lastRunAt),
    lastSessionId: a.lastSessionId,
    createdBy: a.createdBy ?? "user",
  };
}

/** `triggers` for create/update from the tool arguments, on top of `existing`. */
function buildTriggers(
  args: JsonObject,
  now: number,
  existing: JsonObject = {},
): { triggers: JsonObject; changed: boolean } {
  const triggers: JsonObject = {};
  if (existing.schedule) triggers.schedule = existing.schedule;
  if (existing.webhook) triggers.webhook = existing.webhook;
  let changed = false;
  const schedule = scheduleArgs(args, now);
  if (schedule) {
    triggers.schedule = "cron" in schedule
      ? { enabled: true, expression: schedule.cron, recurring: true }
      : { enabled: true, expression: schedule.at, recurring: false };
    changed = true;
  } else if (bool(args, "clear_schedule")) {
    if (triggers.schedule) triggers.schedule = { ...(triggers.schedule as JsonObject), enabled: false };
    changed = true;
  }
  const webhook = bool(args, "webhook");
  if (webhook !== undefined) {
    const prev = (existing.webhook ?? {}) as JsonObject;
    triggers.webhook = { enabled: webhook, secret: typeof prev.secret === "string" ? prev.secret : "" };
    changed = true;
  }
  return { triggers, changed };
}

async function describeAgent(agent: JsonObject, ctx: ToolContext, verb: string): Promise<string> {
  const lines = [`${verb} agent "${agent.name}" (id: ${agent.id}).`];
  const summary = agentSummary(agent);
  const webhook = ((agent.triggers ?? {}) as JsonObject).webhook as JsonObject | undefined;
  if (webhook?.enabled && typeof webhook.secret === "string" && webhook.secret) {
    const url = await ctx.webhookUrl(String(agent.id), webhook.secret);
    summary.webhookUrl = url;
    lines.push(
      `Webhook: POST ${url} with a JSON body {"input": "..."} or plain text (it becomes the run's input).`,
      "The webhook is reachable only from this machine and the tailnet, and the URL is its only credential: share it only with what must trigger the agent.",
    );
  }
  if (summary.scheduleError) lines.push(`Schedule problem: ${summary.scheduleError}`);
  return reply(lines.join("\n"), summary);
}

const TOOLS: ToolDef[] = [
  {
    name: "schedule_wakeup",
    description: [
      "Schedule a message to be delivered into a Companion session later — by default THIS session, which then continues with its whole conversation context.",
      "Use when the user asks for something to happen at a later time or on a schedule (\"check the deploy in 30 minutes\", \"every morning at 9 summarize the open PRs\"), or when work must continue while nobody is watching: waiting for a long build, CI or a download, polling something, following up later.",
      "Write the message as instructions to your future self: what to check, what to do next, where your notes are. It arrives as a user message starting with \"[scheduled wake-up …]\".",
      "Give exactly one of at, in_minutes (one time) or cron (repeating). If the session is busy at that time the message waits for the current turn to end; if its CLI was stopped it is restarted on this conversation first.",
      "Prefer this over create_agent whenever the follow-up needs this conversation's context.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What the session should do when it wakes up." },
        ...SCHEDULE_PROPS,
        ...SESSION_ID_PROP,
      },
      required: ["message"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const message = str(args, "message", true);
      const schedule = scheduleArgs(args, ctx.now());
      if (!schedule) throw new ToolError("Give one of at, in_minutes or cron");
      const target = str(args, "session_id") ?? ctx.sessionId;
      const res = await ctx.api("POST", `/sessions/${enc(target)}/wakeups`, { message, ...schedule });
      const w = res.wakeup as JsonObject;
      const when = "cron" in schedule ? `on cron "${schedule.cron}" (next: ${iso(w.nextRunAt) ?? "?"})` : `at ${iso(w.nextRunAt) ?? schedule.at}`;
      const whose = target === ctx.sessionId ? "this session" : `session ${target}`;
      return reply(
        `Scheduled wake-up ${w.id} for ${whose} ${when}. Now: ${new Date(ctx.now()).toISOString()}. Cancel it with cancel_wakeup if it is no longer needed.`,
        wakeupSummary(w),
      );
    },
  },
  {
    name: "list_wakeups",
    description: "List the scheduled wake-ups of this session (or of session_id): pending ones with their next time, and recently delivered, skipped or missed ones with the reason. Use before scheduling a follow-up to avoid duplicates, or when the user asks what is scheduled.",
    inputSchema: { type: "object", properties: { ...SESSION_ID_PROP }, additionalProperties: false },
    async run(args, ctx) {
      const target = str(args, "session_id") ?? ctx.sessionId;
      const res = await ctx.api("GET", `/sessions/${enc(target)}/wakeups`);
      const list = ((res.wakeups ?? []) as JsonObject[]).map(wakeupSummary);
      const pending = list.filter((w) => w.status === "pending").length;
      return reply(`${list.length} wake-up(s), ${pending} pending. Now: ${new Date(ctx.now()).toISOString()}.`, list);
    },
  },
  {
    name: "cancel_wakeup",
    description: "Cancel a scheduled wake-up by id (from schedule_wakeup or list_wakeups). Use when the follow-up is no longer needed: what you were waiting for already happened, or the user changed their mind.",
    inputSchema: {
      type: "object",
      properties: { wakeup_id: { type: "string", description: "Wake-up id (wk-…)." }, ...SESSION_ID_PROP },
      required: ["wakeup_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, "wakeup_id", true)!;
      const target = str(args, "session_id") ?? ctx.sessionId;
      await ctx.api("DELETE", `/sessions/${enc(target)}/wakeups/${enc(id)}`);
      return `Cancelled wake-up ${id}.`;
    },
  },
  {
    name: "create_agent",
    description: [
      "Create a Companion agent: a saved prompt that runs as its OWN new session — on a schedule, when its webhook is called, or on demand with run_agent — and keeps running when this conversation is over.",
      "Use for recurring or independent jobs (a nightly report, a periodic check, work triggered by another system), or when the user asks for an agent, a cron job or an automation. For a follow-up that needs this conversation, use schedule_wakeup instead.",
      "context_mode: \"brief\" (default) — every run starts fresh and sees ONLY the prompt: make it self-contained (goal, paths, commands, what done means) and tell it to write its results to a file path, so they can be read later; \"fork\" — every run starts from a COPY of this session's conversation (this session is never changed).",
      "Defaults: this session's folder (cwd; \"temp\" = a throwaway folder per run), backend and model. Runs are unattended: Claude agents run with full permissions.",
      "Give at most one of at, in_minutes or cron; webhook: true returns the URL to call. Without a schedule or webhook the agent only runs via run_agent or the UI.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short unique name (the id is derived from it)." },
        prompt: { type: "string", description: "What each run must do. {{input}} is replaced by the trigger input (else the input is appended)." },
        description: { type: "string", description: "One line shown in the Agents page." },
        ...SCHEDULE_PROPS,
        webhook: { type: "boolean", description: "Enable a webhook URL that starts a run." },
        cwd: { type: "string", description: "Working folder of the runs. Default: this session's folder." },
        backend: { type: "string", enum: ["claude", "codex"], description: "Default: this session's backend." },
        model: { type: "string", description: "Default: this session's model when the backend is the same." },
        context_mode: { type: "string", enum: ["brief", "fork"], description: "brief (default): fresh session with only the prompt; fork: a copy of this conversation." },
        enabled: { type: "boolean", description: "Default true. A disabled agent keeps its schedule but does not fire." },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const name = str(args, "name", true);
      const prompt = str(args, "prompt", true);
      const self = await ctx.api("GET", `/sessions/${enc(ctx.sessionId)}`) as JsonObject;
      const selfBackend = (self.backendType as string | undefined) ?? "claude";
      const backend = str(args, "backend") ?? selfBackend;
      if (backend !== "claude" && backend !== "codex") throw new ToolError('backend must be "claude" or "codex"');
      const contextMode = str(args, "context_mode") ?? "brief";
      if (contextMode !== "brief" && contextMode !== "fork") throw new ToolError('context_mode must be "brief" or "fork"');
      const sandboxed = selfBackend === "codex" && self.codexSandbox === "workspace-write";
      const { triggers } = buildTriggers(args, ctx.now());
      const body: JsonObject = {
        name,
        prompt,
        description: str(args, "description") ?? "",
        backendType: backend,
        model: str(args, "model") ?? (backend === selfBackend ? (self.model as string | undefined) ?? "" : ""),
        // Codex agents get this session's access: full, unless it is sandboxed.
        permissionMode: backend === "codex" && sandboxed ? "default" : "bypassPermissions",
        cwd: str(args, "cwd") ?? (self.cwd as string | undefined) ?? "temp",
        contextMode,
        ...(contextMode === "fork" ? { sourceSessionId: ctx.sessionId } : {}),
        triggers,
        enabled: bool(args, "enabled") ?? true,
      };
      const agent = await ctx.api("POST", "/agents", body) as JsonObject;
      return describeAgent(agent, ctx, "Created");
    },
  },
  {
    name: "list_agents",
    description: "List Companion agents with their schedule, next run, whether a run is in progress, and who created them. Use to find an agent's id, or before creating one to avoid duplicates.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(_args, ctx) {
      const agents = (await ctx.api("GET", "/agents") as JsonObject[]).map(agentSummary);
      return reply(`${agents.length} agent(s). Now: ${new Date(ctx.now()).toISOString()}.`, agents);
    },
  },
  {
    name: "get_agent",
    description: "Show one agent in full: its prompt, triggers (with the webhook URL when enabled), folder, backend and run counters.",
    inputSchema: { type: "object", properties: { ...AGENT_ID_PROP }, required: ["agent_id"], additionalProperties: false },
    async run(args, ctx) {
      const id = str(args, "agent_id", true)!;
      const agent = await ctx.api("GET", `/agents/${enc(id)}`) as JsonObject;
      const text = await describeAgent(agent, ctx, "Agent");
      return `${text}\n\nPrompt:\n${String(agent.prompt ?? "")}`;
    },
  },
  {
    name: "update_agent",
    description: "Change an agent: name, prompt, schedule (at / in_minutes / cron, or clear_schedule), webhook on/off, folder, model, context mode, enabled. Only the given fields change. Only touch agents the user asked about or that you created for the task at hand. Renaming changes the id (the new one is returned).",
    inputSchema: {
      type: "object",
      properties: {
        ...AGENT_ID_PROP,
        name: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        ...SCHEDULE_PROPS,
        clear_schedule: { type: "boolean", description: "Turn the schedule off." },
        webhook: { type: "boolean", description: "Turn the webhook on or off (the URL stays the same)." },
        cwd: { type: "string" },
        model: { type: "string" },
        context_mode: { type: "string", enum: ["brief", "fork"], description: "fork = runs start from a copy of THIS session's conversation." },
        enabled: { type: "boolean" },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, "agent_id", true)!;
      const existing = await ctx.api("GET", `/agents/${enc(id)}`) as JsonObject;
      const body: JsonObject = {};
      for (const key of ["name", "prompt", "description", "cwd", "model"]) {
        const value = str(args, key);
        if (value !== undefined) body[key] = value;
      }
      const enabled = bool(args, "enabled");
      if (enabled !== undefined) body.enabled = enabled;
      const contextMode = str(args, "context_mode");
      if (contextMode === "fork") Object.assign(body, { contextMode, sourceSessionId: ctx.sessionId });
      else if (contextMode === "brief") body.contextMode = contextMode;
      else if (contextMode !== undefined) throw new ToolError('context_mode must be "brief" or "fork"');
      // Linear settings are never sent back: the server keeps them.
      const { triggers, changed } = buildTriggers(args, ctx.now(), (existing.triggers ?? {}) as JsonObject);
      if (changed) body.triggers = triggers;
      if (Object.keys(body).length === 0) throw new ToolError("Nothing to change: give at least one field");
      const agent = await ctx.api("PUT", `/agents/${enc(id)}`, body) as JsonObject;
      return describeAgent(agent, ctx, "Updated");
    },
  },
  {
    name: "delete_agent",
    description: "Delete an agent and its schedule and webhook (its past runs and their sessions are kept). Only when the user asks, or for an agent you created that is no longer needed.",
    inputSchema: { type: "object", properties: { ...AGENT_ID_PROP }, required: ["agent_id"], additionalProperties: false },
    async run(args, ctx) {
      const id = str(args, "agent_id", true)!;
      await ctx.api("DELETE", `/agents/${enc(id)}`);
      return `Deleted agent ${id}.`;
    },
  },
  {
    name: "run_agent",
    description: "Start a run of an agent now (even if it is disabled). The optional input replaces {{input}} in its prompt, or is appended. Returns at once with the run's session id; follow it with list_agent_runs or get_run_result. Refused while another run of the same agent is in progress.",
    inputSchema: {
      type: "object",
      properties: { ...AGENT_ID_PROP, input: { type: "string", description: "Input for this run." } },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, "agent_id", true)!;
      const input = str(args, "input");
      const res = await ctx.api("POST", `/agents/${enc(id)}/run`, input !== undefined ? { input } : {}) as JsonObject;
      return res.sessionId
        ? `Started a run of agent ${id} in session ${res.sessionId}. Use get_run_result with session_id "${res.sessionId}" once it is done.`
        : `Started a run of agent ${id}. Use list_agent_runs to find its session.`;
    },
  },
  {
    name: "list_agent_runs",
    description: "List recent runs of an agent (most recent first): status (running / success / error), session id, trigger, start and completion time, error. Use to check whether a run finished before reading it with get_run_result.",
    inputSchema: {
      type: "object",
      properties: {
        ...AGENT_ID_PROP,
        status: { type: "string", enum: ["running", "success", "error"] },
        limit: { type: "number", description: "Default 10, at most 50." },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const id = str(args, "agent_id", true)!;
      const status = str(args, "status");
      const limit = Math.min(Math.max(Math.floor(num(args, "limit") ?? 10), 1), 50);
      const query = `agentId=${enc(id)}&limit=${limit}${status ? `&status=${enc(status)}` : ""}`;
      const res = await ctx.api("GET", `/executions?${query}`) as JsonObject;
      const runs = ((res.executions ?? []) as JsonObject[]).map((e) => ({
        sessionId: e.sessionId,
        status: !e.completedAt ? "running" : e.success ? "success" : "error",
        triggerType: e.triggerType,
        startedAt: iso(e.startedAt),
        completedAt: iso(e.completedAt),
        error: e.error,
      }));
      return reply(`${runs.length} of ${res.total ?? runs.length} run(s) of agent ${id}.`, runs);
    },
  },
  {
    name: "get_run_result",
    description: "Read the final answer of an agent run (the result of its turn), truncated to max_chars. Give the run's session id (from run_agent or list_agent_runs). For brief-mode agents that wrote their results to a file, read that file instead.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The run's session id." },
        max_chars: { type: "number", description: "Default 4000, at most 20000." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const sessionId = str(args, "session_id", true)!;
      const maxChars = num(args, "max_chars");
      const query = maxChars !== undefined ? `?maxChars=${Math.floor(maxChars)}` : "";
      const run = await ctx.api("GET", `/executions/${enc(sessionId)}/result${query}`) as JsonObject;
      const head = `Run ${sessionId} of agent ${run.agentId}: ${run.status}${run.completedAt ? `, finished ${iso(run.completedAt)}` : ""}${run.error ? ` — error: ${run.error}` : ""}.`;
      if (run.status === "running") return `${head} No result yet; check again later.`;
      if (typeof run.result !== "string") return `${head} No result text is available.`;
      return `${head}${run.truncated ? " (truncated)" : ""}\n\n${run.result}`;
    },
  },
];

// ── Server ──────────────────────────────────────────────────────────────────

export interface CompanionMcpServer {
  /** Handle one parsed JSON-RPC message (or batch); null when nothing is to be sent. */
  handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
}

export function createCompanionMcp(config: CompanionMcpConfig): CompanionMcpServer {
  const api = createApi(config);
  const now = config.now ?? Date.now;
  const webhookHost = config.webhookHost ?? tailscaleHost;
  const apiBase = new URL(config.apiUrl);
  const ctx: ToolContext = {
    api,
    sessionId: config.sessionId,
    now,
    webhookUrl: async (agentId, secret) => {
      const host = await webhookHost();
      const port = apiBase.port ? `:${apiBase.port}` : "";
      const path = apiBase.pathname.replace(/\/+$/, "");
      return `${apiBase.protocol}//${host}${port}${path}/agents/${enc(agentId)}/webhook/${enc(secret)}`;
    },
  };

  async function handleOne(message: unknown): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return rpcError(null, INVALID_REQUEST, "Invalid request");
    }
    const req = message as JsonRpcRequest;
    const isNotification = req.id === undefined;
    if (typeof req.method !== "string") {
      // A response from the client (we never send requests) or garbage.
      return isNotification ? null : rpcError(req.id ?? null, INVALID_REQUEST, "Invalid request");
    }
    const id = req.id ?? null;
    const params = (req.params ?? {}) as JsonObject;

    switch (req.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "companion", title: "Companion", version: SERVER_VERSION },
            instructions:
              `You run inside Companion session ${config.sessionId}. Use schedule_wakeup to continue this conversation later ` +
              "(at a time, on a schedule, or to follow up on long-running work), and create_agent for jobs that should run " +
              "on their own as separate sessions (scheduled, webhook-triggered or on demand).",
          },
        };
      }
      case "ping":
        return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        };
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as JsonObject;
        try {
          const text = await tool.run(args, ctx);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          if (!(err instanceof ToolError)) console.error(`[companion-mcp] ${tool.name} failed:`, err);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
        }
      }
      default:
        // notifications/initialized, notifications/cancelled, …: nothing to answer.
        return isNotification ? null : rpcError(id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  }

  return {
    async handle(message) {
      if (Array.isArray(message)) {
        if (message.length === 0) return rpcError(null, INVALID_REQUEST, "Empty batch");
        const replies = (await Promise.all(message.map(handleOne))).filter((r): r is JsonRpcResponse => r !== null);
        return replies.length > 0 ? replies : null;
      }
      return handleOne(message);
    },
  };
}

/**
 * Serve MCP over newline-delimited JSON on `input`/`output`. Resolves when
 * the input ends and every request in flight has been answered.
 */
export function serveStdio(
  server: CompanionMcpServer,
  input: NodeJS.ReadableStream,
  output: { write(chunk: string): unknown },
): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const send = (msg: unknown) => output.write(`${JSON.stringify(msg)}\n`);
  return new Promise((resolveDone) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(rpcError(null, PARSE_ERROR, "Parse error"));
        return;
      }
      const job = server.handle(message)
        .then((res) => { if (res) send(res); })
        .catch((err) => { console.error("[companion-mcp] Unexpected error:", err); })
        .finally(() => { inFlight.delete(job); });
      inFlight.add(job);
    });
    lines.on("close", () => {
      void Promise.allSettled([...inFlight]).then(() => resolveDone());
    });
  });
}

/** The server configuration from the environment, or an error message. */
export function configFromEnv(env: Record<string, string | undefined>): CompanionMcpConfig | string {
  const apiUrl = env.COMPANION_API_URL?.trim();
  const token = env.COMPANION_MCP_TOKEN?.trim();
  const sessionId = env.COMPANION_SESSION_ID?.trim();
  if (!apiUrl || !token || !sessionId) {
    return "COMPANION_API_URL, COMPANION_MCP_TOKEN and COMPANION_SESSION_ID must be set (Companion sets them for its sessions).";
  }
  return { apiUrl, token, sessionId };
}

if ((import.meta as { main?: boolean }).main) {
  const config = configFromEnv(process.env);
  if (typeof config === "string") {
    console.error(`[companion-mcp] ${config}`);
    process.exit(1);
  }
  // The CLI closed our stdin: exit once the last answers had time to flush
  // (a pending fetch timeout must not keep an orphan process around).
  void serveStdio(createCompanionMcp(config), process.stdin, process.stdout)
    .then(() => setTimeout(() => process.exit(0), 100));
}
