import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The agent API as a session's `companion` MCP server sees it (requests with
 * an MCP token), over the real agent store in a temp COMPANION_HOME:
 * createdBy comes from the token, sessions together may create at most
 * MAX_AGENTS_BY_SESSIONS agents, and a sandboxed session cannot create,
 * change, run or delete an agent that runs with full access.
 */

const h = vi.hoisted(() => ({ home: `${process.env.TMPDIR || "/tmp"}/agent-routes-mcp-${process.pid}-${Date.now()}` }));
vi.mock("../paths.js", () => ({ COMPANION_HOME: h.home, legacyStatePath: () => null }));
vi.mock("../settings-manager.js", () => ({ getSettings: () => ({ timeZone: "UTC" }), updateSettings: vi.fn() }));
vi.mock("../linear-staging.js", () => ({ consumeSlot: vi.fn(() => null) }));
vi.mock("../linear-oauth-connections.js", () => ({ getOAuthConnection: vi.fn(() => null), createOAuthConnection: vi.fn() }));

import { Hono } from "hono";
import * as agentStore from "../agent-store.js";
import { _setMcpSecretFileForTest, mcpTokenFor } from "../companion-mcp-auth.js";
import { MAX_AGENTS_BY_SESSIONS, registerAgentRoutes } from "./agent-routes.js";

const SESSIONS: Record<string, { backendType: string; codexSandbox?: string; cwd?: string; codexInternetAccess?: boolean }> = {
  claude: { backendType: "claude", cwd: "/w" },
  claude2: { backendType: "claude", cwd: "/w" },
  codexFull: { backendType: "codex", codexSandbox: "danger-full-access", cwd: "/w" },
  codexSandboxed: { backendType: "codex", codexSandbox: "workspace-write", cwd: "/w", codexInternetAccess: false },
};

function mockExecutor() {
  return {
    getNextRunTime: vi.fn(() => null),
    scheduleAgent: vi.fn(),
    stopAgent: vi.fn(),
    executeAgentManually: vi.fn(() => ({ ok: true as const })),
    isRunInProgress: vi.fn(() => false),
    runSessionOf: vi.fn((): string | undefined => "run-session-1"),
    getScheduleIssue: vi.fn(() => null),
    forkSourceError: vi.fn(() => null),
    getRunResult: vi.fn((): unknown => null),
    listAllExecutions: vi.fn(() => ({ executions: [], total: 0 })),
  };
}

let app: Hono;
let executor: ReturnType<typeof mockExecutor>;

beforeEach(() => {
  mkdirSync(h.home, { recursive: true });
  _setMcpSecretFileForTest(join(h.home, "mcp-token.key"));
  executor = mockExecutor();
  const api = new Hono();
  registerAgentRoutes(api, executor as never, (id) => SESSIONS[id]);
  app = new Hono();
  app.route("/api", api);
});

afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
});

