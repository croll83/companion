import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Never touch the real ~/.companion: the default secret path is computed at import.
const h = vi.hoisted(() => ({ home: `${process.env.TMPDIR || "/tmp"}/companion-mcp-auth-${process.pid}-${Date.now()}` }));
vi.mock("./paths.js", () => ({ COMPANION_HOME: h.home }));

import {
  _setMcpSecretFileForTest,
  accessDenied,
  agentAccessLevel,
  isMcpRouteAllowed,
  mcpCallerRefusal,
  isMcpToken,
  mcpCallerOf,
  mcpTokenFor,
  sessionAccessLevel,
  verifyMcpToken,
} from "./companion-mcp-auth.js";

let dir: string;
let secretFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-test-"));
  secretFile = join(dir, "nested", "mcp-token.key");
  _setMcpSecretFileForTest(secretFile);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(h.home, { recursive: true, force: true });
});

describe("MCP session tokens", () => {
  // A token names its session and verifies back to it; the secret is created
  // on first use, private (0600), and reused after a "restart" (cache reset),
  // so CLIs restored from disk keep working.
  it("issues tokens that verify to their session and survive a restart", () => {
    const token = mcpTokenFor("sess-1");
    expect(token).toMatch(/^cmcp_sess-1\.[0-9a-f]{64}$/);
    expect(verifyMcpToken(token)).toBe("sess-1");
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);

    _setMcpSecretFileForTest(secretFile); // forget the cached secret
    expect(verifyMcpToken(token)).toBe("sess-1");
    expect(mcpTokenFor("sess-1")).toBe(token);
  });

  // A token cannot be forged for another session or by editing the session id.
  it("rejects tampered, foreign and malformed tokens", () => {
    const token = mcpTokenFor("sess-1");
    expect(verifyMcpToken(token.replace("sess-1", "sess-2"))).toBeNull();
    const flipped = token.endsWith("0") ? "1" : "0"; // always a different last digit
    expect(verifyMcpToken(`${token.slice(0, -1)}${flipped}`)).toBeNull();
    expect(verifyMcpToken("cmcp_nodot")).toBeNull();
    expect(verifyMcpToken("cmcp_.abc")).toBeNull();
    expect(verifyMcpToken("not-a-token")).toBeNull();
    expect(verifyMcpToken(undefined)).toBeNull();

    // A different secret (another install) invalidates every token.
    writeFileSync(join(dir, "other.key"), "ab".repeat(32));
    _setMcpSecretFileForTest(join(dir, "other.key"));
    expect(verifyMcpToken(token)).toBeNull();
  });

  // A corrupt secret file is replaced rather than used.
  it("regenerates an unreadable secret", () => {
    writeFileSync(join(dir, "bad.key"), "short");
    _setMcpSecretFileForTest(join(dir, "bad.key"));
    const token = mcpTokenFor("s");
    expect(verifyMcpToken(token)).toBe("s");
    expect(readFileSync(join(dir, "bad.key"), "utf-8")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recognises MCP tokens and callers from the Authorization header", () => {
    const token = mcpTokenFor("sess-9");
    expect(isMcpToken(token)).toBe(true);
    expect(isMcpToken("abc")).toBe(false);
    expect(isMcpToken(null)).toBe(false);
    expect(mcpCallerOf(`Bearer ${token}`)).toBe("sess-9");
    expect(mcpCallerOf(token)).toBeNull();
    expect(mcpCallerOf("Bearer some-auth-token")).toBeNull();
    expect(mcpCallerOf(undefined)).toBeNull();
  });

  // The default location is under COMPANION_HOME (mocked to a temp dir here).
  it("defaults to a secret under COMPANION_HOME", async () => {
    vi.resetModules();
    const fresh = await import("./companion-mcp-auth.js");
    expect(fresh.verifyMcpToken(fresh.mcpTokenFor("x"))).toBe("x");
    expect(existsSync(join(h.home, "mcp-token.key"))).toBe(true);
  });
});

