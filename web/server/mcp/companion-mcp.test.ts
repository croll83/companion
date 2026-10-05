import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createCompanionMcp, configFromEnv, serveStdio, tailscaleHost, type CompanionMcpConfig } from "./companion-mcp.js";

/**
 * The `companion` MCP server in-process: the JSON-RPC/MCP protocol surface
 * and, for every tool, the exact Companion API request it makes and what it
 * tells the model. The API is a fake `fetch`; the real process is covered
 * by companion-mcp.process.test.ts.
 */

const NOW = Date.parse("2026-10-05T10:00:00Z");

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth: string | null;
}

/** A fake Companion API: route handlers by "METHOD /path" (query stripped for matching). */
function fakeApi(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/api/, "") + u.search;
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("Authorization"),
    };
    calls.push(call);
    const handler = routes[`${call.method} ${u.pathname.replace(/^\/api/, "")}`];
    if (!handler) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const res = handler(call);
    return new Response(typeof res.body === "string" ? res.body : JSON.stringify(res.body), { status: res.status ?? 200 });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

const SELF = { sessionId: "sess-me", backendType: "claude", model: "claude-opus-5-5", cwd: "/work/repo" };

function server(routes: Parameters<typeof fakeApi>[0], extra: Partial<CompanionMcpConfig> = {}) {
  const api = fakeApi({ "GET /sessions/sess-me": () => ({ body: SELF }), ...routes });
  const mcp = createCompanionMcp({
    apiUrl: "http://127.0.0.1:3456/api",
    token: "cmcp_sess-me.tok",
    sessionId: "sess-me",
    fetch: api.fetch,
    webhookHost: async () => "100.88.1.2",
    now: () => NOW,
    ...extra,
  });
  return { mcp, calls: api.calls };
}

async function callTool(mcp: ReturnType<typeof createCompanionMcp>, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  const result = (res as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { text: result.content[0].text, isError: result.isError === true };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protocol", () => {
  // initialize echoes a supported protocol version (else offers the latest),
  // declares the tools capability and names the server.
  it("answers initialize, ping and notifications", async () => {
    const { mcp } = server({});
    const init = await mcp.handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } },
    });
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "companion" },
      },
    });
    expect((init as { result: { instructions: string } }).result.instructions).toContain("sess-me");
    expect((init as { result: { instructions: string } }).result.instructions).toMatch(/built-in ScheduleWakeup/);

    const future = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
    expect((future as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");

    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await mcp.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await mcp.handle({ jsonrpc: "2.0", method: "ping" })).toBeNull();
  });

  it("reports unknown methods, invalid requests and unknown tools as JSON-RPC errors", async () => {
    const { mcp } = server({});
    expect(await mcp.handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }))
      .toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found: resources/list" } });
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled" })).toBeNull();
    expect(await mcp.handle("nope")).toMatchObject({ error: { code: -32600 } });
    expect(await mcp.handle({ jsonrpc: "2.0", id: 5 })).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(await mcp.handle({ jsonrpc: "2.0", result: {} })).toBeNull(); // a stray response
    expect(await mcp.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "rm_rf" } }))
      .toMatchObject({ id: 6, error: { code: -32602, message: "Unknown tool: rm_rf" } });
  });

  it("answers batches with an array, skipping notifications", async () => {
    const { mcp } = server({});
    const res = await mcp.handle([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    expect(res).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, result: {} }]);
    expect(await mcp.handle([{ jsonrpc: "2.0", method: "notifications/initialized" }])).toBeNull();
    expect(await mcp.handle([])).toMatchObject({ error: { code: -32600 } });
  });

  // The model decides from names, descriptions and schemas: every tool is
  // listed with an object schema, and the descriptions say WHEN to use them.
  it("lists every tool with a teaching description", async () => {
    const { mcp } = server({});
    const res = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { type: string; required?: string[] } }> };
    };
    const tools = res.result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "schedule_wakeup", "list_wakeups", "cancel_wakeup",
      "create_agent", "list_agents", "get_agent", "update_agent", "delete_agent", "run_agent",
      "list_agent_runs", "get_run_result",
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.schedule_wakeup.description).toMatch(/Use when the user asks for something to happen at a later time or on a schedule/);
    expect(byName.schedule_wakeup.description).toMatch(/while nobody is watching/);
    expect(byName.create_agent.description).toMatch(/brief.*fork/s);
    expect(byName.create_agent.inputSchema.required).toEqual(["name", "prompt"]);
    // Claude Code also has built-in ScheduleWakeup/Cron tools that die with the
    // CLI: the description and the server instructions steer away from them.
    expect(byName.schedule_wakeup.description).toMatch(/over the CLI's own ScheduleWakeup/);
    // No tool can target another session's wake-ups.
    for (const name of ["schedule_wakeup", "list_wakeups", "cancel_wakeup"]) {
      expect(Object.keys((byName[name].inputSchema as unknown as { properties: object }).properties)).not.toContain("session_id");
    }
  });
});

