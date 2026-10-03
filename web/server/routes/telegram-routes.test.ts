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

describe("GET /telegram/status (bound sessions)", () => {
  it("lists bound session ids and reflects the manager's running state", async () => {
    managerMock.isRunning.mockReturnValueOnce(true);
    bindings.setBinding("sess-a", bindings.normalize(validBody)!);
    settingsState.tokenConfigured = false;
    const res = await app.request("/telegram/status");
    expect(await res.json()).toEqual({ tokenConfigured: false, running: true, boundSessionIds: ["sess-a"] });
  });
});

describe("PUT /sessions/:id/telegram (validation)", () => {
  const put = (body: unknown) =>
    app.request("/sessions/sess-1/telegram", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects a non-numeric topicId", async () => {
    const res = await put({ groupId: -100, topicId: "3", allowlist: [1] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/topicId/);
    expect(managerMock.reload).not.toHaveBeenCalled();
  });

  it("accepts topicId null (DM / non-topic group)", async () => {
    const res = await put({ groupId: -100, topicId: null, allowlist: [1] });
    expect(res.status).toBe(200);
    expect((await res.json()).binding).toMatchObject({ topicId: null, allowlist: [1] });
  });

  it("rejects a non-array allowlist", async () => {
    const res = await put({ groupId: -100, allowlist: 172751380 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/allowlist must be an array/);
  });

  it("rejects an allowlist with only non-numeric ids (normalized to empty)", async () => {
    const res = await put({ groupId: -100, allowlist: ["@ema"] });
    expect(res.status).toBe(400);
    expect(bindings.getBinding("sess-1")).toBeUndefined();
  });

  it("treats a malformed JSON body as missing groupId", async () => {
    const res = await put("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/groupId/);
  });
});

describe("DELETE /sessions/:id/telegram (unbound)", () => {
  it("reports removed=false but still pokes the bridge", async () => {
    const res = await app.request("/sessions/nope/telegram", { method: "DELETE" });
    expect(await res.json()).toEqual({ ok: true, removed: false });
    expect(managerMock.reload).toHaveBeenCalledOnce();
  });
});

describe("POST /telegram/resolve-username (Telegram API)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const resolve = (body: unknown) =>
    app.request("/telegram/resolve-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("prefixes '@' and returns the resolved id + username", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { id: 42, username: "ema" } }) });
    const res = await resolve({ username: "  ema " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, username: "ema" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/getChat");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "@ema" });
  });

  it("keeps an existing '@' and returns username null when absent", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { id: 7 } }) });
    const res = await resolve({ username: "@ema" });
    expect(await res.json()).toEqual({ id: 7, username: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat_id: "@ema" });
  });

  it("404 with Telegram's description when the chat cannot be resolved", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, description: "Bad Request: chat not found" }) });
    const res = await resolve({ username: "ghost" });
    expect(res.status).toBe(404);
    expect((await res.json()).detail).toBe("Bad Request: chat not found");
  });

  it("404 when ok but the id is not numeric", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { id: "x" } }) });
    const res = await resolve({ username: "ema" });
    expect(res.status).toBe(404);
  });

  it("502 when the request to Telegram fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await resolve({ username: "ema" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "network down" });
  });

  it("400 on malformed JSON or a non-string username, without calling Telegram", async () => {
    expect((await resolve("{bad")).status).toBe(400);
    expect((await resolve({ username: 123 })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
