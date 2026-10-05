import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock agent-store module ────────────────────────────────────────────────
// Mocked before imports so every `import` of agent-store gets the mock.
vi.mock("../agent-store.js", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(() => false),
  regenerateWebhookSecret: vi.fn(() => null),
}));

// ─── Mock settings-manager module ──────────────────────────────────────────
vi.mock("../settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    linearOAuthClientId: "",
    linearOAuthClientSecret: "",
    linearOAuthWebhookSecret: "",
    linearOAuthAccessToken: "",
    linearOAuthRefreshToken: "",
  })),
  updateSettings: vi.fn(),
}));

// ─── Mock linear-staging module ──────────────────────────────────────────────
// Mocked so agent creation tests can control staging slot resolution without
// touching the filesystem.
vi.mock("../linear-staging.js", () => ({
  consumeSlot: vi.fn(() => null),
  createSlot: vi.fn(),
  getSlot: vi.fn(() => null),
  updateSlotTokens: vi.fn(() => false),
  deleteSlot: vi.fn(() => false),
  pruneExpired: vi.fn(),
}));

// ─── Mock linear-oauth-connections module ────────────────────────────────────
// Mocked so agent creation tests involving staging slots can control OAuth
// connection creation without touching the filesystem.
vi.mock("../linear-oauth-connections.js", () => ({
  getOAuthConnection: vi.fn(() => null),
  createOAuthConnection: vi.fn((data: Record<string, unknown>) => ({
    id: "mock-oauth-conn-id",
    name: data.name || "Mock OAuth Connection",
    oauthClientId: data.oauthClientId || "",
    oauthClientSecret: data.oauthClientSecret || "",
    webhookSecret: data.webhookSecret || "",
    accessToken: data.accessToken || "",
    refreshToken: data.refreshToken || "",
    status: data.accessToken ? "connected" : "disconnected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })),
  findOAuthConnectionByClientId: vi.fn(() => null),
}));

import { Hono } from "hono";
import * as agentStore from "../agent-store.js";
import { getSettings, updateSettings } from "../settings-manager.js";
import * as staging from "../linear-staging.js";
import type { AgentConfig } from "../agent-types.js";
import { registerAgentRoutes, registerAgentWebhookRoute } from "./agent-routes.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal agent fixture with sensible defaults. Override fields as needed. */
function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    cwd: "/tmp/test",
    prompt: "Do something useful",
    enabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    totalRuns: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

/** Build a mock AgentExecutor with vi.fn() stubs for every method the routes use. */
function createMockExecutor() {
  return {
    getNextRunTime: vi.fn(() => null as Date | null),
    scheduleAgent: vi.fn(),
    stopAgent: vi.fn(),
    executeAgentManually: vi.fn((): { ok: true } | { ok: false; status: 404 | 409; error: string } => ({ ok: true })),
    startRun: vi.fn((): { ok: true } | { ok: false; status: 404 | 409; error: string } => ({ ok: true })),
    isRunInProgress: vi.fn(() => false),
    getScheduleIssue: vi.fn(() => null as string | null),
    getExecutions: vi.fn(() => []),
    listAllExecutions: vi.fn(() => ({ executions: [] as Record<string, unknown>[], total: 0 })),
    forkSourceError: vi.fn((): string | null => null),
  };
}

/**
 * Bun server stand-in passed as Hono's env: the webhook route reads the TCP
 * peer address through `requestIP` and accepts only loopback/tailnet peers.
 */
function peer(address: string) {
  return { requestIP: () => ({ address }) };
}
const LOOPBACK = peer("127.0.0.1");

// ─── Test setup ─────────────────────────────────────────────────────────────

let app: Hono;
let executor: ReturnType<typeof createMockExecutor>;

beforeEach(() => {
  vi.clearAllMocks();

  executor = createMockExecutor();

  // Create a Hono app and mount agent routes under /api
  app = new Hono();
  const api = new Hono();
  registerAgentWebhookRoute(api, executor as any);
  registerAgentRoutes(api, executor as any);
  app.route("/api", api);
});

// ─── GET /api/agents ────────────────────────────────────────────────────────

describe("GET /api/agents", () => {
  it("returns an empty list when no agents exist", async () => {
    vi.mocked(agentStore.listAgents).mockReturnValue([]);

    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it("returns the list of agents enriched with nextRunAt", async () => {
    const agent = makeAgent();
    vi.mocked(agentStore.listAgents).mockReturnValue([agent]);
    const nextRun = new Date("2026-03-01T00:00:00Z");
    executor.getNextRunTime.mockReturnValue(nextRun);

    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("test-agent");
    // nextRunAt should be the epoch ms of the returned Date
    expect(json[0].nextRunAt).toBe(nextRun.getTime());
  });
});

// ─── POST /api/agents ───────────────────────────────────────────────────────

describe("POST /api/agents", () => {
  it("creates an agent and returns 201", async () => {
    const created = makeAgent({ id: "my-agent", name: "My Agent" });
    vi.mocked(agentStore.createAgent).mockReturnValue(created);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Agent", prompt: "Hello" }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("my-agent");
    expect(agentStore.createAgent).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the store throws a validation error", async () => {
    // e.g. missing name
    vi.mocked(agentStore.createAgent).mockImplementation(() => {
      throw new Error("Agent name is required");
    });

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Agent name is required");
  });

  it("schedules the agent when enabled with a schedule trigger", async () => {
    const created = makeAgent({
      enabled: true,
      triggers: {
        schedule: { enabled: true, expression: "*/5 * * * *", recurring: true },
      },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(created);

    await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Scheduled Agent",
        prompt: "Run periodically",
        triggers: { schedule: { enabled: true, expression: "*/5 * * * *", recurring: true } },
      }),
    });

    expect(executor.scheduleAgent).toHaveBeenCalledWith(created);
  });
});

// ─── GET /api/agents/:id ────────────────────────────────────────────────────

describe("GET /api/agents/:id", () => {
  it("returns the agent when it exists", async () => {
    const agent = makeAgent({ id: "existing" });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/existing");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("existing");
  });

  it("returns 404 when the agent does not exist", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Agent not found");
  });

  it("enriches the agent with nextRunAt from the executor", async () => {
    const agent = makeAgent({ id: "scheduled" });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);
    const nextRun = new Date("2026-06-15T12:00:00Z");
    executor.getNextRunTime.mockReturnValue(nextRun);

    const res = await app.request("/api/agents/scheduled");

    const json = await res.json();
    expect(json.nextRunAt).toBe(nextRun.getTime());
  });
});

// ─── PUT /api/agents/:id ────────────────────────────────────────────────────

describe("PUT /api/agents/:id", () => {
  it("updates the agent and returns the updated version", async () => {
    const updated = makeAgent({ id: "test-agent", name: "Updated Name" });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updated);

    const res = await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Name" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("Updated Name");
    // Should only pass editable fields to updateAgent
    expect(agentStore.updateAgent).toHaveBeenCalledWith(
      "test-agent",
      expect.objectContaining({ name: "Updated Name" }),
    );
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.updateAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });

    expect(res.status).toBe(404);
  });

  it("strips non-editable fields from the update payload", async () => {
    // Fields like 'id', 'createdAt', 'totalRuns' should NOT be passed through
    const updated = makeAgent();
    vi.mocked(agentStore.updateAgent).mockReturnValue(updated);

    await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Good Field",
        id: "hacked-id",
        createdAt: 9999,
        totalRuns: 999,
      }),
    });

    const passedUpdates = vi.mocked(agentStore.updateAgent).mock.calls[0][1];
    expect(passedUpdates).toHaveProperty("name", "Good Field");
    // Non-editable fields should be stripped by pickEditable
    expect(passedUpdates).not.toHaveProperty("id");
    expect(passedUpdates).not.toHaveProperty("createdAt");
    expect(passedUpdates).not.toHaveProperty("totalRuns");
  });

  it("reschedules the agent when schedule trigger is enabled", async () => {
    const updated = makeAgent({
      enabled: true,
      triggers: {
        schedule: { enabled: true, expression: "0 * * * *", recurring: true },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updated);

    await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Agent" }),
    });

    expect(executor.scheduleAgent).toHaveBeenCalledWith(updated);
  });

  it("stops the agent schedule when disabled", async () => {
    const updated = makeAgent({ enabled: false });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updated);

    await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(executor.stopAgent).toHaveBeenCalledWith(updated.id);
  });
});

