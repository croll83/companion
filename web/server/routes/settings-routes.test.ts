import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end tests for the settings routes against the REAL settings-manager
// (persisted to a temp file). routes.test.ts mocks settings-manager, which is
// exactly why it never noticed PUT /api/settings rejecting cliBridgeMode
// "stdio": here a PUT must survive validation, hit disk, and come back on GET.
//
// Only collaborators with unrelated side effects are mocked: the Telegram
// bridge manager spawns a child process, Linear connections and Codex auth
// read the user's home directory.
const managerMock = vi.hoisted(() => ({ sync: vi.fn(), reload: vi.fn(), isRunning: vi.fn(() => false) }));
vi.mock("../telegram-bridge-manager.js", () => ({ telegramBridgeManager: managerMock }));
vi.mock("../linear-connections.js", () => ({ listConnections: () => [] }));
vi.mock("../codex-auth-check.js", () => ({ hasCodexAuth: () => false }));

import { registerSettingsRoutes } from "./settings-routes.js";
import { _resetForTest, getSettings } from "../settings-manager.js";
import { CLI_BRIDGE_MODES } from "../cli-bridge-mode.js";

let app: Hono;
let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "settings-routes-"));
  settingsPath = join(dir, "settings.json");
  _resetForTest(settingsPath);
  app = new Hono();
  registerSettingsRoutes(app);
});

afterEach(() => {
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

function putSettings(body: unknown) {
  return app.request("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /settings cliBridgeMode round-trip", () => {
  // Regression: "stdio" (the recommended mode) used to be rejected with 400,
  // so choosing it in Settings silently reverted. It must be accepted, echoed
  // in the PUT response, written to disk, and returned by a later GET.
  it("persists stdio and reads it back via GET", async () => {
    const put = await putSettings({ cliBridgeMode: "stdio" });
    expect(put.status).toBe(200);
    expect((await put.json()).cliBridgeMode).toBe("stdio");

    // Persisted to the settings file, not just held in memory.
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).cliBridgeMode).toBe("stdio");

    const get = await app.request("/settings");
    expect(get.status).toBe(200);
    expect((await get.json()).cliBridgeMode).toBe("stdio");
  });

  // Every mode in the single source-of-truth list must round-trip, so adding
  // a new mode to CLI_BRIDGE_MODES can never be silently rejected by the route.
  // Includes the pre-existing values (backward compatibility).
  it.each(CLI_BRIDGE_MODES)("accepts and round-trips cliBridgeMode=%s", async (mode) => {
    const put = await putSettings({ cliBridgeMode: mode });
    expect(put.status).toBe(200);
    const get = await app.request("/settings");
    expect((await get.json()).cliBridgeMode).toBe(mode);
  });

  // An unknown value is rejected with a 400 whose message lists every valid
  // value (derived from CLI_BRIDGE_MODES), and the stored mode is untouched.
  it("rejects an unknown mode, listing all valid values, without changing the stored mode", async () => {
    await putSettings({ cliBridgeMode: "stdio" });
    const res = await putSettings({ cliBridgeMode: "carrier-pigeon" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    for (const mode of CLI_BRIDGE_MODES) expect(error).toContain(`'${mode}'`);
    expect(getSettings().cliBridgeMode).toBe("stdio");
  });

  // Non-string values are not modes either (guards the type check in the
  // validator, not just the membership check).
  it("rejects a non-string cliBridgeMode", async () => {
    const res = await putSettings({ cliBridgeMode: 42 });
    expect(res.status).toBe(400);
  });

  // A settings file written by an older/newer build with a legacy value that
  // is still valid keeps working: GET reports it as-is.
  it("reads an existing tlsLoopback setting from disk", async () => {
    writeFileSync(settingsPath, JSON.stringify({ cliBridgeMode: "tlsLoopback" }));
    _resetForTest(settingsPath);
    const get = await app.request("/settings");
    expect((await get.json()).cliBridgeMode).toBe("tlsLoopback");
  });
});
