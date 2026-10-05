import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The wake-up REST API over a real WakeupScheduler (temp store, fixed time
 * zone, fake clock), so status codes and bodies match what the UI and a
 * session calling the API will see.
 */

vi.mock("../settings-manager.js", () => ({ getSettings: () => ({ timeZone: "UTC" }) }));

import { Hono } from "hono";
import { registerWakeupRoutes } from "./wakeup-routes.js";
import { WakeupScheduler } from "../wakeup-scheduler.js";
import { WakeupStore } from "../wakeup-store.js";
import { _setMcpSecretFileForTest, mcpTokenFor } from "../companion-mcp-auth.js";

let dir: string;
let scheduler: WakeupScheduler;
let app: Hono;

const json = (method: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-05T10:00:00Z") });
  dir = mkdtempSync(join(tmpdir(), "wakeup-routes-test-"));
  scheduler = new WakeupScheduler({
    store: new WakeupStore(dir),
    getSession: (id) => (id === "s1" ? {} : id === "archived" ? { archived: true } : undefined),
    deliver: () => ({ ok: true, delivery: "sent" }),
    isBusy: () => false,
  });
  app = new Hono();
  const api = new Hono();
  registerWakeupRoutes(api, scheduler);
  app.route("/api", api);
});

afterEach(() => {
  scheduler.destroy();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("wake-up routes", () => {
  it("creates, lists and cancels a session's wake-ups", async () => {
    const res = await app.request("/api/sessions/s1/wakeups", json("POST", { message: "check CI", at: "2026-10-05T11:00:00Z" }));
    expect(res.status).toBe(201);
    const { wakeup } = await res.json();
    expect(wakeup).toMatchObject({ sessionId: "s1", message: "check CI", createdBy: "user", status: "pending" });

    const list = await (await app.request("/api/sessions/s1/wakeups")).json();
    expect(list.wakeups.map((w: { id: string }) => w.id)).toEqual([wakeup.id]);
    expect((await (await app.request("/api/sessions/other/wakeups")).json()).wakeups).toEqual([]);

    const del = await app.request(`/api/sessions/s1/wakeups/${wakeup.id}`, json("DELETE"));
    expect(del.status).toBe(200);
    expect((await (await app.request("/api/sessions/s1/wakeups")).json()).wakeups).toEqual([]);
  });

  it("accepts a cron wake-up set by a session", async () => {
    const res = await app.request("/api/sessions/s1/wakeups", json("POST", { message: "standup", cron: "0 9 * * 1-5", createdBy: "session:s1" }));
    expect(res.status).toBe(201);
    expect((await res.json()).wakeup).toMatchObject({ schedule: { cron: "0 9 * * 1-5" }, createdBy: "session:s1" });
  });

  // Errors come back with the scheduler's status and reason.
  it("maps refusals to 400/404/409", async () => {
    const bad = await app.request("/api/sessions/s1/wakeups", json("POST", { message: "x", at: "yesterday" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid one-time date/);

    const noBody = await app.request("/api/sessions/s1/wakeups", { method: "POST", body: "not json" });
    expect(noBody.status).toBe(400);

    expect((await app.request("/api/sessions/gone/wakeups", json("POST", { message: "x", cron: "0 9 * * *" }))).status).toBe(404);
    expect((await app.request("/api/sessions/archived/wakeups", json("POST", { message: "x", cron: "0 9 * * *" }))).status).toBe(409);
    expect((await app.request("/api/sessions/s1/wakeups/wk-missing", json("DELETE"))).status).toBe(404);
  });
});

// Requests from a session's `companion` MCP server (MCP token).
describe("wake-up routes called by a session", () => {
  const SESSIONS: Record<string, { backendType: string; codexSandbox?: string; archived?: boolean }> = {
    full: { backendType: "claude" },
    boxed: { backendType: "codex", codexSandbox: "workspace-write" },
    boxed2: { backendType: "codex", codexSandbox: "workspace-write" },
  };
  let mcpApp: Hono;
  let mcpScheduler: WakeupScheduler;

  beforeEach(() => {
    _setMcpSecretFileForTest(join(dir, "mcp-token.key"));
    mcpScheduler = new WakeupScheduler({
      store: new WakeupStore(join(dir, "mcp-store")),
      getSession: (id) => SESSIONS[id],
      deliver: () => ({ ok: true, delivery: "sent" }),
      isBusy: () => false,
    });
    const api = new Hono();
    registerWakeupRoutes(api, mcpScheduler, (id) => SESSIONS[id]);
    mcpApp = new Hono();
    mcpApp.route("/api", api);
  });

  afterEach(() => {
    mcpScheduler.destroy();
  });

  const as = (caller: string, method: string, body?: unknown) => {
    const init = json(method, body);
    return { ...init, headers: { ...init.headers, Authorization: `Bearer ${mcpTokenFor(caller)}` } };
  };

  // createdBy is the calling session, whatever the body claims.
  it("records the calling session as the creator", async () => {
    const res = await mcpApp.request("/api/sessions/full/wakeups", as("full", "POST", { message: "m", at: "2026-10-05T11:00:00Z", createdBy: "user" }));
    expect(res.status).toBe(201);
    expect((await res.json()).wakeup.createdBy).toBe("session:full");
  });

  // A sandboxed session cannot push messages into (or cancel the plans of)
  // a full-access session; same-level and own-session targets are fine.
  it("keeps sandboxed sessions out of full-access sessions", async () => {
    const denied = await mcpApp.request("/api/sessions/full/wakeups", as("boxed", "POST", { message: "m", cron: "0 9 * * *" }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toMatch(/runs sandboxed/);
    expect((await mcpApp.request("/api/sessions/boxed/wakeups", as("boxed", "POST", { message: "m", cron: "0 9 * * *" }))).status).toBe(201);
    expect((await mcpApp.request("/api/sessions/boxed2/wakeups", as("boxed", "POST", { message: "m", cron: "0 9 * * *" }))).status).toBe(201);
    expect((await mcpApp.request("/api/sessions/boxed/wakeups", as("full", "POST", { message: "m", cron: "0 9 * * *" }))).status).toBe(201);
    // Unknown target: the scheduler's 404, not a permission error.
    expect((await mcpApp.request("/api/sessions/gone/wakeups", as("boxed", "POST", { message: "m", cron: "0 9 * * *" }))).status).toBe(404);

    const created = await mcpApp.request("/api/sessions/full/wakeups", json("POST", { message: "user's", cron: "0 8 * * *" }));
    const { wakeup } = await created.json();
    expect((await mcpApp.request(`/api/sessions/full/wakeups/${wakeup.id}`, as("boxed", "DELETE"))).status).toBe(403);
    expect((await mcpApp.request(`/api/sessions/full/wakeups/${wakeup.id}`, as("full", "DELETE"))).status).toBe(200);
  });
});