describe("MCP route allowlist", () => {
  // Exactly the routes the MCP tools call — nothing else (auth, settings,
  // session control, agent import/export) is reachable with an MCP token.
  it("allows only the tool routes, with or without the /api prefix", () => {
    const allowed: Array<[string, string]> = [
      ["GET", "/api/sessions/s1"],
      ["GET", "/api/sessions/s1/wakeups"],
      ["POST", "/sessions/s1/wakeups"],
      ["DELETE", "/api/sessions/s1/wakeups/wk-1"],
      ["GET", "/api/agents"],
      ["post", "/api/agents"],
      ["GET", "/api/agents/a"],
      ["PUT", "/api/agents/a"],
      ["DELETE", "/api/agents/a"],
      ["POST", "/api/agents/a/run"],
      ["GET", "/api/executions"],
      ["GET", "/api/executions/s1/result"],
    ];
    for (const [method, path] of allowed) expect(isMcpRouteAllowed(method, path, "s1"), `${method} ${path}`).toBe(true);

    const denied: Array<[string, string]> = [
      ["GET", "/api/auth/token"],
      ["POST", "/api/auth/regenerate"],
      ["GET", "/api/settings"],
      ["PUT", "/api/settings"],
      ["POST", "/api/sessions/create"],
      ["DELETE", "/api/sessions/s1"],
      ["POST", "/api/sessions/s1/message"],
      ["POST", "/api/agents/import"],
      ["GET", "/api/agents/a/export"],
      ["POST", "/api/agents/a/regenerate-secret"],
      ["POST", "/api/agents/a/toggle"],
      ["GET", "/api/sessions"],
    ];
    for (const [method, path] of denied) expect(isMcpRouteAllowed(method, path, "s1"), `${method} ${path}`).toBe(false);
  });

  // The full session record (which can hold launch details) and the
  // wake-ups are reachable for the caller's own session only (review
  // finding: any session could read, cancel or inject into the wake-ups of
  // any other session).
  it("limits the session record and the wake-ups to the caller's own session", () => {
    expect(isMcpRouteAllowed("GET", "/api/sessions/s1", "s1")).toBe(true);
    expect(isMcpRouteAllowed("GET", "/api/sessions/s2", "s1")).toBe(false);
    expect(isMcpRouteAllowed("GET", "/api/sessions/s2/wakeups", "s1")).toBe(false);
    expect(isMcpRouteAllowed("POST", "/api/sessions/s2/wakeups", "s1")).toBe(false);
    expect(isMcpRouteAllowed("DELETE", "/api/sessions/s2/wakeups/wk-1", "s1")).toBe(false);
    expect(isMcpRouteAllowed("GET", "/api/sessions/s1/wakeups", "s1")).toBe(true);
  });

  // Sessions restricted to some built-in tools get no companion tools.
  it("refuses tool-restricted sessions", () => {
    expect(mcpCallerRefusal({ tools: ["Read"] })).toMatch(/restricted tool set/);
    expect(mcpCallerRefusal({ tools: [] })).toBeNull();
    expect(mcpCallerRefusal({})).toBeNull();
  });
});

describe("access levels", () => {
  it("treats only workspace-write Codex sessions and agents as sandboxed", () => {
    expect(sessionAccessLevel({ backendType: "claude" })).toBe("full");
    expect(sessionAccessLevel({ backendType: "codex", codexSandbox: "danger-full-access" })).toBe("full");
    expect(sessionAccessLevel({ backendType: "codex", codexSandbox: "workspace-write" })).toBe("sandboxed");
    expect(agentAccessLevel({ backendType: "claude", permissionMode: "default" })).toBe("full");
    expect(agentAccessLevel({ backendType: "codex", permissionMode: "bypassPermissions" })).toBe("full");
    expect(agentAccessLevel({ backendType: "codex", permissionMode: "default" })).toBe("sandboxed");
  });

  // A sandboxed session may not reach anything that runs with full access.
  it("denies only sandboxed callers acting on full-access targets", () => {
    expect(accessDenied("sandboxed", "full", "create an agent")).toMatch(/runs sandboxed.*cannot create an agent that runs with full access/);
    expect(accessDenied("sandboxed", "sandboxed", "x")).toBeNull();
    expect(accessDenied("full", "full", "x")).toBeNull();
    expect(accessDenied("full", "sandboxed", "x")).toBeNull();
  });
});
