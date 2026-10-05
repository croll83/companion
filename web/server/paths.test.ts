import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

describe("paths", () => {
  const originalEnv = process.env.COMPANION_HOME;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.COMPANION_HOME;
    } else {
      process.env.COMPANION_HOME = originalEnv;
    }
  });

  it("defaults to ~/.companion/ when COMPANION_HOME is not set", async () => {
    delete process.env.COMPANION_HOME;
    // Dynamic import to pick up env change (module is already cached, so we
    // test the value computed at import time — which uses the env at startup)
    const { COMPANION_HOME } = await import("./paths.js");
    // When env var is unset at module load time, it should be ~/.companion
    expect(COMPANION_HOME).toBe(join(homedir(), ".companion"));
  });

  it("exports a string path", async () => {
    const { COMPANION_HOME } = await import("./paths.js");
    expect(typeof COMPANION_HOME).toBe("string");
    expect(COMPANION_HOME.length).toBeGreaterThan(0);
  });

  it("legacyStatePath points at ~/.companion only when COMPANION_HOME differs", async () => {
    // Stores that once ignored COMPANION_HOME read their old files from there.
    const { legacyStatePath, LEGACY_COMPANION_HOME } = await import("./paths.js");
    expect(legacyStatePath("auth.json", "/srv/companion")).toBe(join(LEGACY_COMPANION_HOME, "auth.json"));
    expect(legacyStatePath("auth.json", LEGACY_COMPANION_HOME)).toBeNull();
    expect(legacyStatePath("executions", `${LEGACY_COMPANION_HOME}/`)).toBeNull();
  });
});