describe("wake-up tools", () => {
  // Default target is this session; the token authenticates every call.
  it("schedule_wakeup posts to this session with at / cron / in_minutes", async () => {
    const wakeup = { id: "wk-1", status: "pending", schedule: { at: "2026-10-05T12:00:00Z" }, nextRunAt: Date.parse("2026-10-05T12:00:00Z"), createdBy: "session:sess-me", message: "check CI" };
    const { mcp, calls } = server({ "POST /sessions/sess-me/wakeups": () => ({ status: 201, body: { wakeup } }) });

    const at = await callTool(mcp, "schedule_wakeup", { message: "check CI", at: "2026-10-05T12:00:00Z" });
    expect(at.isError).toBe(false);
    expect(at.text).toMatch(/Scheduled wake-up wk-1 for this session at 2026-10-05T12:00:00.000Z/);
    expect(calls[0]).toEqual({ method: "POST", path: "/sessions/sess-me/wakeups", body: { message: "check CI", at: "2026-10-05T12:00:00Z" }, auth: "Bearer cmcp_sess-me.tok" });

    await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: 30 });
    expect(calls[1].body).toEqual({ message: "m", at: "2026-10-05T10:30:00.000Z" });

    const cron = await callTool(mcp, "schedule_wakeup", { message: "m", cron: "0 9 * * 1-5" });
    expect(calls[2].body).toEqual({ message: "m", cron: "0 9 * * 1-5" });
    expect(cron.text).toMatch(/on cron "0 9 \* \* 1-5"/);
  });

  // The wake-up tools act on THIS session only (review finding: a session
  // could inject messages into, list or cancel other sessions' wake-ups).
  // A session_id is refused instead of silently ignored, and nothing is sent.
  it("schedule_wakeup acts on this session only and validates its arguments", async () => {
    const { mcp, calls } = server({
      "POST /sessions/sess-me/wakeups": () => ({ status: 201, body: { wakeup: { id: "wk-2", nextRunAt: NOW + 60_000 } } }),
    });
    const other = await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: 1, session_id: "other" });
    expect(other).toEqual({ text: "Unknown argument(s) for schedule_wakeup: session_id", isError: true });
    expect((await callTool(mcp, "list_wakeups", { session_id: "other" })).isError).toBe(true);
    expect((await callTool(mcp, "cancel_wakeup", { wakeup_id: "wk-1", session_id: "other" })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    const own = await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: 1 });
    expect(own.text).toMatch(/for this session/);
    expect(calls[0].path).toBe("/sessions/sess-me/wakeups");

    expect(await callTool(mcp, "schedule_wakeup", { message: "m" })).toEqual({ text: "Give one of at, in_minutes or cron", isError: true });
    expect((await callTool(mcp, "schedule_wakeup", { at: "x" })).text).toBe('"message" is required');
    expect((await callTool(mcp, "schedule_wakeup", { message: "m", at: "x", cron: "y" })).text).toMatch(/only one of/);
    expect((await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: 0 })).text).toMatch(/at least 1/);
    expect((await callTool(mcp, "schedule_wakeup", { message: 5, at: "x" })).text).toMatch(/must be a string/);
    expect((await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: "5" })).text).toMatch(/must be a number/);
    expect(calls).toHaveLength(1);
  });

  // API refusals (caps, past dates, permissions) reach the model verbatim.
  it("returns API errors as tool errors", async () => {
    const { mcp } = server({
      "POST /sessions/sess-me/wakeups": () => ({ status: 409, body: { error: "Sessions already have 50 pending wake-ups" } }),
    });
    const res = await callTool(mcp, "schedule_wakeup", { message: "m", in_minutes: 5 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/failed \(409\): Sessions already have 50 pending wake-ups/);
  });

  it("list_wakeups and cancel_wakeup", async () => {
    const { mcp, calls } = server({
      "GET /sessions/sess-me/wakeups": () => ({ body: { wakeups: [
        { id: "wk-1", status: "pending", schedule: { cron: "0 9 * * *" }, nextRunAt: NOW + 1000, message: "a" },
        { id: "wk-0", status: "missed", schedule: { at: "x" }, lastResult: "server was down", message: "b" },
      ] } }),
      "DELETE /sessions/sess-me/wakeups/wk-1": () => ({ body: { ok: true } }),
    });
    const list = await callTool(mcp, "list_wakeups");
    expect(list.text).toMatch(/^2 wake-up\(s\), 1 pending/);
    expect(list.text).toContain('"lastResult": "server was down"');
    expect(await callTool(mcp, "cancel_wakeup", { wakeup_id: "wk-1" })).toEqual({ text: "Cancelled wake-up wk-1.", isError: false });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /sessions/sess-me/wakeups", "DELETE /sessions/sess-me/wakeups/wk-1"]);
  });
});

