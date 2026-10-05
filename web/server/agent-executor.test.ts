import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentConfig, AgentExecution } from "./agent-types.js";
import type { SdkSessionInfo } from "./cli-launcher.js";
import type { BrowserIncomingMessage, CLIResultMessage } from "./session-types.js";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────
// These must be hoisted so vi.mock() factory functions can reference them.

// We need a mock that works with `new Cron(...)`. Vitest requires a real
// class/function for `new` calls. We track all constructor calls and
// instances so tests can inspect them.
const mockCronState = vi.hoisted(() => ({
  constructorCalls: [] as Array<{ args: unknown[] }>,
  instances: [] as Array<{ stop: ReturnType<typeof vi.fn>; nextRun: ReturnType<typeof vi.fn> }>,
}));

const MockCronClass = vi.hoisted(() => {
  return class MockCron {
    stop = vi.fn();
    nextRun = vi.fn();
    constructor(...args: unknown[]) {
      mockCronState.constructorCalls.push({ args });
      mockCronState.instances.push(this);
    }
  };
});

const mockAgentStore = vi.hoisted(() => ({
  listAgents: vi.fn<() => AgentConfig[]>().mockReturnValue([]),
  getAgent: vi.fn<(id: string) => AgentConfig | null>().mockReturnValue(null),
  updateAgent: vi.fn<(id: string, updates: Partial<AgentConfig>) => AgentConfig | null>().mockReturnValue(null),
}));

const mockEnvManager = vi.hoisted(() => ({
  getEnv: vi.fn().mockReturnValue(null),
}));

const mockSessionNames = vi.hoisted(() => ({
  setName: vi.fn(),
}));

const mockExecutionStoreInstance = vi.hoisted(() => ({
  append: vi.fn(),
  update: vi.fn(),
  list: vi.fn().mockReturnValue({ executions: [], total: 0 }),
  finalizeInterrupted: vi.fn().mockReturnValue(0),
  all: vi.fn().mockReturnValue([]),
}));

// Use a proper class so `new ExecutionStore()` works correctly.
const MockExecutionStoreClass = vi.hoisted(() => {
  return class MockExecutionStore {
    append = mockExecutionStoreInstance.append;
    update = mockExecutionStoreInstance.update;
    list = mockExecutionStoreInstance.list;
    finalizeInterrupted = mockExecutionStoreInstance.finalizeInterrupted;
    all = mockExecutionStoreInstance.all;
  };
});

// ─── vi.mock() calls ────────────────────────────────────────────────────────

vi.mock("croner", () => ({
  Cron: MockCronClass,
}));

vi.mock("./agent-store.js", () => mockAgentStore);

vi.mock("./env-manager.js", () => mockEnvManager);

vi.mock("./session-names.js", () => mockSessionNames);

vi.mock("./execution-store.js", () => ({
  ExecutionStore: MockExecutionStoreClass,
}));