// ─── DELETE /api/agents/:id ─────────────────────────────────────────────────

describe("DELETE /api/agents/:id", () => {
  it("deletes an existing agent and stops its executor", async () => {
    vi.mocked(agentStore.deleteAgent).mockReturnValue(true);

    const res = await app.request("/api/agents/test-agent", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(executor.stopAgent).toHaveBeenCalledWith("test-agent");
    expect(agentStore.deleteAgent).toHaveBeenCalledWith("test-agent");
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.deleteAgent).mockReturnValue(false);

    const res = await app.request("/api/agents/nonexistent", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Agent not found");
  });
});

// ─── POST /api/agents/:id/toggle ───────────────────────────────────────────

describe("POST /api/agents/:id/toggle", () => {
  it("toggles an enabled agent to disabled", async () => {
    const agent = makeAgent({ id: "my-agent", enabled: true });
    const toggled = makeAgent({ id: "my-agent", enabled: false });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);
    vi.mocked(agentStore.updateAgent).mockReturnValue(toggled);

    const res = await app.request("/api/agents/my-agent/toggle", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(false);
    // Should have called updateAgent with enabled: false (opposite of current)
    expect(agentStore.updateAgent).toHaveBeenCalledWith("my-agent", { enabled: false });
    // When toggled off, should stop the agent
    expect(executor.stopAgent).toHaveBeenCalledWith("my-agent");
  });

  it("toggles a disabled agent to enabled and reschedules if schedule trigger active", async () => {
    const agent = makeAgent({ id: "my-agent", enabled: false });
    const toggled = makeAgent({
      id: "my-agent",
      enabled: true,
      triggers: {
        schedule: { enabled: true, expression: "0 * * * *", recurring: true },
      },
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);
    vi.mocked(agentStore.updateAgent).mockReturnValue(toggled);

    const res = await app.request("/api/agents/my-agent/toggle", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(true);
    expect(executor.scheduleAgent).toHaveBeenCalledWith(toggled);
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent/toggle", { method: "POST" });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/agents/:id/run ───────────────────────────────────────────────

describe("POST /api/agents/:id/run", () => {
  it("triggers a manual agent run", async () => {
    const agent = makeAgent({ id: "runner" });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/runner/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Agent triggered");
    expect(executor.executeAgentManually).toHaveBeenCalledWith("runner", undefined);
  });

  it("passes an input string to the executor when provided", async () => {
    const agent = makeAgent({ id: "runner" });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    await app.request("/api/agents/runner/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "custom input" }),
    });

    expect(executor.executeAgentManually).toHaveBeenCalledWith("runner", "custom input");
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/agents/import ────────────────────────────────────────────────

describe("POST /api/agents/import", () => {
  it("imports an agent from exported JSON and returns 201 with enabled=false", async () => {
    // Import should always set enabled to false for safety
    const importedAgent = makeAgent({ id: "imported", name: "Imported Agent", enabled: false });
    vi.mocked(agentStore.createAgent).mockReturnValue(importedAgent);

    const res = await app.request("/api/agents/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Imported Agent",
        prompt: "Do stuff",
        backendType: "claude",
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        cwd: "/tmp",
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.enabled).toBe(false);
    // createAgent should be called with enabled: false (safety)
    expect(agentStore.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("returns 400 when store throws a validation error", async () => {
    vi.mocked(agentStore.createAgent).mockImplementation(() => {
      throw new Error("Agent name is required");
    });

    const res = await app.request("/api/agents/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Agent name is required");
  });

  it("preserves provided import version metadata", async () => {
    // Imported payload version should flow through to createAgent instead of being reset.
    const importedAgent = makeAgent({ id: "imported-v2", name: "Imported V2", enabled: false });
    vi.mocked(agentStore.createAgent).mockReturnValue(importedAgent);

    const res = await app.request("/api/agents/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 2,
        name: "Imported V2",
        prompt: "Do stuff",
        backendType: "claude",
        model: "claude-sonnet-4-6",
        permissionMode: "bypassPermissions",
        cwd: "/tmp",
      }),
    });

    expect(res.status).toBe(201);
    expect(agentStore.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, enabled: false }),
    );
  });
});

// ─── GET /api/agents/:id/export ─────────────────────────────────────────────

describe("GET /api/agents/:id/export", () => {
  it("exports an agent as JSON without internal tracking fields", async () => {
    const agent = makeAgent({
      id: "exportable",
      name: "Exportable Agent",
      totalRuns: 42,
      consecutiveFailures: 2,
      lastRunAt: 3000,
      lastSessionId: "sess-xyz",
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/exportable/export");

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should include portable config fields
    expect(json.name).toBe("Exportable Agent");
    expect(json.prompt).toBe("Do something useful");
    // Should NOT include internal tracking fields
    expect(json).not.toHaveProperty("id");
    expect(json).not.toHaveProperty("createdAt");
    expect(json).not.toHaveProperty("updatedAt");
    expect(json).not.toHaveProperty("totalRuns");
    expect(json).not.toHaveProperty("consecutiveFailures");
    expect(json).not.toHaveProperty("lastRunAt");
    expect(json).not.toHaveProperty("lastSessionId");
    expect(json).not.toHaveProperty("enabled");
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent/export");

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/agents/:id/webhook/:secret ───────────────────────────────────

describe("POST /api/agents/:id/webhook/:secret", () => {
  it("triggers the agent via webhook with a valid secret", async () => {
    const agent = makeAgent({
      id: "webhook-agent",
      triggers: {
        webhook: { enabled: true, secret: "valid-secret-123" },
      },
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/webhook-agent/webhook/valid-secret-123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "webhook payload" }),
    }, LOOPBACK);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toBe("Agent triggered via webhook");
    // A webhook run is recorded as such and goes through the enabled/overlap
    // gate (startRun), not the manual path that skips the enabled check.
    expect(executor.startRun).toHaveBeenCalledWith("webhook-agent", "webhook payload", { triggerType: "webhook" });
    expect(executor.executeAgentManually).not.toHaveBeenCalled();
  });

  it("returns 401 when the webhook secret is invalid", async () => {
    const agent = makeAgent({
      id: "webhook-agent",
      triggers: {
        webhook: { enabled: true, secret: "correct-secret" },
      },
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/webhook-agent/webhook/wrong-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, LOOPBACK);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Invalid webhook secret");
    // Should NOT trigger the agent
    expect(executor.executeAgentManually).not.toHaveBeenCalled();
    expect(executor.startRun).not.toHaveBeenCalled();
  });

  it("returns 403 when the webhook trigger is disabled", async () => {
    const agent = makeAgent({
      id: "webhook-agent",
      triggers: {
        webhook: { enabled: false, secret: "some-secret" },
      },
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/webhook-agent/webhook/some-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, LOOPBACK);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Webhook not enabled for this agent");
    expect(executor.executeAgentManually).not.toHaveBeenCalled();
    expect(executor.startRun).not.toHaveBeenCalled();
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent/webhook/any-secret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, LOOPBACK);

    expect(res.status).toBe(404);
  });

  it("accepts plain text body as webhook input", async () => {
    // The webhook endpoint should also accept plain text (non-JSON) as input
    const agent = makeAgent({
      id: "webhook-agent",
      triggers: {
        webhook: { enabled: true, secret: "valid-secret" },
      },
    });
    vi.mocked(agentStore.getAgent).mockReturnValue(agent);

    const res = await app.request("/api/agents/webhook-agent/webhook/valid-secret", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "plain text input",
    }, LOOPBACK);

    expect(res.status).toBe(200);
    expect(executor.startRun).toHaveBeenCalledWith("webhook-agent", "plain text input", { triggerType: "webhook" });
  });
});

// ─── POST /api/agents — credential staging ─────────────────────────────────

describe("POST /api/agents — Linear credential staging", () => {
  it("copies global OAuth credentials to the agent and clears them from settings when creating a Linear agent", async () => {
    // When a Linear agent is created with no credentials on the agent itself,
    // the route should copy staged credentials from global settings to the agent
    // and then clear them from global settings (one-time staging flow).
    const createdAgent = makeAgent({
      id: "linear-agent",
      name: "Linear Agent",
      triggers: {
        linear: { enabled: true },
      },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // Simulate global settings with staged OAuth credentials
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "client-id-123",
      linearOAuthClientSecret: "client-secret-456",
      linearOAuthWebhookSecret: "webhook-secret-789",
      linearOAuthAccessToken: "access-token-abc",
      linearOAuthRefreshToken: "refresh-token-def",
    } as any);

    // updateAgent returns the agent with credentials merged
    const updatedAgent = makeAgent({
      id: "linear-agent",
      name: "Linear Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "client-id-123",
          oauthClientSecret: "client-secret-456",
          webhookSecret: "webhook-secret-789",
          accessToken: "access-token-abc",
          refreshToken: "refresh-token-def",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Linear Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();

    // updateAgent should have been called to copy credentials to the agent
    expect(agentStore.updateAgent).toHaveBeenCalledWith("linear-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "client-id-123",
          oauthClientSecret: "client-secret-456",
          webhookSecret: "webhook-secret-789",
          accessToken: "access-token-abc",
          refreshToken: "refresh-token-def",
        },
      },
    });

    // Global settings should have been cleared after staging
    expect(updateSettings).toHaveBeenCalledWith({
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    });

    // The response should have the sanitized agent (secrets stripped, boolean flags present)
    expect(json).not.toHaveProperty("triggers.linear.oauthClientSecret");
    expect(json).not.toHaveProperty("triggers.linear.accessToken");
    expect(json).not.toHaveProperty("triggers.linear.refreshToken");
    expect(json).not.toHaveProperty("triggers.linear.webhookSecret");
    expect(json.triggers.linear.hasAccessToken).toBe(true);
    expect(json.triggers.linear.hasClientSecret).toBe(true);
    expect(json.triggers.linear.hasWebhookSecret).toBe(true);
  });

  it("does not stage credentials when global settings have no linearOAuthClientId", async () => {
    // When the global settings have no staged OAuth client ID, the normal creation
    // flow should proceed without any credential copying or settings clearing.
    const createdAgent = makeAgent({
      id: "linear-agent-no-creds",
      name: "Linear Agent No Creds",
      triggers: {
        linear: { enabled: true },
      },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // Global settings have no staged credentials (empty strings)
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "",
      linearOAuthClientSecret: "",
      linearOAuthWebhookSecret: "",
      linearOAuthAccessToken: "",
      linearOAuthRefreshToken: "",
    } as any);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Linear Agent No Creds",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
      }),
    });

    expect(res.status).toBe(201);
    // updateAgent should NOT have been called for credential staging
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
    // updateSettings should NOT have been called to clear staging creds
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("does NOT clear global settings when updateAgent fails during credential staging", async () => {
    // If updateAgent returns null (store failure), the global OAuth credentials
    // must NOT be cleared — otherwise the user's credentials are silently lost.
    const createdAgent = makeAgent({
      id: "linear-fail",
      name: "Linear Fail",
      triggers: {
        linear: { enabled: true },
      },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "client-id-staged",
      linearOAuthClientSecret: "secret-staged",
      linearOAuthWebhookSecret: "webhook-staged",
      linearOAuthAccessToken: "access-staged",
      linearOAuthRefreshToken: "refresh-staged",
    } as any);

    // Simulate updateAgent failure (returns null)
    vi.mocked(agentStore.updateAgent).mockReturnValue(null);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Linear Fail",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
      }),
    });

    expect(res.status).toBe(201);
    // updateAgent was called (to try to copy creds) but returned null
    expect(agentStore.updateAgent).toHaveBeenCalled();
    // updateSettings must NOT have been called — creds are preserved for retry
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// ─── POST /api/agents — Priority 1: staging slot ────────────────────────────

describe("POST /api/agents — Priority 1: staging slot (stagingId)", () => {
  it("resolves Linear credentials from a staging slot when stagingId is provided", async () => {
    // When the request body includes a stagingId, the route should call
    // staging.consumeSlot() to retrieve and delete the one-time slot,
    // then create an OAuth connection from the slot's credentials and
    // store oauthConnectionId on the agent (new model).
    const { createOAuthConnection } = await import("../linear-oauth-connections.js");

    const createdAgent = makeAgent({
      id: "staged-agent",
      name: "Staged Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // Simulate a valid staging slot returned by consumeSlot
    vi.mocked(staging.consumeSlot).mockReturnValue({
      id: "abc123def456abc123def456abc123de",
      clientId: "slot-client-id",
      clientSecret: "slot-client-secret",
      webhookSecret: "slot-webhook-secret",
      accessToken: "slot-access-token",
      refreshToken: "slot-refresh-token",
      createdAt: Date.now(),
    });

    // updateAgent returns the agent with oauthConnectionId
    const updatedAgent = makeAgent({
      id: "staged-agent",
      name: "Staged Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthConnectionId: "mock-oauth-conn-id",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Staged Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
        stagingId: "abc123def456abc123def456abc123de",
      }),
    });

    expect(res.status).toBe(201);

    // consumeSlot should have been called with the provided stagingId
    expect(staging.consumeSlot).toHaveBeenCalledWith("abc123def456abc123def456abc123de");

    // createOAuthConnection should have been called with the slot's credentials
    expect(createOAuthConnection).toHaveBeenCalledWith(expect.objectContaining({
      name: "Staged Agent OAuth App",
      oauthClientId: "slot-client-id",
      oauthClientSecret: "slot-client-secret",
      webhookSecret: "slot-webhook-secret",
      accessToken: "slot-access-token",
      refreshToken: "slot-refresh-token",
    }));

    // updateAgent should have been called with oauthConnectionId reference
    expect(agentStore.updateAgent).toHaveBeenCalledWith("staged-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthConnectionId: "mock-oauth-conn-id",
        },
      },
    });

    // Global settings should NOT be cleared when using a staging slot
    expect(updateSettings).not.toHaveBeenCalled();

    // Response should have oauthConnectionId and sanitized credentials
    const json = await res.json();
    expect(json.triggers.linear.oauthConnectionId).toBe("mock-oauth-conn-id");
    expect(json.triggers.linear).not.toHaveProperty("accessToken");
    expect(json.triggers.linear).not.toHaveProperty("refreshToken");
    expect(json.triggers.linear).not.toHaveProperty("webhookSecret");
  });

  it("falls through to global staging when stagingId points to a missing/expired slot", async () => {
    // When consumeSlot returns null (slot not found or expired), the route should
    // skip Priority 1 and fall through. Since no cloneFromAgentId is provided either,
    // it should reach Priority 3 (global staging) and use those credentials.
    const createdAgent = makeAgent({
      id: "fallthrough-agent",
      name: "Fallthrough Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // consumeSlot returns null — slot is missing or expired
    vi.mocked(staging.consumeSlot).mockReturnValue(null);

    // Global settings have staged credentials (Priority 3 fallback)
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "global-client-id",
      linearOAuthClientSecret: "global-client-secret",
      linearOAuthWebhookSecret: "global-webhook-secret",
      linearOAuthAccessToken: "global-access-token",
      linearOAuthRefreshToken: "global-refresh-token",
    } as any);

    const updatedAgent = makeAgent({
      id: "fallthrough-agent",
      name: "Fallthrough Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fallthrough Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
        stagingId: "expired00000000000000000000000000",
      }),
    });

    expect(res.status).toBe(201);

    // consumeSlot was called but returned null
    expect(staging.consumeSlot).toHaveBeenCalledWith("expired00000000000000000000000000");

    // Since stagingId was provided (even though it failed), global settings
    // should NOT be cleared — the clearing logic only runs when neither
    // stagingId nor cloneFromAgentId was in the request body.
    // However, the global credentials should still be used for the agent.
    expect(agentStore.updateAgent).toHaveBeenCalledWith("fallthrough-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });

    // Global settings should NOT be cleared because body.stagingId was present
    // (the route only clears when !body.stagingId && !body.cloneFromAgentId)
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// ─── POST /api/agents — Priority 2: clone from existing agent ───────────────

describe("POST /api/agents — Priority 2: clone from existing agent (cloneFromAgentId)", () => {
  it("clones Linear credentials from an existing agent when cloneFromAgentId is provided", async () => {
    // When the request body includes cloneFromAgentId (and no stagingId), the route
    // should look up the source agent and copy its Linear OAuth credentials.
    const createdAgent = makeAgent({
      id: "cloned-agent",
      name: "Cloned Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // The source agent has Linear credentials to clone
    const sourceAgent = makeAgent({
      id: "source-agent",
      name: "Source Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "source-client-id",
          oauthClientSecret: "source-client-secret",
          webhookSecret: "source-webhook-secret",
          accessToken: "source-access-token",
          refreshToken: "source-refresh-token",
        },
      },
    });

    // getAgent is called twice: once internally by the route for the source lookup.
    // We need it to return the source agent when called with "source-agent".
    vi.mocked(agentStore.getAgent).mockImplementation((id: string) => {
      if (id === "source-agent") return sourceAgent;
      return null;
    });

    // updateAgent returns the agent with cloned credentials
    const updatedAgent = makeAgent({
      id: "cloned-agent",
      name: "Cloned Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "source-client-id",
          oauthClientSecret: "source-client-secret",
          webhookSecret: "source-webhook-secret",
          accessToken: "source-access-token",
          refreshToken: "source-refresh-token",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cloned Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
        cloneFromAgentId: "source-agent",
      }),
    });

    expect(res.status).toBe(201);

    // consumeSlot should NOT have been called (no stagingId in the request)
    expect(staging.consumeSlot).not.toHaveBeenCalled();

    // getAgent should have been called with the source agent ID to look up credentials
    expect(agentStore.getAgent).toHaveBeenCalledWith("source-agent");

    // updateAgent should have been called with the cloned credentials
    expect(agentStore.updateAgent).toHaveBeenCalledWith("cloned-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "source-client-id",
          oauthClientSecret: "source-client-secret",
          webhookSecret: "source-webhook-secret",
          accessToken: "source-access-token",
          refreshToken: "source-refresh-token",
        },
      },
    });

    // Global settings should NOT be cleared when cloning from an agent
    expect(updateSettings).not.toHaveBeenCalled();

    // Response should have sanitized credentials
    const json = await res.json();
    expect(json.triggers.linear.hasAccessToken).toBe(true);
    expect(json.triggers.linear.hasClientSecret).toBe(true);
    expect(json.triggers.linear.hasWebhookSecret).toBe(true);
    expect(json.triggers.linear).not.toHaveProperty("oauthClientSecret");
    expect(json.triggers.linear).not.toHaveProperty("accessToken");
  });

  it("falls through to global staging when cloneFromAgentId points to a non-existent agent", async () => {
    // When the source agent doesn't exist, getAgent returns null, so the clone
    // path is skipped and the route falls through to Priority 3 (global staging).
    const createdAgent = makeAgent({
      id: "clone-fallthrough-agent",
      name: "Clone Fallthrough Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // getAgent returns null for the non-existent source agent
    vi.mocked(agentStore.getAgent).mockReturnValue(null);

    // Global settings have staged credentials (Priority 3 fallback)
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "global-client-id",
      linearOAuthClientSecret: "global-client-secret",
      linearOAuthWebhookSecret: "global-webhook-secret",
      linearOAuthAccessToken: "global-access-token",
      linearOAuthRefreshToken: "global-refresh-token",
    } as any);

    const updatedAgent = makeAgent({
      id: "clone-fallthrough-agent",
      name: "Clone Fallthrough Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Clone Fallthrough Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
        cloneFromAgentId: "nonexistent-agent",
      }),
    });

    expect(res.status).toBe(201);

    // getAgent should have been called to look up the (non-existent) source agent
    expect(agentStore.getAgent).toHaveBeenCalledWith("nonexistent-agent");

    // updateAgent should have been called with global credentials (Priority 3 fallback)
    expect(agentStore.updateAgent).toHaveBeenCalledWith("clone-fallthrough-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });

    // Global settings should NOT be cleared because body.cloneFromAgentId was present
    // (the route only clears when !body.stagingId && !body.cloneFromAgentId)
    expect(updateSettings).not.toHaveBeenCalled();

    // Response should have sanitized credentials
    const json = await res.json();
    expect(json.triggers.linear.hasAccessToken).toBe(true);
    expect(json.triggers.linear.hasClientSecret).toBe(true);
  });

  it("falls through to global staging when source agent exists but has no Linear credentials", async () => {
    // Edge case: the source agent exists but has no oauthClientId on its Linear trigger,
    // so the clone condition (source?.triggers?.linear?.oauthClientId) is falsy.
    const createdAgent = makeAgent({
      id: "clone-no-creds-agent",
      name: "Clone No Creds Agent",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.createAgent).mockReturnValue(createdAgent);

    // Source agent exists but has no Linear credentials
    const sourceAgentNoCreds = makeAgent({
      id: "source-no-creds",
      name: "Source No Creds",
      triggers: { linear: { enabled: true } },
    });
    vi.mocked(agentStore.getAgent).mockImplementation((id: string) => {
      if (id === "source-no-creds") return sourceAgentNoCreds;
      return null;
    });

    // Global settings have staged credentials (Priority 3 fallback)
    vi.mocked(getSettings).mockReturnValue({
      linearOAuthClientId: "global-client-id",
      linearOAuthClientSecret: "global-client-secret",
      linearOAuthWebhookSecret: "global-webhook-secret",
      linearOAuthAccessToken: "global-access-token",
      linearOAuthRefreshToken: "global-refresh-token",
    } as any);

    const updatedAgent = makeAgent({
      id: "clone-no-creds-agent",
      name: "Clone No Creds Agent",
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });
    vi.mocked(agentStore.updateAgent).mockReturnValue(updatedAgent);

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Clone No Creds Agent",
        prompt: "Handle linear issues",
        triggers: { linear: { enabled: true } },
        cloneFromAgentId: "source-no-creds",
      }),
    });

    expect(res.status).toBe(201);

    // The route looked up the source agent
    expect(agentStore.getAgent).toHaveBeenCalledWith("source-no-creds");

    // updateAgent should use global credentials since clone source had none
    expect(agentStore.updateAgent).toHaveBeenCalledWith("clone-no-creds-agent", {
      triggers: {
        linear: {
          enabled: true,
          oauthClientId: "global-client-id",
          oauthClientSecret: "global-client-secret",
          webhookSecret: "global-webhook-secret",
          accessToken: "global-access-token",
          refreshToken: "global-refresh-token",
        },
      },
    });

    // Global settings should NOT be cleared because body.cloneFromAgentId was present
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// ─── GET /api/executions ────────────────────────────────────────────────────

describe("GET /api/executions", () => {
  it("passes query parameters as filters to agentExecutor.listAllExecutions", async () => {
    // The /executions endpoint parses agentId, triggerType, status, limit, offset
    // from query params and passes them to the executor's listAllExecutions method.
    const mockResult = {
      executions: [{ sessionId: "s1", agentId: "a1", triggerType: "manual", startedAt: 100 }],
      total: 1,
    };
    executor.listAllExecutions.mockReturnValue(mockResult);

    const res = await app.request(
      "/api/executions?agentId=a1&triggerType=manual&status=success&limit=10&offset=5",
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(mockResult);
    expect(executor.listAllExecutions).toHaveBeenCalledWith({
      agentId: "a1",
      triggerType: "manual",
      status: "success",
      limit: 10,
      offset: 5,
    });
  });

  it("uses default limit and offset when not provided, and ignores invalid status", async () => {
    // When no limit/offset are provided, defaults should be limit=50 and offset=0.
    // An invalid status value (not "running", "success", or "error") should be undefined.
    executor.listAllExecutions.mockReturnValue({ executions: [], total: 0 });

    const res = await app.request("/api/executions?status=invalid");

    expect(res.status).toBe(200);
    expect(executor.listAllExecutions).toHaveBeenCalledWith({
      agentId: undefined,
      triggerType: undefined,
      status: undefined,
      limit: 50,
      offset: 0,
    });
  });

  it("clamps limit to the range [1, 500]", async () => {
    // Limit is computed as Math.min(Math.max(Number(query) || 50, 1), 500).
    // Values above 500 are clamped down; 0 and NaN fall back to 50 via the || operator.
    executor.listAllExecutions.mockReturnValue({ executions: [], total: 0 });

    // Test upper bound: 9999 should become 500
    await app.request("/api/executions?limit=9999");
    expect(executor.listAllExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );

    executor.listAllExecutions.mockClear();

    // Test that 0 is treated as falsy and defaults to 50 (via || 50)
    await app.request("/api/executions?limit=0");
    expect(executor.listAllExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );

    executor.listAllExecutions.mockClear();

    // Test that a non-numeric value defaults to 50
    await app.request("/api/executions?limit=abc");
    expect(executor.listAllExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns empty result when no executor is available", async () => {
    // If agentExecutor is undefined, the route should return a fallback empty result.
    // We test this by creating a separate app with no executor.
    const appNoExecutor = new Hono();
    const apiNoExecutor = new Hono();
    registerAgentRoutes(apiNoExecutor, undefined);
    appNoExecutor.route("/api", apiNoExecutor);

    const res = await appNoExecutor.request("/api/executions");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ executions: [], total: 0 });
  });
});

// ─── POST /api/agents/:id/regenerate-secret ─────────────────────────────────

describe("POST /api/agents/:id/regenerate-secret", () => {
  it("regenerates the webhook secret and returns the sanitized agent", async () => {
    // The regenerate-secret endpoint calls agentStore.regenerateWebhookSecret
    // and returns the agent with sensitive Linear fields stripped.
    const agentWithNewSecret = makeAgent({
      id: "regen-agent",
      triggers: {
        webhook: { enabled: true, secret: "new-secret-xyz" },
        linear: {
          enabled: true,
          oauthClientId: "cid",
          oauthClientSecret: "csecret",
          webhookSecret: "ws",
          accessToken: "at",
          refreshToken: "rt",
        },
      },
    });
    vi.mocked(agentStore.regenerateWebhookSecret).mockReturnValue(agentWithNewSecret);

    const res = await app.request("/api/agents/regen-agent/regenerate-secret", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(agentStore.regenerateWebhookSecret).toHaveBeenCalledWith("regen-agent");
    const json = await res.json();
    expect(json.id).toBe("regen-agent");
    // Sanitize should strip Linear OAuth secrets and add boolean flags
    expect(json.triggers.linear.hasAccessToken).toBe(true);
    expect(json.triggers.linear.hasClientSecret).toBe(true);
    expect(json.triggers.linear.hasWebhookSecret).toBe(true);
    expect(json.triggers.linear).not.toHaveProperty("oauthClientSecret");
    expect(json.triggers.linear).not.toHaveProperty("accessToken");
    expect(json.triggers.linear).not.toHaveProperty("refreshToken");
    expect(json.triggers.linear).not.toHaveProperty("webhookSecret");
  });

  it("returns 404 when agent does not exist", async () => {
    vi.mocked(agentStore.regenerateWebhookSecret).mockReturnValue(null);

    const res = await app.request("/api/agents/nonexistent/regenerate-secret", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Agent not found");
  });
});

// ─── Webhook trigger: network origin, gate, limits ──────────────────────────

describe("POST /api/agents/:id/webhook/:secret — network and run rules", () => {
  const hookAgent = () => makeAgent({
    id: "hook",
    triggers: { webhook: { enabled: true, secret: "s3cret" } },
  });
  const call = (env: object | undefined, init: RequestInit = {}) =>
    app.request("/api/agents/hook/webhook/s3cret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x" }),
      ...init,
    }, env);

  beforeEach(() => {
    vi.mocked(agentStore.getAgent).mockReturnValue(hookAgent());
  });

  it("rejects callers from the internet with 403, even with the right secret", async () => {
    // The secret alone must never expose a run trigger to the internet.
    const res = await call(peer("203.0.113.7"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/only from this machine or the tailnet/);
    expect(executor.startRun).not.toHaveBeenCalled();
  });

  it("rejects requests whose peer address is unknown", async () => {
    // No Bun server (no requestIP): fail closed.
    const res = await call(undefined);
    expect(res.status).toBe(403);
  });

  it("accepts Tailscale IPv4 and IPv6 peers", async () => {
    expect((await call(peer("100.101.102.103"))).status).toBe(200);
    expect((await call(peer("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240"))).status).toBe(200);
    expect(executor.startRun).toHaveBeenCalledTimes(2);
  });

  it("judges a request relayed by a local proxy by its forwarded client address", async () => {
    // cloudflared/nginx on this host connect from loopback: the forwarded
    // address is the real caller.
    const fromInternet = await call(LOOPBACK, { headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.4" } });
    expect(fromInternet.status).toBe(403);
    const fromTailnet = await call(LOOPBACK, { headers: { "Content-Type": "application/json", "X-Forwarded-For": "100.64.0.9" } });
    expect(fromTailnet.status).toBe(200);
  });

  it("returns 409 with the reason when the agent is disabled or already running", async () => {
    executor.startRun.mockReturnValueOnce({ ok: false, status: 409, error: 'A run of agent "Hook" is still in progress' });
    const res = await call(LOOPBACK);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('A run of agent "Hook" is still in progress');
  });

  it("rate-limits each agent to 10 calls a minute with Retry-After", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call(LOOPBACK)).status).toBe(200);
    }
    const limited = await call(LOOPBACK);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(executor.startRun).toHaveBeenCalledTimes(10);
  });

  it("rejects bodies over 256 KB with 413", async () => {
    const res = await call(LOOPBACK, {
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(256 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(executor.startRun).not.toHaveBeenCalled();
  });

  it("passes no input for a JSON body without input or with invalid JSON", async () => {
    await call(LOOPBACK, { body: JSON.stringify({ other: 1 }) });
    await call(LOOPBACK, { body: "{not json" });
    expect(executor.startRun).toHaveBeenNthCalledWith(1, "hook", undefined, { triggerType: "webhook" });
    expect(executor.startRun).toHaveBeenNthCalledWith(2, "hook", undefined, { triggerType: "webhook" });
  });

  it("is answered before an auth middleware registered after it", async () => {
    // routes.ts registers the webhook before api.use("/*", auth): the secret
    // is the only credential, while every other agent route stays protected.
    const guarded = new Hono();
    const inner = new Hono();
    registerAgentWebhookRoute(inner, executor as any);
    inner.use("/*", async (c) => c.json({ error: "unauthorized" }, 401));
    registerAgentRoutes(inner, executor as any);
    guarded.route("/api", inner);

    const hook = await guarded.request("/api/agents/hook/webhook/s3cret", { method: "POST", body: "" }, LOOPBACK);
    expect(hook.status).toBe(200);
    const list = await guarded.request("/api/agents", {}, LOOPBACK);
    expect(list.status).toBe(401);
  });
});

// ─── Validation of schedules and allowed tools ──────────────────────────────

describe("agent validation", () => {
  const post = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const schedule = (expression: string, recurring = true) => ({
    schedule: { enabled: true, expression, recurring },
  });

  it("rejects an invalid cron expression on create with a clear 400", async () => {
    const res = await post("/api/agents", { name: "A", prompt: "p", triggers: schedule("61 * * * *") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Invalid cron expression "61 \* \* \* \*"/);
    expect(agentStore.createAgent).not.toHaveBeenCalled();
  });

  it("rejects a cron expression with a seconds field", async () => {
    const res = await post("/api/agents", { name: "A", prompt: "p", triggers: schedule("0 0 8 * * *") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/a seconds field is not supported/);
  });

  it("rejects a one-time date in the past on create", async () => {
    const res = await post("/api/agents", { name: "A", prompt: "p", triggers: schedule("2020-01-01T08:00", false) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/is in the past/);
  });

  it("rejects an invalid schedule on update without touching the agent", async () => {
    const res = await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggers: schedule("every day") }),
    });
    expect(res.status).toBe(400);
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  it("does not validate a disabled schedule", async () => {
    vi.mocked(agentStore.createAgent).mockReturnValue(makeAgent());
    const res = await post("/api/agents", {
      name: "A", prompt: "p",
      triggers: { schedule: { enabled: false, expression: "garbage", recurring: true } },
    });
    expect(res.status).toBe(201);
  });

  it("rejects allowedTools entries --tools cannot take", async () => {
    const res = await post("/api/agents", { name: "A", prompt: "p", allowedTools: ["Read", "Bash(rm *)"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid tool name "Bash\(rm \*\)"/);
    const notArray = await post("/api/agents", { name: "A", prompt: "p", allowedTools: "Read" });
    expect(notArray.status).toBe(400);
  });

  it("import accepts a past one-time date (agent starts disabled) but not an invalid cron", async () => {
    vi.mocked(agentStore.createAgent).mockReturnValue(makeAgent({ enabled: false }));
    const past = await post("/api/agents/import", { name: "A", prompt: "p", triggers: schedule("2020-01-01T08:00", false) });
    expect(past.status).toBe(201);
    const bad = await post("/api/agents/import", { name: "B", prompt: "p", triggers: schedule("* * *") });
    expect(bad.status).toBe(400);
  });

  // Context modes: a "fork" agent must name a session it can actually fork
  // (same backend, transcript on disk) — checked on save so the user learns
  // it in the editor rather than from a failed run later.
  it("validates the context mode and the fork source on create", async () => {
    vi.mocked(agentStore.createAgent).mockReturnValue(makeAgent());

    const badMode = await post("/api/agents", { name: "A", prompt: "p", contextMode: "clone" });
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).error).toMatch(/contextMode must be "brief" or "fork"/);

    const noSource = await post("/api/agents", { name: "A", prompt: "p", contextMode: "fork" });
    expect(noSource.status).toBe(400);
    expect((await noSource.json()).error).toMatch(/needs a sourceSessionId/);

    const badSource = await post("/api/agents", { name: "A", prompt: "p", contextMode: "fork", sourceSessionId: 42 });
    expect(badSource.status).toBe(400);

    executor.forkSourceError.mockReturnValueOnce("Source session s1 is a Codex session; a Claude Code agent cannot fork it");
    const wrongBackend = await post("/api/agents", { name: "A", prompt: "p", contextMode: "fork", sourceSessionId: "s1" });
    expect(wrongBackend.status).toBe(400);
    expect((await wrongBackend.json()).error).toMatch(/cannot fork it/);
    expect(executor.forkSourceError).toHaveBeenCalledWith("s1", "claude");
    expect(agentStore.createAgent).not.toHaveBeenCalled();

    const ok = await post("/api/agents", { name: "A", prompt: "p", contextMode: "fork", sourceSessionId: "s1" });
    expect(ok.status).toBe(201);
    expect(vi.mocked(agentStore.createAgent).mock.calls[0][0]).toMatchObject({ contextMode: "fork", sourceSessionId: "s1" });
  });

  // An update is checked against the agent as it will be saved: switching
  // the backend of a fork agent re-checks its source with the new backend.
  it("checks the fork source of the saved agent on update", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(makeAgent({ contextMode: "fork", sourceSessionId: "s1" }));
    executor.forkSourceError.mockReturnValueOnce("wrong backend");

    const res = await app.request("/api/agents/test-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backendType: "codex" }),
    });

    expect(res.status).toBe(400);
    expect(executor.forkSourceError).toHaveBeenCalledWith("s1", "codex");
    expect(agentStore.updateAgent).not.toHaveBeenCalled();
  });

  // Import does not require the source to exist on this machine (the agent
  // starts disabled and a run reports the problem), but the shape is checked.
  it("imports a fork agent without checking that its source exists here", async () => {
    vi.mocked(agentStore.createAgent).mockReturnValue(makeAgent({ enabled: false }));
    const res = await post("/api/agents/import", { name: "A", prompt: "p", contextMode: "fork", sourceSessionId: "elsewhere" });
    expect(res.status).toBe(201);
    expect(executor.forkSourceError).not.toHaveBeenCalled();
  });

  it("ignores the removed skills/branch/createBranch/useWorktree fields on create and import", async () => {
    vi.mocked(agentStore.createAgent).mockReturnValue(makeAgent());
    const legacy = { skills: ["s"], branch: "main", createBranch: true, useWorktree: true };
    await post("/api/agents", { name: "A", prompt: "p", ...legacy });
    await post("/api/agents/import", { name: "B", prompt: "p", ...legacy });
    for (const [input] of vi.mocked(agentStore.createAgent).mock.calls) {
      for (const field of Object.keys(legacy)) expect(input).not.toHaveProperty(field);
    }
  });
});

// ─── Live run state and manual run refusal ──────────────────────────────────

describe("agent run state", () => {
  it("lists agents with running and scheduleError from the executor", async () => {
    vi.mocked(agentStore.listAgents).mockReturnValue([makeAgent({ id: "busy" })]);
    executor.isRunInProgress.mockReturnValue(true);
    executor.getScheduleIssue.mockReturnValue("One-time run at 2020-01-01T08:00 did not run: that time has passed");

    const json = await (await app.request("/api/agents")).json();

    expect(json[0].running).toBe(true);
    expect(json[0].scheduleError).toMatch(/did not run/);
  });

  it("returns 409 from Run now while a run is still in progress", async () => {
    vi.mocked(agentStore.getAgent).mockReturnValue(makeAgent({ id: "busy" }));
    executor.executeAgentManually.mockReturnValueOnce({ ok: false, status: 409, error: "still in progress" });

    const res = await app.request("/api/agents/busy/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("still in progress");
  });
});