describe("agent tools", () => {
  const created = (body: Record<string, unknown>) => ({
    id: "nightly",
    enabled: true,
    totalRuns: 0,
    ...body,
    triggers: {
      ...(body.triggers as object),
      ...((body.triggers as { webhook?: object })?.webhook ? { webhook: { enabled: true, secret: "s3cr3t" } } : {}),
    },
  });

  // Defaults come from this session (backend, model, folder); fork mode
  // copies THIS session; the webhook URL uses the Tailscale IP.
  it("create_agent maps defaults, schedule, webhook and context mode", async () => {
    const { mcp, calls } = server({ "POST /agents": (call) => ({ status: 201, body: created(call.body as Record<string, unknown>) }) });
    const res = await callTool(mcp, "create_agent", { name: "Nightly", prompt: "Summarize", cron: "0 2 * * *", webhook: true });
    expect(res.isError).toBe(false);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/sessions/sess-me" });
    expect(calls[1].body).toEqual({
      name: "Nightly",
      prompt: "Summarize",
      description: "",
      backendType: "claude",
      model: "claude-opus-5-5",
      permissionMode: "bypassPermissions",
      cwd: "/work/repo",
      contextMode: "brief",
      triggers: { schedule: { enabled: true, expression: "0 2 * * *", recurring: true }, webhook: { enabled: true, secret: "" } },
      enabled: true,
    });
    expect(res.text).toContain("Created agent \"Nightly\" (id: nightly).");
    expect(res.text).toContain("POST http://100.88.1.2:3456/api/agents/nightly/webhook/s3cr3t");
    expect(res.text).toMatch(/reachable only from this machine and the tailnet/);

    await callTool(mcp, "create_agent", { name: "F", prompt: "p", context_mode: "fork", in_minutes: 10, enabled: false, cwd: "temp" });
    expect(calls[3].body).toMatchObject({
      contextMode: "fork",
      sourceSessionId: "sess-me",
      cwd: "temp",
      enabled: false,
      triggers: { schedule: { enabled: true, expression: "2026-10-05T10:10:00.000Z", recurring: false } },
    });
  });

  // Another backend does not inherit this session's model; a sandboxed Codex
  // session creates sandboxed Codex agents.
  it("create_agent adapts model and permissions to the backend", async () => {
    const { mcp, calls } = server({
      "GET /sessions/sess-me": () => ({ body: { ...SELF, backendType: "codex", model: "gpt-5.5", codexSandbox: "workspace-write" } }),
      "POST /agents": (call) => ({ status: 201, body: created(call.body as Record<string, unknown>) }),
    });
    await callTool(mcp, "create_agent", { name: "A", prompt: "p" });
    expect(calls[1].body).toMatchObject({ backendType: "codex", model: "gpt-5.5", permissionMode: "default", triggers: {} });
    await callTool(mcp, "create_agent", { name: "B", prompt: "p", backend: "claude" });
    expect(calls[3].body).toMatchObject({ backendType: "claude", model: "", permissionMode: "bypassPermissions" });

    expect((await callTool(mcp, "create_agent", { name: "C", prompt: "p", backend: "gemini" })).text).toMatch(/backend must be/);
    expect((await callTool(mcp, "create_agent", { name: "C", prompt: "p", context_mode: "x" })).text).toMatch(/context_mode must be/);
    expect((await callTool(mcp, "create_agent", { name: "C" })).text).toBe('"prompt" is required');
  });

  // The webhook host falls back to localhost when there is no tailnet IP.
  it("falls back to localhost for the webhook URL", async () => {
    const { mcp } = server(
      { "GET /agents/a": () => ({ body: { id: "a", name: "A", prompt: "do it", triggers: { webhook: { enabled: true, secret: "k" } } } }) },
      { webhookHost: async () => "localhost" },
    );
    const res = await callTool(mcp, "get_agent", { agent_id: "a" });
    // The headline reads "Agent "A"", not "Agent agent "A"" (review finding).
    expect(res.text).toMatch(/^Agent "A" \(id: a\)\./);
    expect(res.text).toContain("POST http://localhost:3456/api/agents/a/webhook/k");
    expect(res.text).toMatch(/Prompt:\ndo it$/);
  });

  it("list_agents summarizes without prompts or secrets", async () => {
    const { mcp, calls } = server({
      "GET /agents": () => ({ body: [{
        id: "a", name: "A", enabled: true, backendType: "codex", model: "", cwd: "/w", prompt: "SECRET PROMPT",
        triggers: { schedule: { enabled: true, expression: "0 9 * * *", recurring: true }, webhook: { enabled: true, secret: "hidden" } },
        nextRunAt: NOW + 3600_000, running: true, createdBy: "session:x", scheduleError: "boom",
      }] }),
    });
    const res = await callTool(mcp, "list_agents");
    expect(calls[0].path).toBe("/agents");
    expect(res.text).toMatch(/^1 agent\(s\)/);
    expect(res.text).toContain('"model": "(default)"');
    expect(res.text).toContain('"nextRunAt": "2026-10-05T11:00:00.000Z"');
    expect(res.text).toContain('"createdBy": "session:x"');
    expect(res.text).not.toContain("SECRET PROMPT");
    expect(res.text).not.toContain("hidden");
  });

  // Only the given fields are sent; triggers only when a trigger changed,
  // built on the saved ones (webhook secret kept, Linear never sent back).
  it("update_agent sends only what changes", async () => {
    const existing = {
      id: "a", name: "A",
      triggers: {
        schedule: { enabled: true, expression: "0 9 * * *", recurring: true },
        webhook: { enabled: true, secret: "keep" },
        linear: { enabled: true, hasAccessToken: true },
      },
    };
    const { mcp, calls } = server({
      "GET /agents/a": () => ({ body: existing }),
      "PUT /agents/a": (call) => ({ body: { ...existing, ...(call.body as object) } }),
    });
    await callTool(mcp, "update_agent", { agent_id: "a", prompt: "new", enabled: false, model: "m", context_mode: "fork" });
    expect(calls[1]).toMatchObject({ method: "PUT", path: "/agents/a", body: { prompt: "new", enabled: false, model: "m", contextMode: "fork", sourceSessionId: "sess-me" } });
    expect(calls[1].body).not.toHaveProperty("triggers");

    await callTool(mcp, "update_agent", { agent_id: "a", clear_schedule: true, webhook: false });
    expect((calls[3].body as { triggers: unknown }).triggers).toEqual({
      schedule: { enabled: false, expression: "0 9 * * *", recurring: true },
      webhook: { enabled: false, secret: "keep" },
    });

    await callTool(mcp, "update_agent", { agent_id: "a", at: "2026-10-06T08:00:00+02:00", context_mode: "brief" });
    expect(calls[5].body).toEqual({
      contextMode: "brief",
      triggers: {
        schedule: { enabled: true, expression: "2026-10-06T08:00:00+02:00", recurring: false },
        webhook: { enabled: true, secret: "keep" },
      },
    });

    expect((await callTool(mcp, "update_agent", { agent_id: "a" })).text).toMatch(/Nothing to change/);
    expect((await callTool(mcp, "update_agent", { agent_id: "a", context_mode: "x" })).text).toMatch(/context_mode must be/);
    expect((await callTool(mcp, "update_agent", { agent_id: "a", enabled: "yes" })).text).toMatch(/true or false/);
  });

  it("delete_agent and run_agent", async () => {
    const { mcp, calls } = server({
      "DELETE /agents/a": () => ({ body: { ok: true } }),
      "POST /agents/a/run": (call) => ({ body: (call.body as { input?: string }).input ? { ok: true, sessionId: "run-1" } : { ok: true } }),
    });
    expect((await callTool(mcp, "delete_agent", { agent_id: "a" })).text).toBe("Deleted agent a.");
    const withInput = await callTool(mcp, "run_agent", { agent_id: "a", input: "payload" });
    expect(withInput.text).toMatch(/in session run-1/);
    expect(calls[1].body).toEqual({ input: "payload" });
    const noSession = await callTool(mcp, "run_agent", { agent_id: "a" });
    expect(calls[2].body).toEqual({});
    expect(noSession.text).toMatch(/Use list_agent_runs/);
  });

  it("list_agent_runs maps status and clamps the limit", async () => {
    const { mcp, calls } = server({
      "GET /executions": () => ({ body: { total: 3, executions: [
        { sessionId: "r1", startedAt: NOW, triggerType: "manual" },
        { sessionId: "r2", startedAt: NOW, completedAt: NOW + 5000, success: true, triggerType: "schedule" },
        { sessionId: "r3", startedAt: NOW, completedAt: NOW + 5000, success: false, error: "boom", triggerType: "webhook" },
      ] } }),
    });
    const res = await callTool(mcp, "list_agent_runs", { agent_id: "a b", limit: 500, status: "error" });
    expect(calls[0].path).toBe("/executions?agentId=a%20b&limit=50&status=error");
    expect(res.text).toMatch(/^3 of 3 run\(s\)/);
    expect(res.text).toMatch(/"status": "running"[\s\S]*"status": "success"[\s\S]*"status": "error"/);
    await callTool(mcp, "list_agent_runs", { agent_id: "a" });
    expect(calls[1].path).toBe("/executions?agentId=a&limit=10");
  });

  it("get_run_result reports running, missing and truncated results", async () => {
    const results: Record<string, unknown> = {
      r1: { agentId: "a", status: "running", result: null },
      r2: { agentId: "a", status: "success", completedAt: NOW, result: "All green", truncated: false },
      r3: { agentId: "a", status: "error", completedAt: NOW, error: "max turns", result: "partial…", truncated: true },
      r4: { agentId: "a", status: "success", completedAt: NOW, result: null },
    };
    const { mcp, calls } = server({
      "GET /executions/r1/result": () => ({ body: results.r1 }),
      "GET /executions/r2/result": () => ({ body: results.r2 }),
      "GET /executions/r3/result": () => ({ body: results.r3 }),
      "GET /executions/r4/result": () => ({ body: results.r4 }),
    });
    expect((await callTool(mcp, "get_run_result", { session_id: "r1" })).text).toMatch(/running\. No result yet/);
    expect((await callTool(mcp, "get_run_result", { session_id: "r2", max_chars: 100.7 })).text)
      .toBe("Run r2 of agent a: success, finished 2026-10-05T10:00:00.000Z.\n\nAll green");
    expect(calls[1].path).toBe("/executions/r2/result?maxChars=100");
    expect((await callTool(mcp, "get_run_result", { session_id: "r3" })).text).toMatch(/error: max turns\. \(truncated\)\n\npartial…/);
    expect((await callTool(mcp, "get_run_result", { session_id: "r4" })).text).toMatch(/No result text is available/);
  });
});

