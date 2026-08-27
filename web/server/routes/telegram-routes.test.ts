import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The manager spawns a real child process on reload/sync — mock it out.
// vi.mock is hoisted above imports, so the mock objects must be hoisted too.
const managerMock = vi.hoisted(() => ({ reload: vi.fn(), sync: vi.fn(), isRunning: vi.fn(() => false) }));
vi.mock("../telegram-bridge-manager.js", () => ({ telegramBridgeManager: managerMock }));

// Control the configured-token state per test via a hoisted holder.
const settingsState = vi.hoisted(() => ({ tokenConfigured: true }));
vi.mock("../settings-manager.js", () => ({
  getSettings: () => ({ telegramBotToken: settingsState.tokenConfigured ? "123:ABC" : "" }),
}));

import { registerTelegramRoutes } from "./telegram-routes.js";
import * as bindings from "../session-telegram-bindings.js";

let app: Hono;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-routes-"));
  bindings._resetForTest(join(dir, "bindings.json"));
  settingsState.tokenConfigured = true;
  managerMock.reload.mockClear();
  managerMock.sync.mockClear();
  app = new Hono();
  registerTelegramRoutes(app);
});

afterEach(() => {
  bindings._resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

const validBody = { groupId: -1003574153485, topicId: 3, allowlist: [172751380], requireMention: true };

describe("GET /telegram/status", () => {
  it("reports token + running state", async () => {
    const res = await app.request("/telegram/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokenConfigured: true, running: false, boundSessionIds: [] });
  });
});

describe("PUT /sessions/:id/telegram", () => {
  it("stores a valid binding and pokes the bridge to reload", async () => {
    const res = await app.request("/sessions/sess-1/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.binding).toMatchObject({ groupId: -1003574153485, topicId: 3, allowlist: [172751380] });
    expect(bindings.getBinding("sess-1")).toBeDefined();
    expect(managerMock.reload).toHaveBeenCalledOnce();
  });

  it("rejects a missing groupId (400) and does not reload", async () => {
    const res = await app.request("/sessions/sess-1/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowlist: [1] }),
    });
    expect(res.status).toBe(400);
    expect(managerMock.reload).not.toHaveBeenCalled();
  });

  it("rejects an empty allowlist (400) — a binding with nobody allowed is useless", async () => {
    const res = await app.request("/sessions/sess-1/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId: -100, allowlist: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET + DELETE /sessions/:id/telegram", () => {
  it("returns the stored binding, then removes it", async () => {
    bindings.setBinding("sess-1", bindings.normalize(validBody)!);

    const get = await app.request("/sessions/sess-1/telegram");
    expect((await get.json()).binding).toMatchObject({ groupId: -1003574153485 });

    const del = await app.request("/sessions/sess-1/telegram", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).removed).toBe(true);
    expect(bindings.getBinding("sess-1")).toBeUndefined();
    expect(managerMock.reload).toHaveBeenCalledOnce();
  });

  it("returns null binding for an unbound session", async () => {
    const res = await app.request("/sessions/unknown/telegram");
    expect((await res.json()).binding).toBeNull();
  });
});

describe("POST /telegram/resolve-username", () => {
  it("400 when no token is configured", async () => {
    settingsState.tokenConfigured = false;
    const res = await app.request("/telegram/resolve-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "@ema" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 when username is missing", async () => {
    const res = await app.request("/telegram/resolve-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