function req(method: string, path: string, body?: unknown, caller?: string) {
  return app.request(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(caller ? { Authorization: `Bearer ${mcpTokenFor(caller)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const claudeAgent = (name: string) => ({ name, prompt: "do it", backendType: "claude", cwd: "/w" });
const codexAgent = (name: string, permissionMode = "default") => ({ name, prompt: "do it", backendType: "codex", cwd: "/w", permissionMode });

describe("agents created by sessions", () => {
  // createdBy is taken from the token; a body value is ignored, so neither a
  // user request nor a session can claim another origin.
  it("records the calling session from its MCP token, never from the body", async () => {
    const bySession = await req("POST", "/agents", { ...claudeAgent("From Session"), createdBy: "user" }, "claude");
    expect(bySession.status).toBe(201);
    expect((await bySession.json()).createdBy).toBe("session:claude");

    const byUser = await req("POST", "/agents", { ...claudeAgent("From User"), createdBy: "session:fake" });
    expect(byUser.status).toBe(201);
    expect((await byUser.json()).createdBy).toBeUndefined();

    // Export never carries it (an imported agent is the importer's).
    const exported = await (await req("GET", "/agents/from-session/export")).json();
    expect(exported).not.toHaveProperty("createdBy");
    // Editing does not change it.
    await req("PUT", "/agents/from-session", { prompt: "changed", createdBy: "user" }, "claude");
    expect(agentStore.getAgent("from-session")?.createdBy).toBe("session:claude");
  });

  // At most MAX_AGENTS_BY_SESSIONS agents created by sessions in total; user
  // agents do not count and the user can always create more.
  it("caps the agents sessions may create", async () => {
    await req("POST", "/agents", claudeAgent("User Agent"));
    for (let i = 0; i < MAX_AGENTS_BY_SESSIONS; i++) {
      const res = await req("POST", "/agents", claudeAgent(`Session Agent ${i}`), i % 2 ? "claude" : "codexFull");
      expect(res.status).toBe(201);
    }
    const over = await req("POST", "/agents", claudeAgent("One Too Many"), "claude");
    expect(over.status).toBe(409);
    expect((await over.json()).error).toMatch(/already created 20 agents/);
    expect((await req("POST", "/agents", claudeAgent("Still Fine For User"))).status).toBe(201);

    // Deleting one frees a slot (session-agent-0 was created by codexFull).
    expect((await req("DELETE", "/agents/session-agent-0", undefined, "codexFull")).status).toBe(200);
    expect((await req("POST", "/agents", claudeAgent("Now It Fits"), "claude")).status).toBe(201);
  });
});

describe("sandboxed sessions", () => {
  // A workspace-write Codex session must not escape its sandbox through an
  // agent: no Claude agent (always full access), no full-access Codex agent.
  it("may only create agents in its own sandbox", async () => {
    const claude = await req("POST", "/agents", claudeAgent("Escape"), "codexSandboxed");
    expect(claude.status).toBe(403);
    expect((await claude.json()).error).toMatch(/runs sandboxed/);
    expect((await req("POST", "/agents", codexAgent("Escape Too", "bypassPermissions"), "codexSandboxed")).status).toBe(403);
    expect((await req("POST", "/agents", codexAgent("Sandboxed Ok"), "codexSandboxed")).status).toBe(201);
    expect(agentStore.listAgents().map((a) => a.id)).toEqual(["sandboxed-ok"]);
  });

  it("may not change, run or delete full-access agents", async () => {
    await req("POST", "/agents", claudeAgent("Full"));
    await req("POST", "/agents", codexAgent("Boxed"), "codexSandboxed");

    expect((await req("PUT", "/agents/full", { prompt: "rm -rf /" }, "codexSandboxed")).status).toBe(403);
    expect((await req("POST", "/agents/full/run", { input: "x" }, "codexSandboxed")).status).toBe(403);
    expect((await req("DELETE", "/agents/full", undefined, "codexSandboxed")).status).toBe(403);
    expect(executor.executeAgentManually).not.toHaveBeenCalled();
    expect(agentStore.getAgent("full")?.prompt).toBe("do it");

    // Raising its own agent to full access is the same escape.
    expect((await req("PUT", "/agents/boxed", { permissionMode: "bypassPermissions" }, "codexSandboxed")).status).toBe(403);
    expect((await req("PUT", "/agents/boxed", { prompt: "fine" }, "codexSandboxed")).status).toBe(200);
    expect((await req("POST", "/agents/boxed/run", {}, "codexSandboxed")).status).toBe(200);
    expect((await req("DELETE", "/agents/boxed", undefined, "codexSandboxed")).status).toBe(200);

    // The user is not restricted.
    expect((await req("PUT", "/agents/full", { prompt: "ok" })).status).toBe(200);
    expect((await req("POST", "/agents/full/run", {})).status).toBe(200);
  });

  // Review finding: "sandboxed" agents could be pointed anywhere and given
  // network, MCP servers or env (NODE_OPTIONS...) by a sandboxed session.
  // Their folder must be inside the caller's (or a fresh "temp" one), and
  // they get the caller's network access whatever the request says.
  it("keeps its agents inside its folder and its network access", async () => {
    const outside = await req("POST", "/agents", { ...codexAgent("Outside"), cwd: "/" }, "codexSandboxed");
    expect(outside.status).toBe(403);
    expect((await outside.json()).error).toMatch(/inside its folder \/w/);
    expect((await req("POST", "/agents", { ...codexAgent("Sibling"), cwd: "/wx" }, "codexSandboxed")).status).toBe(403);
    expect((await req("POST", "/agents", { ...codexAgent("Temp"), cwd: "temp" }, "codexSandboxed")).status).toBe(201);
    const inside = await req("POST", "/agents", { ...codexAgent("Inside"), cwd: "/w/sub", codexInternetAccess: true }, "codexSandboxed");
    expect(inside.status).toBe(201);
    expect(agentStore.getAgent("inside")?.codexInternetAccess).toBe(false);

    expect((await req("PUT", "/agents/inside", { cwd: "/etc" }, "codexSandboxed")).status).toBe(403);
    expect((await req("PUT", "/agents/inside", { codexInternetAccess: true }, "codexSandboxed")).status).toBe(200);
    expect(agentStore.getAgent("inside")?.codexInternetAccess).toBe(false);
  });
});

// Review finding: MCP tokens were not limited to their own agents, so a
// (prompt-injected) session could rewrite, delete or run the user's
// full-permission agents, and read every agent's webhook secret.
describe("agents of other creators", () => {
  it("may only be changed, run or deleted by the session that created them", async () => {
    await req("POST", "/agents", claudeAgent("User Agent"));
    await req("POST", "/agents", claudeAgent("Mine"), "claude");

    for (const caller of ["claude", "claude2"]) {
      const put = await req("PUT", "/agents/user-agent", { prompt: "exfiltrate" }, caller);
      expect(put.status).toBe(403);
      expect((await put.json()).error).toMatch(/only change agents this session created/);
      expect((await req("POST", "/agents/user-agent/run", { input: "x" }, caller)).status).toBe(403);
      expect((await req("DELETE", "/agents/user-agent", undefined, caller)).status).toBe(403);
    }
    expect(agentStore.getAgent("user-agent")?.prompt).toBe("do it");
    expect(executor.executeAgentManually).not.toHaveBeenCalled();

    // Another session's agent is just as off limits.
    expect((await req("PUT", "/agents/mine", { prompt: "x" }, "claude2")).status).toBe(403);
    expect((await req("PUT", "/agents/mine", { prompt: "mine" }, "claude")).status).toBe(200);
    expect((await req("POST", "/agents/mine/run", {}, "claude")).status).toBe(200);
    expect((await req("DELETE", "/agents/mine", undefined, "claude")).status).toBe(200);
  });

  it("hides webhook secrets of agents the calling session did not create", async () => {
    const hook = { triggers: { webhook: { enabled: true, secret: "" } } };
    await req("POST", "/agents", { ...claudeAgent("User Hook"), ...hook });
    await req("POST", "/agents", { ...claudeAgent("Own Hook"), ...hook }, "claude");
    const userSecret = agentStore.getAgent("user-hook")?.triggers?.webhook?.secret;
    const ownSecret = agentStore.getAgent("own-hook")?.triggers?.webhook?.secret;
    expect(userSecret).toBeTruthy();

    const list = await (await req("GET", "/agents", undefined, "claude")).json() as Array<{ id: string; triggers: { webhook: { enabled: boolean; secret?: string } } }>;
    const byId = Object.fromEntries(list.map((a) => [a.id, a]));
    expect(byId["user-hook"].triggers.webhook).toEqual({ enabled: true });
    expect(byId["own-hook"].triggers.webhook.secret).toBe(ownSecret);
    const one = await (await req("GET", "/agents/user-hook", undefined, "claude")).json();
    expect(one.triggers.webhook.secret).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(userSecret);

    // The user (no MCP token) still sees it.
    expect((await (await req("GET", "/agents/user-hook")).json()).triggers.webhook.secret).toBe(userSecret);
  });

  // env, envSlug and mcpServers change what runs outside any sandbox (MCP
  // servers, NODE_OPTIONS...): never settable through an MCP token.
  it("refuses env, envSlug and mcpServers from MCP tokens", async () => {
    for (const extra of [{ env: { NODE_OPTIONS: "--require /tmp/x.js" } }, { envSlug: "prod" }, { mcpServers: { x: { type: "stdio", command: "sh" } } }]) {
      const res = await req("POST", "/agents", { ...claudeAgent(`Extra ${Object.keys(extra)[0]}`), ...extra }, "claude");
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/cannot set "(env|envSlug|mcpServers)"/);
    }
    await req("POST", "/agents", claudeAgent("Own"), "claude");
    expect((await req("PUT", "/agents/own", { env: { A: "1" } }, "claude")).status).toBe(403);
    // The user can.
    expect((await req("POST", "/agents", { ...claudeAgent("User Env"), env: { A: "1" } })).status).toBe(201);
  });

  // Review finding: within the caps, per-minute schedules from sessions
  // could start a CLI per agent every minute. Sessions get a 15-minute floor.
  it("refuses repeating schedules under 15 minutes from sessions", async () => {
    const every = (expression: string) => ({ triggers: { schedule: { enabled: true, expression, recurring: true } } });
    const tight = await req("POST", "/agents", { ...claudeAgent("Tight"), ...every("*/5 * * * *") }, "claude");
    expect(tight.status).toBe(403);
    expect((await tight.json()).error).toMatch(/at least 15 minutes apart/);
    expect((await req("POST", "/agents", { ...claudeAgent("Burst"), ...every("0,1 9 * * *") }, "claude")).status).toBe(403);
    expect((await req("POST", "/agents", { ...claudeAgent("Quarter"), ...every("*/15 * * * *") }, "claude")).status).toBe(201);
    expect((await req("PUT", "/agents/quarter", every("* * * * *"), "claude")).status).toBe(403);
    // One-time runs and the user are not limited.
    expect((await req("POST", "/agents", { ...claudeAgent("User Tight"), ...every("* * * * *") })).status).toBe(201);
  });
});

describe("runs", () => {
  // The run's session id is returned so the caller can follow the run.
  it("returns the session of the started run", async () => {
    await req("POST", "/agents", claudeAgent("Runner"), "claude");
    const res = await req("POST", "/agents/runner/run", { input: "go" }, "claude");
    expect(await res.json()).toEqual({ ok: true, message: "Agent triggered", sessionId: "run-session-1" });
    executor.runSessionOf.mockReturnValue(undefined);
    expect(await (await req("POST", "/agents/runner/run", {})).json()).toEqual({ ok: true, message: "Agent triggered" });
  });

  it("serves a run's result with a bounded size", async () => {
    expect((await req("GET", "/executions/nope/result")).status).toBe(404);
    executor.getRunResult.mockReturnValue({ sessionId: "r1", status: "success", result: "done", truncated: false });
    const res = await req("GET", "/executions/r1/result?maxChars=50", undefined, "claude");
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("done");
    expect(executor.getRunResult).toHaveBeenLastCalledWith("r1", 50);
    await req("GET", "/executions/r1/result?maxChars=999999");
    expect(executor.getRunResult).toHaveBeenLastCalledWith("r1", 20_000);
    await req("GET", "/executions/r1/result?maxChars=abc");
    expect(executor.getRunResult).toHaveBeenLastCalledWith("r1", 4000);
  });
});

describe("PUT triggers", () => {
  // The MCP tools send triggers without the Linear part (they only ever see
  // it sanitized); the saved Linear trigger must survive. A webhook turned
  // on without a secret gets one.
  it("keeps a saved Linear trigger the request does not mention and fills a webhook secret", async () => {
    agentStore.createAgent({
      version: 1, name: "Linear Agent", description: "", backendType: "claude", model: "", permissionMode: "bypassPermissions",
      cwd: "/w", prompt: "p", enabled: true, createdBy: "session:claude",
      triggers: { linear: { enabled: true, oauthConnectionId: "conn-1" } },
    });
    const res = await req("PUT", "/agents/linear-agent", { triggers: { webhook: { enabled: true, secret: "" } } }, "claude");
    expect(res.status).toBe(200);
    const saved = agentStore.getAgent("linear-agent")!;
    expect(saved.triggers?.linear).toEqual({ enabled: true, oauthConnectionId: "conn-1" });
    expect(saved.triggers?.webhook?.secret).toMatch(/^[0-9a-f]{48}$/);

    // An explicit Linear value (the UI editor) still replaces it.
    await req("PUT", "/agents/linear-agent", { triggers: { linear: { enabled: false } } });
    expect(agentStore.getAgent("linear-agent")?.triggers?.linear).toEqual({ enabled: false });
  });
});
