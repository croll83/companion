import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// These tests pin that settings-manager takes its bridge-mode default from
// DEFAULT_CLI_BRIDGE_MODE (cli-bridge-mode.ts) everywhere, instead of a
// hard-coded "loopback" literal. To prove it, the shared default is swapped to
// a non-loopback value: any leftover literal would still yield "loopback".

// Isolated, never-created COMPANION_HOME so the module-level initial settings
// (used before any _resetForTest call) never read the real
// ~/.companion/settings.json. getSettings() does not write, so nothing is
// created there.
vi.mock("./paths.js", async () => {
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  return { COMPANION_HOME: join(tmpdir(), `settings-default-bridge-home-${process.pid}-missing`) };
});

vi.mock("./cli-bridge-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-bridge-mode.js")>();
  return { ...actual, DEFAULT_CLI_BRIDGE_MODE: "stdio" };
});

import { getSettings, _resetForTest } from "./settings-manager.js";

afterAll(() => {
  _resetForTest();
});

describe("settings-manager bridge-mode default", () => {
  // Fresh install, first read: the module-level initial settings object
  // (DEFAULT_SETTINGS) must use the shared default, not a "loopback" literal.
  it("uses DEFAULT_CLI_BRIDGE_MODE for the initial in-memory settings", () => {
    expect(getSettings().cliBridgeMode).toBe("stdio");
  });

  // After a reset with a missing settings file, normalize() must also fall
  // back to the shared default.
  it("uses DEFAULT_CLI_BRIDGE_MODE when normalizing a missing settings file", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-default-bridge-"));
    try {
      _resetForTest(join(dir, "settings.json"));
      expect(getSettings().cliBridgeMode).toBe("stdio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