// Schedule parsing has its own tests (agent-schedule.test.ts, real croner);
// here croner is mocked, so resolve one-shot dates directly. The time zone
// comes from settings in production; tests pin it through this mock.
const mockSchedule = vi.hoisted(() => ({ timezone: undefined as string | undefined }));
vi.mock("./agent-schedule.js", () => ({
  scheduleTimeZone: () => mockSchedule.timezone,
  scheduleTimeZoneLabel: (tz?: string) => tz ?? "server local time",
  nextScheduledRun: (schedule: { expression: string }) => {
    const date = new Date(schedule.expression);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid one-time date "${schedule.expression}"`);
    return date.getTime() > Date.now() ? date : null;
  },
}));

// Fork-source resolution has its own tests (session-fork.test.ts, real
// files); here each test decides what the source looks like.
const mockResolveForkSource = vi.hoisted(() => vi.fn());
vi.mock("./session-fork.js", () => ({ resolveForkSource: mockResolveForkSource }));

// Mock mkdtempSync to avoid filesystem side effects in tests.
// The agent-executor uses it for "temp" cwd.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: vi.fn().mockReturnValue("/tmp/companion-agent-test-abc123"),
  };
});

// ─── Import the class under test (after mocks are set up) ───────────────────

import { AgentExecutor, buildAgentPrompt, isAgentTempDir } from "./agent-executor.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal AgentConfig with sensible defaults. Override as needed. */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    cwd: "/tmp/test-repo",
    prompt: "Do something useful",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    totalRuns: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Create a mock CliLauncher with the methods AgentExecutor uses. */
function makeMockLauncher() {
  return {
    launch: vi.fn<(opts: Record<string, unknown>) => SdkSessionInfo>().mockImplementation((opts) => ({
      sessionId: "session-123",
      state: "starting" as const,
      cwd: (opts?.cwd as string) || "/tmp",
      createdAt: Date.now(),
    })),
    isAlive: vi.fn<(id: string) => boolean>().mockReturnValue(false),
    listSessions: vi.fn<() => SdkSessionInfo[]>().mockReturnValue([]),
    getSession: vi.fn<(id: string) => SdkSessionInfo | undefined>().mockReturnValue({
      sessionId: "session-123",
      state: "connected",
      cwd: "/tmp",
      createdAt: Date.now(),
    }),
  };
}

/** Create a mock WsBridge with the methods AgentExecutor uses. */
function makeMockWsBridge() {
  return {
    injectMcpSetServers: vi.fn(),
    injectSystemPrompt: vi.fn(),
    injectUserMessage: vi.fn(),
  };
}

/** A turn result as ws-bridge emits it on companionBus "message:result". */
function resultMessage(data: Partial<CLIResultMessage>): BrowserIncomingMessage {
  return { type: "result", data: { type: "result", ...data } as CLIResultMessage } as BrowserIncomingMessage;
}

/** Helper to get the most recently created Cron mock instance. */
function getLastCronInstance() {
  return mockCronState.instances[mockCronState.instances.length - 1];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AgentExecutor", () => {
  let launcher: ReturnType<typeof makeMockLauncher>;
  let wsBridge: ReturnType<typeof makeMockWsBridge>;
  let executor: AgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Cron tracking state between tests
    mockCronState.constructorCalls.length = 0;
    mockCronState.instances.length = 0;
    // Use fake timers so we can control setTimeout/setInterval in
    // waitForCLIConnection without actually waiting.
    vi.useFakeTimers();

    launcher = makeMockLauncher();
    wsBridge = makeMockWsBridge();
    executor = new AgentExecutor(launcher as never, wsBridge as never);
  });

  afterEach(() => {
    executor.destroy();
    vi.useRealTimers();
  });

  // =========================================================================
  // startAll
  // =========================================================================
  describe("startAll", () => {
    it("loads agents from disk and schedules enabled ones with schedule triggers", () => {
      // Three agents: one enabled with schedule, one disabled, one without schedule.
      // Only the enabled agent with a schedule trigger should get a Cron timer.
      const enabledAgent = makeAgent({
        id: "cron-agent",
        name: "Cron Agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "*/5 * * * *", recurring: true } },
      });
      const disabledAgent = makeAgent({
        id: "off-agent",
        name: "Off Agent",
        enabled: false,
      });
      const noScheduleAgent = makeAgent({
        id: "no-schedule",
        name: "No Schedule",
        enabled: true,
        // No schedule trigger
      });

      mockAgentStore.listAgents.mockReturnValue([enabledAgent, disabledAgent, noScheduleAgent]);

      executor.startAll();

      // listAgents should be called once
      expect(mockAgentStore.listAgents).toHaveBeenCalledOnce();
      // Cron constructor should have been called once (only for the enabled scheduled agent)
      expect(mockCronState.constructorCalls).toHaveLength(1);
      // The first argument to Cron should be the cron expression
      expect(mockCronState.constructorCalls[0].args[0]).toBe("*/5 * * * *");
    });

    it("does nothing when no agents exist", () => {
      mockAgentStore.listAgents.mockReturnValue([]);

      executor.startAll();

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // scheduleAgent
  // =========================================================================
  describe("scheduleAgent", () => {
    it("creates a Cron timer for recurring agents", () => {
      const agent = makeAgent({
        id: "recurring-agent",
        name: "Recurring Agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Cron should be created with the expression
      expect(mockCronState.constructorCalls).toHaveLength(1);
      expect(mockCronState.constructorCalls[0].args[0]).toBe("0 8 * * *");
      // The third argument should be the callback function (for recurring)
      expect(typeof mockCronState.constructorCalls[0].args[2]).toBe("function");
    });

    it("skips disabled agents", () => {
      const agent = makeAgent({
        id: "disabled-agent",
        enabled: false,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Cron should NOT be created
      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("skips agents with disabled schedule trigger", () => {
      const agent = makeAgent({
        id: "disabled-schedule",
        enabled: true,
        triggers: { schedule: { enabled: false, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("skips agents with no schedule expression", () => {
      const agent = makeAgent({
        id: "no-expression",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "", recurring: true } },
      });

      executor.scheduleAgent(agent);

      expect(mockCronState.constructorCalls).toHaveLength(0);
    });

    it("stops existing timer before rescheduling", () => {
      const agent = makeAgent({
        id: "reschedule-me",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      // Schedule once
      executor.scheduleAgent(agent);
      expect(mockCronState.instances).toHaveLength(1);
      const firstInstance = mockCronState.instances[0];

      // Schedule again -- should stop the old timer first, then create a new one
      executor.scheduleAgent(agent);
      expect(firstInstance.stop).toHaveBeenCalledTimes(1);
      expect(mockCronState.instances).toHaveLength(2);
    });

    it("creates a one-shot Cron for non-recurring agents with future date", () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const agent = makeAgent({
        id: "one-shot",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: futureDate, recurring: false } },
      });

      executor.scheduleAgent(agent);

      // Cron should be created with a Date object (one-shot)
      expect(mockCronState.constructorCalls).toHaveLength(1);
      // First arg should be a Date for one-shot
      const firstArg = mockCronState.constructorCalls[0].args[0];
      expect(firstArg).toBeInstanceOf(Date);
    });

    it("skips one-shot agent when target time is in the past", () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const agent = makeAgent({
        id: "past-one-shot",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: pastDate, recurring: false } },
      });

      executor.scheduleAgent(agent);

      // Cron should NOT be created for a past date
      expect(mockCronState.constructorCalls).toHaveLength(0);
      // ...and the skip is reported on the agent, not silent.
      expect(executor.getScheduleIssue("past-one-shot")).toMatch(/did not run: that time has passed/);
    });
  });

  // =========================================================================
  // stopAgent
  // =========================================================================
  describe("stopAgent", () => {
    it("stops and removes the timer for a scheduled agent", () => {
      const agent = makeAgent({
        id: "stop-me",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 8 * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);
      const cronInstance = getLastCronInstance();

      executor.stopAgent("stop-me");

      expect(cronInstance.stop).toHaveBeenCalledOnce();
      // After stopping, getNextRunTime should return null (timer removed)
      expect(executor.getNextRunTime("stop-me")).toBeNull();
    });

    it("does nothing when agent has no timer", () => {
      // Should not throw or have side effects
      executor.stopAgent("nonexistent-agent");
      // No Cron instances should have been created at all
      expect(mockCronState.instances).toHaveLength(0);
    });
  });

  // =========================================================================
  // executeAgent -- full flow
  // =========================================================================
  describe("executeAgent", () => {
    it("full flow: creates session, waits for CLI, sends prompt, tracks execution", async () => {
      const agent = makeAgent({
        id: "exec-agent",
        name: "Exec Agent",
        enabled: true,
        prompt: "Run the tests",
        cwd: "/my/project",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("exec-agent");

      // Should have launched a session
      expect(launcher.launch).toHaveBeenCalledOnce();
      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          permissionMode: "bypassPermissions",
          cwd: "/my/project",
        }),
      );

      // Should set the session name
      expect(mockSessionNames.setName).toHaveBeenCalledWith(
        "session-123",
        expect.stringContaining("Exec Agent"),
      );

      // Should inject the user message with agent prefix
      expect(wsBridge.injectUserMessage).toHaveBeenCalledOnce();
      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("[agent:exec-agent Exec Agent]");
      expect(sentPrompt).toContain("Run the tests");

      // Should update agent tracking (lastRunAt, totalRuns, etc.).
      // consecutiveFailures is no longer reset at launch: only a successful
      // result resets it (see "run lifecycle" below), otherwise failing runs
      // could never add up to the auto-disable threshold.
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("exec-agent", expect.objectContaining({
        lastRunAt: expect.any(Number),
        lastSessionId: "session-123",
        totalRuns: 1,
      }));

      // Should persist execution to the ExecutionStore
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.agentId).toBe("exec-agent");
      expect(appendedExec.sessionId).toBe("session-123");
      expect(appendedExec.triggerType).toBe("manual");
      expect(appendedExec.startedAt).toBeGreaterThan(0);

      // Return value should be the session info
      expect(result).toBeDefined();
      expect(result!.sessionId).toBe("session-123");
    });

    it("skips when agent is not found", async () => {
      // getAgent returns null by default -- agent does not exist
      mockAgentStore.getAgent.mockReturnValue(null);

      const result = await executor.executeAgent("nonexistent");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("skips when agent is disabled and force is not set", async () => {
      const agent = makeAgent({ id: "disabled", enabled: false });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("disabled");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("runs disabled agent when force=true", async () => {
      // Even though agent.enabled is false, force=true should bypass the check
      const agent = makeAgent({ id: "disabled-force", enabled: false, prompt: "forced run" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("disabled-force", undefined, { force: true });

      expect(result).toBeDefined();
      expect(launcher.launch).toHaveBeenCalledOnce();
    });

    it("skips when previous execution is still running (overlap prevention)", async () => {
      // Overlap is "a run of this agent has no result yet", not "its CLI
      // process is alive": a finished run's session stays alive on purpose.
      const agent = makeAgent({ id: "overlapping" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const first = await executor.executeAgent("overlapping");
      expect(first).toBeDefined();
      const result = await executor.executeAgent("overlapping");

      expect(result).toBeUndefined();
      expect(launcher.launch).toHaveBeenCalledTimes(1);
    });

    it("handles errors: marks execution as failed, increments consecutiveFailures", async () => {
      const agent = makeAgent({
        id: "fail-agent",
        name: "Fail Agent",
        consecutiveFailures: 1,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // Make launch throw an error
      launcher.launch.mockImplementation(() => {
        throw new Error("CLI binary not found");
      });

      const result = await executor.executeAgent("fail-agent");

      expect(result).toBeUndefined();

      // Execution should be recorded with error
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.error).toBe("CLI binary not found");
      expect(appendedExec.completedAt).toBeGreaterThan(0);

      // consecutiveFailures should be incremented from 1 to 2
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("fail-agent", expect.objectContaining({
        consecutiveFailures: 2,
        lastRunAt: expect.any(Number),
      }));
    });

    it("auto-disables agent after MAX_CONSECUTIVE_FAILURES (5)", async () => {
      // Agent already has 4 consecutive failures -- one more triggers auto-disable
      const agent = makeAgent({
        id: "auto-disable",
        name: "Auto Disable Agent",
        consecutiveFailures: 4,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      launcher.launch.mockImplementation(() => {
        throw new Error("repeated failure");
      });

      await executor.executeAgent("auto-disable");

      // Should update agent with enabled=false and consecutiveFailures=5
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("auto-disable", expect.objectContaining({
        enabled: false,
        consecutiveFailures: 5,
      }));
    });

    it("does not auto-disable when failures are below threshold", async () => {
      // After this failure: consecutiveFailures = 3, below the threshold of 5
      const agent = makeAgent({
        id: "below-threshold",
        consecutiveFailures: 2,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      launcher.launch.mockImplementation(() => {
        throw new Error("temporary failure");
      });

      await executor.executeAgent("below-threshold");

      // Should NOT include enabled=false in the update
      const updateCall = mockAgentStore.updateAgent.mock.calls[0];
      const updates = updateCall[1] as Partial<AgentConfig>;
      expect(updates.enabled).toBeUndefined();
      expect(updates.consecutiveFailures).toBe(3);
    });

    it("replaces {{input}} in prompt with provided input", async () => {
      const agent = makeAgent({
        id: "input-agent",
        prompt: "Process this PR: {{input}}",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("input-agent", "https://github.com/org/repo/pull/42");

      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("Process this PR: https://github.com/org/repo/pull/42");
      expect(sentPrompt).not.toContain("{{input}}");
    });

    it("strips {{input}} placeholder when no input is provided", async () => {
      const agent = makeAgent({
        id: "strip-input-agent",
        prompt: "Run task: {{input}} now",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("strip-input-agent");

      const sentPrompt = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sentPrompt).toContain("Run task:  now");
      expect(sentPrompt).not.toContain("{{input}}");
    });

    it("resolves environment variables from envSlug and inline env", async () => {
      // Agent uses both an envSlug (resolved via envManager) and inline env vars.
      // The inline env should override envSlug vars if they overlap.
      const agent = makeAgent({
        id: "env-agent",
        envSlug: "prod-env",
        env: { INLINE_VAR: "inline-value" },
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      mockEnvManager.getEnv.mockReturnValue({
        name: "Production",
        slug: "prod-env",
        variables: { ENV_VAR: "env-value" },
      });

      await executor.executeAgent("env-agent");

      // The profile is passed by slug (the launcher resolves it at every
      // spawn, below the inline env, so inline vars override profile vars);
      // the inline env travels as the request env.
      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          envSlug: "prod-env",
          env: { INLINE_VAR: "inline-value" },
        }),
      );
    });

    it("merges additional env vars and injects a Claude system prompt when provided", async () => {
      const agent = makeAgent({
        id: "linear-agent",
        name: "Linear Agent",
        backendType: "claude",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("linear-agent", "Handle this issue", {
        triggerType: "linear",
        additionalEnv: {
          LINEAR_OAUTH_ACCESS_TOKEN: "lin_oauth_test",
          LINEAR_API_KEY: "lin_oauth_test",
        },
        systemPrompt: "Use the Linear OAuth token for GraphQL requests.",
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            LINEAR_OAUTH_ACCESS_TOKEN: "lin_oauth_test",
            LINEAR_API_KEY: "lin_oauth_test",
          }),
        }),
      );
      expect(wsBridge.injectSystemPrompt).toHaveBeenCalledWith(
        "session-123",
        "Use the Linear OAuth token for GraphQL requests.",
      );
    });

    it("passes the extra system prompt directly to Codex launches", async () => {
      const agent = makeAgent({
        id: "linear-codex-agent",
        name: "Linear Codex Agent",
        backendType: "codex",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("linear-codex-agent", "Handle this issue", {
        triggerType: "linear",
        systemPrompt: "Codex linear context",
      });

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Codex linear context",
        }),
      );
      expect(wsBridge.injectSystemPrompt).not.toHaveBeenCalled();
    });

    it("uses temp directory when cwd is 'temp'", async () => {
      const agent = makeAgent({
        id: "temp-cwd-agent",
        cwd: "temp",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("temp-cwd-agent");

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/companion-agent-test-abc123",
        }),
      );
    });

    it("uses temp directory when cwd is empty", async () => {
      const agent = makeAgent({
        id: "empty-cwd-agent",
        cwd: "",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("empty-cwd-agent");

      expect(launcher.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/tmp/companion-agent-test-abc123",
        }),
      );
    });

    it("configures MCP servers when specified", async () => {
      const mcpServers = {
        myServer: { type: "stdio" as const, command: "node", args: ["server.js"] },
      };
      const agent = makeAgent({
        id: "mcp-agent",
        mcpServers,
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // executeAgent has a 2s MCP_INIT_DELAY_MS setTimeout when mcpServers are set.
      // We must advance fake timers to let it resolve.
      const promise = executor.executeAgent("mcp-agent");
      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      // Should inject MCP servers before sending the prompt
      expect(wsBridge.injectMcpSetServers).toHaveBeenCalledWith("session-123", mcpServers);
      // Should still send the user message after MCP setup
      expect(wsBridge.injectUserMessage).toHaveBeenCalled();
    });

    it("does not inject MCP servers when none are specified", async () => {
      const agent = makeAgent({
        id: "no-mcp-agent",
        // No mcpServers
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("no-mcp-agent");

      expect(wsBridge.injectMcpSetServers).not.toHaveBeenCalled();
    });

    it("tags session with agentId and agentName", async () => {
      const agent = makeAgent({
        id: "tag-agent",
        name: "Tag Agent",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("tag-agent");

      // The session info object is mutated in-place to include agent metadata
      expect(result!.agentId).toBe("tag-agent");
      expect(result!.agentName).toBe("Tag Agent");
    });

    it("uses 'schedule' triggerType when specified", async () => {
      const agent = makeAgent({ id: "scheduled" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("scheduled", undefined, { triggerType: "schedule" });

      const appendedExec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appendedExec.triggerType).toBe("schedule");
    });
  });

  // =========================================================================
  // waitForCLIConnection (tested indirectly via executeAgent)
  // =========================================================================
  describe("waitForCLIConnection (via executeAgent)", () => {
    it("throws if CLI exits before connecting", async () => {
      const agent = makeAgent({ id: "exit-early" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // After launch, getSession returns "exited" state on every poll
      launcher.getSession.mockReturnValue({
        sessionId: "session-123",
        state: "exited",
        exitCode: 1,
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const promise = executor.executeAgent("exit-early");
      // Advance timers to trigger the poll
      await vi.advanceTimersByTimeAsync(1000);

      const result = await promise;
      // Should have failed (error path in catch block)
      expect(result).toBeUndefined();

      // Execution should have error about CLI exiting before connecting
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const exec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(exec.error).toContain("CLI process exited before connecting");
    });

    it("throws if CLI does not connect within timeout", async () => {
      const agent = makeAgent({ id: "timeout-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // getSession always returns "starting" -- never transitions to connected
      launcher.getSession.mockReturnValue({
        sessionId: "session-123",
        state: "starting",
        cwd: "/tmp",
        createdAt: Date.now(),
      });

      const promise = executor.executeAgent("timeout-agent");

      // Advance past the 30s timeout (CLI_CONNECT_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(35_000);

      const result = await promise;
      expect(result).toBeUndefined();

      // Should have a timeout error
      expect(mockExecutionStoreInstance.append).toHaveBeenCalledOnce();
      const exec = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(exec.error).toContain("did not connect within");
    });
  });

  // =========================================================================
  // handleSessionExited
  // =========================================================================
  describe("handleSessionExited", () => {
    // A run is complete on its first turn result. A CLI that exits before
    // producing one never finished the run, whatever its exit code — but the
    // result line may still be in the stdout reader, hence the grace period.
    it("fails a run whose CLI exits with code 0 before any result", async () => {
      const agent = makeAgent({ id: "exit-agent", name: "Exit Agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("exit-agent");
      executor.handleSessionExited("session-123", 0);
      // Still running during the grace period
      expect(executor.getExecutions("exit-agent")[0].completedAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);

      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        completedAt: expect.any(Number),
        success: false,
        error: "CLI exited before the run finished",
      }));
      const executions = executor.getExecutions("exit-agent");
      expect(executions).toHaveLength(1);
      expect(executions[0].completedAt).toBeGreaterThan(0);
      expect(executions[0].success).toBe(false);
    });

    it("marks execution as failed with non-zero exit code", async () => {
      const agent = makeAgent({ id: "fail-exit-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("fail-exit-agent");

      executor.handleSessionExited("session-123", 1);
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);

      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        completedAt: expect.any(Number),
        success: false,
        error: "CLI exited with code 1 before the run finished",
      }));

      const executions = executor.getExecutions("fail-exit-agent");
      expect(executions[0].success).toBe(false);
      expect(executions[0].error).toContain("exited with code 1");
    });

    it("keeps the result when it arrives within the grace period after the exit", async () => {
      // Exit noticed first, result line read just after: the run succeeded.
      const agent = makeAgent({ id: "late-result-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("late-result-agent");
      executor.handleSessionExited("session-123", null);
      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);

      const exec = executor.getExecutions("late-result-agent")[0];
      expect(exec.success).toBe(true);
      expect(exec.error).toBeUndefined();
      expect(mockExecutionStoreInstance.update).toHaveBeenCalledTimes(1);
    });

    it("does nothing for an unknown session", async () => {
      // No executions have been tracked, so this should be a no-op
      executor.handleSessionExited("unknown-session-id", 0);
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);

      expect(mockExecutionStoreInstance.update).not.toHaveBeenCalled();
    });

    it("only marks the first matching incomplete execution", async () => {
      const agent = makeAgent({ id: "multi-exec-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      // Run the agent once with session-aaa
      launcher.launch.mockReturnValueOnce({
        sessionId: "session-aaa",
        state: "starting" as const,
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      await executor.executeAgent("multi-exec-agent");

      // Run the agent again with session-bbb. session-aaa has no result yet,
      // so only a forced run (as Linear does) may overlap it.
      launcher.launch.mockReturnValueOnce({
        sessionId: "session-bbb",
        state: "starting" as const,
        cwd: "/tmp",
        createdAt: Date.now(),
      });
      await executor.executeAgent("multi-exec-agent", undefined, { force: true });

      // Exit session-aaa
      executor.handleSessionExited("session-aaa", 0);
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);

      const executions = executor.getExecutions("multi-exec-agent");
      const aaa = executions.find((e) => e.sessionId === "session-aaa");
      const bbb = executions.find((e) => e.sessionId === "session-bbb");
      expect(aaa!.completedAt).toBeDefined();
      expect(aaa!.success).toBe(false);
      // session-bbb should still be running (no completedAt)
      expect(bbb!.completedAt).toBeUndefined();
    });
  });

  // =========================================================================
  // executeAgentManually
  // =========================================================================
  describe("executeAgentManually", () => {
    it("calls executeAgent with ignoreEnabled=true and triggerType='manual'", async () => {
      // Even though the agent is disabled, executeAgentManually should
      // call executeAgent with ignoreEnabled to bypass the enabled check
      // (but, unlike force, not the overlap check).
      const agent = makeAgent({ id: "manual-agent", enabled: false });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const executeSpy = vi.spyOn(executor, "executeAgent");

      const result = executor.executeAgentManually("manual-agent", "some input");

      // Need to advance timers to let the async execute complete
      await vi.advanceTimersByTimeAsync(100);

      expect(result).toEqual({ ok: true });
      expect(executeSpy).toHaveBeenCalledWith("manual-agent", "some input", {
        ignoreEnabled: true,
        triggerType: "manual",
      });
    });

    it("refuses with 409 while a run of the agent is still in progress", async () => {
      // "Run now" must not stack a second run on one still waiting for its result.
      const agent = makeAgent({ id: "busy-agent", name: "Busy Agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("busy-agent");

      const result = executor.executeAgentManually("busy-agent");

      expect(result).toEqual({
        ok: false,
        status: 409,
        error: 'A run of agent "Busy Agent" is still in progress (session session-123)',
      });
      expect(launcher.launch).toHaveBeenCalledTimes(1);
    });

    it("returns 404 for an unknown agent", () => {
      mockAgentStore.getAgent.mockReturnValue(null);
      expect(executor.executeAgentManually("ghost")).toEqual({ ok: false, status: 404, error: "Agent not found" });
    });
  });

  // =========================================================================
  // getExecutions
  // =========================================================================
  describe("getExecutions", () => {
    it("returns empty array for unknown agent", () => {
      const result = executor.getExecutions("nonexistent-agent");
      expect(result).toEqual([]);
    });

    it("returns executions after agent has run", async () => {
      const agent = makeAgent({ id: "tracked-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      await executor.executeAgent("tracked-agent");

      const executions = executor.getExecutions("tracked-agent");
      expect(executions).toHaveLength(1);
      expect(executions[0].agentId).toBe("tracked-agent");
      expect(executions[0].sessionId).toBe("session-123");
    });
  });

  // =========================================================================
  // getNextRunTime
  // =========================================================================
  describe("getNextRunTime", () => {
    it("returns null when no timer is set", () => {
      expect(executor.getNextRunTime("no-timer-agent")).toBeNull();
    });

    it("returns the next run date from the Cron timer", () => {
      const futureDate = new Date(Date.now() + 3600_000);

      const agent = makeAgent({
        id: "next-run-agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Configure the mock instance to return our future date
      const cronInstance = getLastCronInstance();
      cronInstance.nextRun.mockReturnValue(futureDate);

      const nextRun = executor.getNextRunTime("next-run-agent");
      expect(nextRun).toEqual(futureDate);
    });

    it("returns null when timer.nextRun() returns falsy", () => {
      const agent = makeAgent({
        id: "no-next-run-agent",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent);

      // Configure the mock instance to return undefined (falsy)
      const cronInstance = getLastCronInstance();
      cronInstance.nextRun.mockReturnValue(undefined);

      expect(executor.getNextRunTime("no-next-run-agent")).toBeNull();
    });
  });

  // =========================================================================
  // destroy
  // =========================================================================
  describe("destroy", () => {
    it("stops all active timers and clears state", () => {
      // Schedule two agents to create two Cron instances
      const agent1 = makeAgent({
        id: "destroy-agent-1",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });
      const agent2 = makeAgent({
        id: "destroy-agent-2",
        enabled: true,
        triggers: { schedule: { enabled: true, expression: "30 * * * *", recurring: true } },
      });

      executor.scheduleAgent(agent1);
      executor.scheduleAgent(agent2);

      expect(mockCronState.instances).toHaveLength(2);
      const instance1 = mockCronState.instances[0];
      const instance2 = mockCronState.instances[1];

      executor.destroy();

      // stop() should be called once on each timer instance
      expect(instance1.stop).toHaveBeenCalledOnce();
      expect(instance2.stop).toHaveBeenCalledOnce();

      // After destroy, getNextRunTime should return null for both
      expect(executor.getNextRunTime("destroy-agent-1")).toBeNull();
      expect(executor.getNextRunTime("destroy-agent-2")).toBeNull();

      // After destroy, getExecutions should return empty (executions map is cleared)
      expect(executor.getExecutions("destroy-agent-1")).toEqual([]);
    });
  });

  // =========================================================================
  // permissionMode warning
  // =========================================================================
  describe("permissionMode warning", () => {
    it("logs warning when agent permissionMode differs from bypassPermissions", async () => {
      // An agent with permissionMode="plan" should trigger a console.warn
      // because agent sessions always run with bypassPermissions.
      const agent = makeAgent({
        id: "plan-mode-agent",
        name: "Plan Mode Agent",
        permissionMode: "plan",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("plan-mode-agent");

      // The warning should mention the agent's actual permissionMode
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('permissionMode="plan"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("bypassPermissions"),
      );

      warnSpy.mockRestore();
    });

    it("does not warn when permissionMode is bypassPermissions", async () => {
      const agent = makeAgent({
        id: "bypass-mode-agent",
        permissionMode: "bypassPermissions",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("bypass-mode-agent");

      // No warning about permissionMode should appear
      const permWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("permissionMode"),
      );
      expect(permWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it("does not warn when permissionMode is not set (empty string)", async () => {
      // An empty string is falsy, so the guard `agent.permissionMode &&` fails
      const agent = makeAgent({
        id: "no-mode-agent",
        permissionMode: "",
      });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await executor.executeAgent("no-mode-agent");

      // No warning about permissionMode should appear
      const permWarns = warnSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("permissionMode"),
      );
      expect(permWarns).toHaveLength(0);

      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // listAllExecutions (delegates to ExecutionStore)
  // =========================================================================
  describe("listAllExecutions", () => {
    it("delegates to executionStore.list()", () => {
      const mockResult = {
        executions: [{ sessionId: "s1", agentId: "a1", triggerType: "manual" as const, startedAt: 100 }],
        total: 1,
      };
      mockExecutionStoreInstance.list.mockReturnValue(mockResult);

      const result = executor.listAllExecutions({ agentId: "a1", limit: 10 });

      expect(mockExecutionStoreInstance.list).toHaveBeenCalledWith({ agentId: "a1", limit: 10 });
      expect(result).toEqual(mockResult);
    });
  });

  // =========================================================================
  // Run lifecycle: a run is complete on its session's first turn result
  // =========================================================================
  describe("run lifecycle (handleSessionResult)", () => {
    it("completes the run on the first result, keeps the session and resets failures", async () => {
      // The run is done when the CLI reports its turn result. The session is
      // NOT killed (the user can open it and continue), and a success resets
      // consecutiveFailures.
      const agent = makeAgent({ id: "ok-agent", consecutiveFailures: 3 });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("ok-agent");
      expect(executor.isRunInProgress("ok-agent")).toBe(true);

      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));

      const exec = executor.getExecutions("ok-agent")[0];
      expect(exec.success).toBe(true);
      expect(exec.subtype).toBe("success");
      expect(exec.completedAt).toBeGreaterThan(0);
      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        success: true,
        subtype: "success",
      }));
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("ok-agent", { consecutiveFailures: 0 });
      expect(executor.isRunInProgress("ok-agent")).toBe(false);
      // The session is kept: the mock launcher has no kill(), so any attempt
      // to end the session would have thrown above.
      expect(launcher).not.toHaveProperty("kill");
    });

    it("records an error result with its subtype and message, and counts the failure", async () => {
      const agent = makeAgent({ id: "err-agent", consecutiveFailures: 1 });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("err-agent");

      executor.handleSessionResult("session-123", resultMessage({
        is_error: true,
        subtype: "error_max_turns",
        errors: ["Reached the maximum number of turns"],
      }));

      const exec = executor.getExecutions("err-agent")[0];
      expect(exec.success).toBe(false);
      expect(exec.subtype).toBe("error_max_turns");
      expect(exec.error).toBe("Reached the maximum number of turns");
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("err-agent", { consecutiveFailures: 2 });
    });

    it("falls back to the result text, then the subtype, for the error message", async () => {
      const agent = makeAgent({ id: "err-text-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("err-text-agent");
      executor.handleSessionResult("session-123", resultMessage({ is_error: true, subtype: "error_during_execution", result: "API overloaded" }));
      expect(executor.getExecutions("err-text-agent")[0].error).toBe("API overloaded");

      launcher.launch.mockReturnValueOnce({ sessionId: "session-2", state: "starting", cwd: "/tmp", createdAt: Date.now() });
      await executor.executeAgent("err-text-agent");
      executor.handleSessionResult("session-2", resultMessage({ is_error: true, subtype: "error_max_budget_usd" }));
      expect(executor.getExecutions("err-text-agent")[1].error).toBe("Run ended with error_max_budget_usd");
    });

    it("auto-disables the agent after five failed results in a row", async () => {
      const agent = makeAgent({ id: "flaky-agent", consecutiveFailures: 4 });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("flaky-agent");

      executor.handleSessionResult("session-123", resultMessage({ is_error: true, subtype: "error_during_execution" }));

      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("flaky-agent", expect.objectContaining({
        enabled: false,
        consecutiveFailures: 5,
      }));
    });

    it("ignores later results of the same session and non-result messages", async () => {
      // Only the FIRST result completes the run; follow-up turns in the kept
      // session (or a Linear follow-up) must not rewrite it.
      const agent = makeAgent({ id: "once-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("once-agent");

      executor.handleSessionResult("session-123", { type: "cli_connected" } as never);
      expect(executor.isRunInProgress("once-agent")).toBe(true);
      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));
      executor.handleSessionResult("session-123", resultMessage({ is_error: true, subtype: "error_during_execution" }));

      expect(executor.getExecutions("once-agent")[0].success).toBe(true);
      expect(mockExecutionStoreInstance.update).toHaveBeenCalledTimes(1);
    });

    it("allows a new run once the previous one has its result", async () => {
      const agent = makeAgent({ id: "again-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);
      await executor.executeAgent("again-agent");
      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));

      expect(executor.startRun("again-agent")).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(launcher.launch).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // startRun: synchronous gate + reservation
  // =========================================================================
  describe("startRun", () => {
    it("reserves the run synchronously so two triggers at once start only one", () => {
      // The second call happens before the first launch's async work runs;
      // it must already see the run in progress.
      const agent = makeAgent({ id: "race-agent", name: "Race Agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const first = executor.startRun("race-agent", undefined, { triggerType: "webhook" });
      const second = executor.startRun("race-agent", undefined, { triggerType: "webhook" });

      expect(first).toEqual({ ok: true });
      expect(second).toMatchObject({ ok: false, status: 409 });
      expect(launcher.launch).toHaveBeenCalledTimes(1);
    });

    it("refuses a disabled agent unless ignoreEnabled/force is set", () => {
      const agent = makeAgent({ id: "off-agent", name: "Off Agent", enabled: false });
      mockAgentStore.getAgent.mockReturnValue(agent);

      expect(executor.startRun("off-agent", undefined, { triggerType: "webhook" })).toEqual({
        ok: false,
        status: 409,
        error: 'Agent "Off Agent" is disabled',
      });
      expect(launcher.launch).not.toHaveBeenCalled();
    });

    it("records the trigger type and appends non-placeholder input as a delimited block", async () => {
      const agent = makeAgent({ id: "hook-agent", prompt: "Summarize the payload." });
      mockAgentStore.getAgent.mockReturnValue(agent);

      executor.startRun("hook-agent", "event=push", { triggerType: "webhook" });
      await vi.advanceTimersByTimeAsync(10);

      const appended = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appended.triggerType).toBe("webhook");
      const sent = wsBridge.injectUserMessage.mock.calls[0][1] as string;
      expect(sent).toContain("Summarize the payload.\n\nInput provided by the trigger:\n<trigger_input>\nevent=push\n</trigger_input>");
    });

    it("counts a run as in progress while it is still launching", async () => {
      // Between the launch and the CLI connecting there is no result yet.
      const agent = makeAgent({ id: "slow-agent" });
      mockAgentStore.getAgent.mockReturnValue(agent);
      launcher.getSession.mockReturnValue({ sessionId: "session-123", state: "starting", cwd: "/tmp", createdAt: Date.now() });

      executor.startRun("slow-agent");
      expect(executor.isRunInProgress("slow-agent")).toBe(true);
      await vi.advanceTimersByTimeAsync(35_000);
      // Connection timeout closes the run as failed
      expect(executor.isRunInProgress("slow-agent")).toBe(false);
      expect(executor.getExecutions("slow-agent")[0].success).toBe(false);
    });
  });

  // =========================================================================
  // buildAgentPrompt
  // =========================================================================
  describe("buildAgentPrompt", () => {
    it("replaces every placeholder and keeps $-patterns in the input literal", () => {
      // String.replace with a string replacement would expand "$&".
      expect(buildAgentPrompt("A {{input}} B {{input}}", "x$&y")).toBe("A x$&y B x$&y");
    });

    it("leaves a prompt without placeholder unchanged when there is no input", () => {
      expect(buildAgentPrompt("Do it", undefined)).toBe("Do it");
      expect(buildAgentPrompt("Do it", "   ")).toBe("Do it");
    });

    it("appends input to a prompt without placeholder", () => {
      expect(buildAgentPrompt("Do it", "data")).toBe(
        "Do it\n\nInput provided by the trigger:\n<trigger_input>\ndata\n</trigger_input>",
      );
    });
  });

  // =========================================================================
  // Schedules: time zone, mode, firing, reporting
  // =========================================================================
  describe("schedules", () => {
    afterEach(() => {
      mockSchedule.timezone = undefined;
    });

    it("arms recurring schedules in 5-field mode and the configured time zone", () => {
      mockSchedule.timezone = "Europe/Rome";
      executor.scheduleAgent(makeAgent({
        id: "tz-agent",
        triggers: { schedule: { enabled: true, expression: "0 9 * * 1-5", recurring: true } },
      }));
      expect(mockCronState.constructorCalls[0].args[1]).toEqual({ mode: "5-part", timezone: "Europe/Rome" });
    });

    it("rescheduleAll re-arms every agent (e.g. after a time zone change)", () => {
      const agent = makeAgent({
        id: "re-agent",
        triggers: { schedule: { enabled: true, expression: "0 * * * *", recurring: true } },
      });
      mockAgentStore.listAgents.mockReturnValue([agent]);
      executor.scheduleAgent(agent);
      const first = getLastCronInstance();

      mockSchedule.timezone = "America/New_York";
      executor.rescheduleAll();

      expect(first.stop).toHaveBeenCalled();
      expect(mockCronState.constructorCalls).toHaveLength(2);
      expect(mockCronState.constructorCalls[1].args[1]).toEqual({ mode: "5-part", timezone: "America/New_York" });
    });

    it("a fired recurring schedule starts a schedule run", async () => {
      const agent = makeAgent({
        id: "fire-agent",
        triggers: { schedule: { enabled: true, expression: "*/5 * * * *", recurring: true } },
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      executor.scheduleAgent(agent);
      const callback = mockCronState.constructorCalls[0].args[2] as () => void;

      callback();
      await vi.advanceTimersByTimeAsync(10);

      const appended = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appended.triggerType).toBe("schedule");
      expect(executor.getScheduleIssue("fire-agent")).toBeNull();
    });

    it("reports a scheduled run skipped because the previous run is still in progress", async () => {
      const agent = makeAgent({
        id: "skip-agent",
        name: "Skip Agent",
        triggers: { schedule: { enabled: true, expression: "*/5 * * * *", recurring: true } },
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      executor.scheduleAgent(agent);
      const callback = mockCronState.constructorCalls[0].args[2] as () => void;
      await executor.executeAgent("skip-agent");

      callback();

      expect(launcher.launch).toHaveBeenCalledTimes(1);
      expect(executor.getScheduleIssue("skip-agent")).toMatch(/Scheduled run at .* skipped: A run of agent "Skip Agent" is still in progress/);
    });

    it("a fired one-shot disables its schedule and runs", async () => {
      const target = new Date(Date.now() + 60_000).toISOString();
      const agent = makeAgent({
        id: "once-agent",
        triggers: { schedule: { enabled: true, expression: target, recurring: false } },
      });
      mockAgentStore.getAgent.mockReturnValue(agent);
      executor.scheduleAgent(agent);
      const callback = mockCronState.constructorCalls[0].args[1] as () => void;

      callback();
      await vi.advanceTimersByTimeAsync(10);

      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("once-agent", {
        triggers: { schedule: { enabled: false, expression: target, recurring: false } },
      });
      expect(launcher.launch).toHaveBeenCalledOnce();
      expect(executor.getNextRunTime("once-agent")).toBeNull();
    });

    it("reports a schedule croner cannot arm instead of throwing", () => {
      executor.scheduleAgent(makeAgent({
        id: "bad-agent",
        triggers: { schedule: { enabled: true, expression: "not a date", recurring: false } },
      }));
      expect(executor.getScheduleIssue("bad-agent")).toMatch(/^Schedule not armed: Invalid one-time date/);
      // stopAgent (e.g. schedule disabled) clears the report
      executor.stopAgent("bad-agent");
      expect(executor.getScheduleIssue("bad-agent")).toBeNull();
    });
  });

  // =========================================================================
  // Restart recovery
  // =========================================================================
  it("closes runs left open by a previous server process at construction", () => {
    // Every CLI dies with the server, so those runs can never get a result.
    expect(mockExecutionStoreInstance.finalizeInterrupted).toHaveBeenCalledWith(
      "Interrupted: the server restarted before the run finished",
    );
  });

  // =========================================================================
  // Allowed tools → --tools (Claude only)
  // =========================================================================
  describe("allowedTools", () => {
    it("passes allowedTools to Claude launches as the restricting tools option", async () => {
      mockAgentStore.getAgent.mockReturnValue(makeAgent({ id: "tools-agent", allowedTools: ["Read", "Grep"] }));
      await executor.executeAgent("tools-agent");
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ tools: ["Read", "Grep"] }));
    });

    it("does not pass tools for Codex, which has no per-tool switch", async () => {
      mockAgentStore.getAgent.mockReturnValue(makeAgent({ id: "codex-tools", backendType: "codex", allowedTools: ["Read"] }));
      await executor.executeAgent("codex-tools");
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
    });
  });

  // =========================================================================
  // Temp working directories of cwd:"temp" agents
  // =========================================================================
  describe("temp cwd cleanup", () => {
    let dir: string;

    /** The next "temp" run gets this real directory as its mkdtemp result. */
    const useRealTempDir = () => vi.mocked(mkdtempSync).mockReturnValueOnce(dir);

    beforeEach(async () => {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      dir = fs.mkdtempSync(join(tmpdir(), "companion-agent-cleanup-"));
      mockAgentStore.getAgent.mockReturnValue(makeAgent({ id: "temp-agent", cwd: "temp" }));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("keeps the dir while the finished run's session is still around", async () => {
      // The user may open the session and continue working in that cwd.
      useRealTempDir();
      await executor.executeAgent("temp-agent");
      launcher.getSession.mockReturnValue({ sessionId: "session-123", state: "connected", cwd: dir, createdAt: 1 });
      launcher.listSessions.mockReturnValue([{ sessionId: "session-123", state: "connected", cwd: dir, createdAt: 1 }]);

      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));

      expect(existsSync(dir)).toBe(true);
      expect(executor.getExecutions("temp-agent")[0].tempCwd).toBe(dir);
    });

    it("removes the dir once the session is archived after the run finished", async () => {
      useRealTempDir();
      await executor.executeAgent("temp-agent");
      launcher.getSession.mockReturnValue({ sessionId: "session-123", state: "connected", cwd: dir, createdAt: 1 });
      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));
      expect(existsSync(dir)).toBe(true);

      launcher.getSession.mockReturnValue({ sessionId: "session-123", state: "exited", cwd: dir, createdAt: 1, archived: true });
      mockExecutionStoreInstance.all.mockReturnValue(executor.getExecutions("temp-agent"));
      executor.handleSessionClosed("session-123");

      expect(existsSync(dir)).toBe(false);
    });

    it("never removes the dir of a run still in progress, even if its session is archived", async () => {
      useRealTempDir();
      await executor.executeAgent("temp-agent");
      launcher.getSession.mockReturnValue({ sessionId: "session-123", state: "exited", cwd: dir, createdAt: 1, archived: true });
      mockExecutionStoreInstance.all.mockReturnValue(executor.getExecutions("temp-agent"));

      executor.handleSessionClosed("session-123");
      expect(existsSync(dir)).toBe(true);

      // The archive killed the CLI: the run fails after the grace period, and
      // only then is the dir released.
      executor.handleSessionExited("session-123", null);
      await vi.advanceTimersByTimeAsync(AgentExecutor.EXIT_GRACE_MS);
      expect(existsSync(dir)).toBe(false);
    });

    it("keeps the dir when another live session uses it", async () => {
      useRealTempDir();
      await executor.executeAgent("temp-agent");
      launcher.getSession.mockReturnValue(undefined);
      launcher.listSessions.mockReturnValue([{ sessionId: "other", state: "connected", cwd: dir, createdAt: 1 }]);

      executor.handleSessionResult("session-123", resultMessage({ is_error: false, subtype: "success" }));

      expect(existsSync(dir)).toBe(true);
    });

    it("removes the dir right away when the launch itself failed", async () => {
      launcher.launch.mockImplementation(() => {
        throw new Error("spawn failed");
      });
      useRealTempDir();
      await executor.executeAgent("temp-agent");
      expect(existsSync(dir)).toBe(false);
    });

    it("sweeps finished runs' dirs of sessions deleted while the server was down", () => {
      mockExecutionStoreInstance.all.mockReturnValue([
        { sessionId: "gone", agentId: "temp-agent", triggerType: "manual", startedAt: 1, completedAt: 2, success: true, tempCwd: dir },
      ]);
      launcher.getSession.mockReturnValue(undefined);

      executor.startAll();

      expect(existsSync(dir)).toBe(false);
    });

    it("recreates a removed temp dir when its session is unarchived", () => {
      rmSync(dir, { recursive: true, force: true });
      launcher.getSession.mockReturnValue({ sessionId: "s", state: "exited", cwd: dir, createdAt: 1 });

      executor.handleSessionUnarchived("s");

      expect(existsSync(dir)).toBe(true);
    });

    it("only ever treats companion-agent-* dirs directly under tmpdir as temp dirs", () => {
      expect(isAgentTempDir(dir)).toBe(true);
      expect(isAgentTempDir(join(dir, "nested"))).toBe(false);
      expect(isAgentTempDir(join(tmpdir(), "other-dir"))).toBe(false);
      expect(isAgentTempDir("/home/user/companion-agent-x")).toBe(false);
      expect(isAgentTempDir(undefined)).toBe(false);
    });
  });

  // =========================================================================
  // Context modes: "brief" (fresh session) and "fork" (copy of a session)
  // =========================================================================
  describe("context modes", () => {
    const forkOk = {
      ok: true,
      cwd: "/work/source-repo",
      source: { sessionId: "src-session", cliSessionId: "cli-src" },
    };

    // A fork run must start from the source conversation and in the
    // source's folder, never in a fresh temp dir.
    it("launches a fork run on a copy of the source session, in its folder", async () => {
      mockResolveForkSource.mockReturnValue(forkOk);
      mockAgentStore.getAgent.mockReturnValue(
        makeAgent({ id: "forker", cwd: "temp", contextMode: "fork", sourceSessionId: "src-session" }),
      );

      await executor.executeAgent("forker");

      expect(mockResolveForkSource).toHaveBeenCalledWith(launcher, "src-session", "claude");
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({
        cwd: "/work/source-repo",
        forkSource: { sessionId: "src-session", cliSessionId: "cli-src" },
      }));
      const appended = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(appended.tempCwd).toBeUndefined();
    });

    // A source without a resumable transcript fails the run at once with
    // the reason, and no session is launched.
    it("fails the run with a clear error when the source cannot be forked", async () => {
      mockResolveForkSource.mockReturnValue({ ok: false, error: "Claude transcript cli-src is not on disk" });
      const agent = makeAgent({ id: "forker", contextMode: "fork", sourceSessionId: "src-session" });
      mockAgentStore.getAgent.mockReturnValue(agent);

      const result = await executor.executeAgent("forker");

      expect(result).toBeUndefined();
      expect(launcher.launch).not.toHaveBeenCalled();
      const failed = mockExecutionStoreInstance.append.mock.calls[0][0] as AgentExecution;
      expect(failed).toMatchObject({
        success: false,
        error: "Cannot fork the source session: Claude transcript cli-src is not on disk",
      });
      expect(mockAgentStore.updateAgent).toHaveBeenCalledWith("forker", expect.objectContaining({ consecutiveFailures: 1 }));
    });

    // "brief" (and the default) keep the old behaviour: no fork source.
    it("starts brief runs fresh without consulting a source session", async () => {
      mockAgentStore.getAgent.mockReturnValue(makeAgent({ id: "brief", contextMode: "brief", sourceSessionId: "src-session" }));
      await executor.executeAgent("brief");
      expect(mockResolveForkSource).not.toHaveBeenCalled();
      expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/test-repo", forkSource: undefined }));
    });

    // Codex reports a failed thread/fork as an init failure, not an exit:
    // the run must still close as failed instead of staying "running".
    it("fails an open run when its Codex session cannot start its thread", async () => {
      mockAgentStore.getAgent.mockReturnValue(makeAgent({ id: "codex-forker", backendType: "codex" }));
      await executor.executeAgent("codex-forker");
      expect(executor.isRunInProgress("codex-forker")).toBe(true);

      executor.handleSessionInitFailed("session-123", "Codex initialization failed: Could not fork the source conversation");
      executor.handleSessionInitFailed("unknown-session", "ignored");

      expect(executor.isRunInProgress("codex-forker")).toBe(false);
      expect(mockExecutionStoreInstance.update).toHaveBeenCalledWith("session-123", expect.objectContaining({
        success: false,
        error: "Codex initialization failed: Could not fork the source conversation",
      }));
    });

    // The API validates a fork agent on save through the same resolution.
    it("reports why a source cannot be forked, or null", () => {
      mockResolveForkSource.mockReturnValueOnce({ ok: false, error: "gone" }).mockReturnValueOnce(forkOk);
      expect(executor.forkSourceError("src-session", "codex")).toBe("gone");
      expect(executor.forkSourceError("src-session", "claude")).toBeNull();
      expect(mockResolveForkSource).toHaveBeenCalledWith(launcher, "src-session", "codex");
    });
  });
});