describe("API client", () => {
  // Companion down: a clear tool error rather than a protocol failure.
  it("reports an unreachable Companion and non-JSON errors", async () => {
    const down = createCompanionMcp({
      apiUrl: "http://127.0.0.1:1/api/",
      token: "t",
      sessionId: "s",
      fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const res = await callTool(down, "list_agents");
    expect(res).toEqual({ text: "Companion is not reachable at http://127.0.0.1:1/api: ECONNREFUSED", isError: true });

    const plain = createCompanionMcp({
      apiUrl: "http://127.0.0.1:2/api",
      token: "t",
      sessionId: "s",
      fetch: (async () => new Response("Bad Gateway", { status: 502 })) as unknown as typeof fetch,
    });
    expect((await callTool(plain, "list_agents")).text).toBe("Companion API GET /agents failed (502): HTTP 502");
  });

  // A bug in a tool is still answered (isError), and logged to stderr only.
  it("turns unexpected failures into tool errors", async () => {
    const { mcp } = server({ "GET /agents": () => ({ body: "not-an-array" }) });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callTool(mcp, "list_agents");
    expect(res.isError).toBe(true);
    expect(errors).toHaveBeenCalled();
  });
});

describe("stdio transport", () => {
  // Newline-delimited JSON in, one JSON line per response out; parse errors
  // are answered; the promise resolves after the input ends and answers flush.
  it("serves newline-delimited JSON-RPC", async () => {
    const { mcp } = server({});
    const input = new PassThrough();
    const out: string[] = [];
    const done = serveStdio(mcp, input, { write: (chunk: string) => out.push(chunk) });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write("\n");
    input.write("{not json}\n");
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await done;
    const replies = out.map((line) => JSON.parse(line));
    expect(out.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(replies).toHaveLength(3);
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    expect(replies.find((r) => r.id === 2).result.tools).toHaveLength(11);
  });
});

describe("configuration", () => {
  it("reads its configuration from the environment", () => {
    expect(configFromEnv({ COMPANION_API_URL: "http://x/api", COMPANION_MCP_TOKEN: "t", COMPANION_SESSION_ID: "s" }))
      .toEqual({ apiUrl: "http://x/api", token: "t", sessionId: "s" });
    expect(configFromEnv({ COMPANION_API_URL: "http://x/api" })).toMatch(/must be set/);
  });

  // `tailscale ip -4` is optional: without it (or without an IPv4) the host is localhost.
  it("resolves the webhook host to an IPv4 or localhost", async () => {
    const host = await tailscaleHost();
    expect(host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)).toBe(true);
  });
});
