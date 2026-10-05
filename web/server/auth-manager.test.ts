import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// networkInterfaces is wrapped (real by default) so the address tests can
// feed controlled interface lists.
const mockInterfaces = vi.hoisted(() => ({ value: null as null | Record<string, unknown[]> }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    networkInterfaces: () => (mockInterfaces.value ?? actual.networkInterfaces()) as ReturnType<typeof actual.networkInterfaces>,
  };
});
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a temp directory so tests don't touch the real ~/.companion/auth.json
const TEST_DIR = join(tmpdir(), `companion-auth-test-${Date.now()}`);
const TEST_AUTH_FILE = join(TEST_DIR, "auth.json");

// Monkey-patch the module's file path before importing
// We test the exported functions indirectly via env var and file manipulation
describe("auth-manager", () => {
  let authManager: typeof import("./auth-manager.js");

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Clear env var
    delete process.env.COMPANION_AUTH_TOKEN;
    // Re-import with fresh module state
    authManager = await import("./auth-manager.js");
    authManager._resetForTest();
  });

  afterEach(() => {
    delete process.env.COMPANION_AUTH_TOKEN;
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("generates a 64-character hex token", () => {
    // getToken should return a valid hex string
    const token = authManager.getToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the same token on repeated calls", () => {
    // Token should be cached after first generation
    const first = authManager.getToken();
    const second = authManager.getToken();
    expect(first).toBe(second);
  });

  it("uses COMPANION_AUTH_TOKEN env var when set", () => {
    // Env var should override any persisted or generated token
    process.env.COMPANION_AUTH_TOKEN = "my-custom-token-123";
    authManager._resetForTest();
    expect(authManager.getToken()).toBe("my-custom-token-123");
  });

  it("verifyToken returns true for correct token", () => {
    const token = authManager.getToken();
    expect(authManager.verifyToken(token)).toBe(true);
  });

  it("verifyToken returns false for incorrect token", () => {
    authManager.getToken(); // ensure token is generated
    expect(authManager.verifyToken("wrong-token")).toBe(false);
  });

  it("verifyToken returns false for null/undefined", () => {
    authManager.getToken();
    expect(authManager.verifyToken(null)).toBe(false);
    expect(authManager.verifyToken(undefined)).toBe(false);
    expect(authManager.verifyToken("")).toBe(false);
  });

  it("verifyToken works with env var token", () => {
    process.env.COMPANION_AUTH_TOKEN = "env-token-abc";
    authManager._resetForTest();
    expect(authManager.verifyToken("env-token-abc")).toBe(true);
    expect(authManager.verifyToken("wrong")).toBe(false);
  });

  it("getLanAddress returns a string", () => {
    // Should return either an IP address or "localhost"
    const addr = authManager.getLanAddress();
    expect(typeof addr).toBe("string");
    expect(addr.length).toBeGreaterThan(0);
  });

  describe("access addresses", () => {
    afterEach(() => {
      mockInterfaces.value = null;
    });

    const iface = (address: string, internal = false, family = "IPv4") => ({ address, internal, family });

    it("lists localhost, the LAN address and the Tailscale (100.64.0.0/10) address", () => {
      // The Tailscale range check is shared with the webhook network guard.
      mockInterfaces.value = {
        lo: [iface("127.0.0.1", true)],
        eth0: [iface("fe80::1", false, "IPv6"), iface("192.168.1.20")],
        tailscale0: [iface("100.101.1.2")],
        cgnatLookalike: [iface("100.200.1.2")],
      };
      expect(authManager.getAllAddresses()).toEqual([
        { label: "Localhost", ip: "localhost" },
        { label: "LAN", ip: "192.168.1.20" },
        { label: "Tailscale", ip: "100.101.1.2" },
      ]);
      expect(authManager.getLanAddress()).toBe("192.168.1.20");
    });

    it("falls back to localhost only when there is no external interface", () => {
      mockInterfaces.value = { lo: [iface("127.0.0.1", true)], empty: undefined as unknown as unknown[] };
      expect(authManager.getAllAddresses()).toEqual([{ label: "Localhost", ip: "localhost" }]);
      expect(authManager.getLanAddress()).toBe("localhost");
    });
  });

  describe("legacy location (pre-COMPANION_HOME ~/.companion/auth.json)", () => {
    afterEach(() => {
      authManager._resetForTest();
    });

    it("reuses the legacy token and copies it (0600) to COMPANION_HOME", () => {
      // Devices logged in with the old token must stay logged in after the
      // move to COMPANION_HOME.
      const legacy = join(TEST_DIR, "legacy-auth.json");
      const current = join(TEST_DIR, "home", "auth.json");
      const token = "a".repeat(64);
      writeFileSync(legacy, JSON.stringify({ token, createdAt: 1 }));
      authManager._resetForTest({ authFile: current, legacyAuthFile: legacy });

      expect(authManager.getToken()).toBe(token);
      expect(JSON.parse(readFileSync(current, "utf-8")).token).toBe(token);
      expect(statSync(current).mode & 0o777).toBe(0o600);
    });

    it("prefers the COMPANION_HOME token over the legacy one", () => {
      const legacy = join(TEST_DIR, "legacy-auth.json");
      const current = join(TEST_DIR, "auth.json");
      writeFileSync(legacy, JSON.stringify({ token: "b".repeat(64) }));
      writeFileSync(current, JSON.stringify({ token: "c".repeat(64) }));
      authManager._resetForTest({ authFile: current, legacyAuthFile: legacy });
      expect(authManager.getToken()).toBe("c".repeat(64));
    });

    it("generates and persists a new token when neither file has a valid one", () => {
      const legacy = join(TEST_DIR, "legacy-auth.json");
      const current = join(TEST_DIR, "fresh", "auth.json");
      writeFileSync(legacy, "{corrupt");
      authManager._resetForTest({ authFile: current, legacyAuthFile: legacy });
      const token = authManager.getToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(readFileSync(current, "utf-8")).token).toBe(token);
      // regenerateToken writes to the same (new) location
      const regenerated = authManager.regenerateToken();
      expect(JSON.parse(readFileSync(current, "utf-8")).token).toBe(regenerated);
    });
  });
});
