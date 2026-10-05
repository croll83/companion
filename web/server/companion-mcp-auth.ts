import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

/**
 * Credentials and rules for the built-in `companion` MCP server
 * (server/mcp/companion-mcp.ts), which every Claude Code / Codex session gets.
 *
 * The MCP server calls Companion's REST API with a per-session token,
 * `cmcp_<sessionId>.<hmac>`, instead of Companion's own auth token, so:
 *  - Companion's auth token never has to reach a CLI's environment;
 *  - the API knows WHICH session is calling (createdBy, caps, "this session")
 *    without trusting anything the model puts in a request body;
 *  - the token opens only the few routes the MCP tools use.
 *
 * Tokens are HMACs of the session id under a random secret kept in
 * COMPANION_HOME (0600), so they survive server restarts (a CLI restored
 * from disk keeps working) and nothing per-token has to be stored.
 */

const TOKEN_PREFIX = "cmcp_";
const SECRET_BYTES = 32;

let secretFile = join(COMPANION_HOME, "mcp-token.key");
let cachedSecret: Buffer | null = null;

function loadSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  try {
    const hex = readFileSync(secretFile, "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) {
      cachedSecret = Buffer.from(hex, "hex");
      return cachedSecret;
    }
  } catch {
    /* absent: generate below */
  }
  const secret = randomBytes(SECRET_BYTES);
  try {
    mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
    writeFileSync(secretFile, secret.toString("hex"), { mode: 0o600 });
    chmodSync(secretFile, 0o600);
  } catch (err) {
    // Still usable for this process; tokens just won't survive a restart.
    console.warn("[companion-mcp] Could not persist the MCP token secret:", err);
  }
  cachedSecret = secret;
  return secret;
}

function sign(sessionId: string): string {
  return createHmac("sha256", loadSecret()).update(`companion-mcp:${sessionId}`).digest("hex");
}

/** The token the `companion` MCP server of `sessionId` authenticates with. */
export function mcpTokenFor(sessionId: string): string {
  return `${TOKEN_PREFIX}${sessionId}.${sign(sessionId)}`;
}

/** True when a bearer token is shaped like an MCP session token (valid or not). */
export function isMcpToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.startsWith(TOKEN_PREFIX);
}

/** The session an MCP token was issued to, or null if it is not a valid one. */
export function verifyMcpToken(token: string | null | undefined): string | null {
  if (!isMcpToken(token)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(sign(sessionId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return sessionId;
}

/** The calling session of a request carrying `Authorization: Bearer cmcp_…`, or null. */
export function mcpCallerOf(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  return verifyMcpToken(authorizationHeader.slice(7));
}

/** Routes (relative to /api) an MCP session token may call: exactly what the tools use. */
const MCP_ROUTES: Array<[method: string, pattern: RegExp]> = [
  ["GET", /^\/sessions\/[^/]+$/],
  ["GET", /^\/sessions\/[^/]+\/wakeups$/],
  ["POST", /^\/sessions\/[^/]+\/wakeups$/],
  ["DELETE", /^\/sessions\/[^/]+\/wakeups\/[^/]+$/],
  ["GET", /^\/agents$/],
  ["POST", /^\/agents$/],
  ["GET", /^\/agents\/[^/]+$/],
  ["PUT", /^\/agents\/[^/]+$/],
  ["DELETE", /^\/agents\/[^/]+$/],
  ["POST", /^\/agents\/[^/]+\/run$/],
  ["GET", /^\/executions$/],
  ["GET", /^\/executions\/[^/]+\/result$/],
];

/**
 * Whether the MCP token of session `caller` may call `method path` (path
 * with or without the /api prefix). Session routes (its record, which the
 * tools need for folder/backend/model, and its wake-ups) are open for the
 * caller's own session only.
 */
export function isMcpRouteAllowed(method: string, path: string, caller: string): boolean {
  const rel = path.replace(/^\/api(?=\/)/, "");
  const own = /^\/sessions\/([^/]+)(\/|$)/.exec(rel);
  if (own && decodeURIComponent(own[1]) !== caller) return false;
  return MCP_ROUTES.some(([m, re]) => m === method.toUpperCase() && re.test(rel));
}

/**
 * Why the session `info` may not use its MCP token at all, or null. A
 * session restricted to some built-in tools (`--tools`, agents' allowedTools)
 * does not get the companion MCP server: `--tools` does not limit MCP tools,
 * and with them such a session could create and run an unrestricted agent.
 * The launcher does not inject the server there; this refuses a token that
 * reached such a session anyway (e.g. one spawned before the change).
 */
export function mcpCallerRefusal(info: { tools?: string[] }): string | null {
  if (info.tools && info.tools.length > 0) {
    return "This session runs with a restricted tool set, so the Companion MCP tools are not available to it.";
  }
  return null;
}

// ── Access levels ───────────────────────────────────────────────────────────

/**
 * How much a session or an agent may do on this machine:
 *  - "full": unrestricted. Every Claude Code session counts as full: in its
 *    non-bypass modes each MCP tool call is approved by the user first, and
 *    Claude agents always run with bypassPermissions.
 *  - "sandboxed": a Codex session/agent confined to workspace-write.
 */
export type AccessLevel = "full" | "sandboxed";

export function sessionAccessLevel(info: { backendType?: string; codexSandbox?: string }): AccessLevel {
  return info.backendType === "codex" && info.codexSandbox === "workspace-write" ? "sandboxed" : "full";
}

/** Codex agents run in workspace-write unless their permissionMode is bypassPermissions. */
export function agentAccessLevel(agent: { backendType?: string; permissionMode?: string }): AccessLevel {
  return agent.backendType === "codex" && agent.permissionMode !== "bypassPermissions" ? "sandboxed" : "full";
}

/**
 * Why a session at `caller` may not act on something at `target` level, or
 * null if it may. A sandboxed session must not create, change or trigger
 * anything that runs with full access: that would be a way out of its sandbox.
 */
export function accessDenied(caller: AccessLevel, target: AccessLevel, what: string): string | null {
  if (caller === "sandboxed" && target === "full") {
    return `This session runs sandboxed (Codex workspace-write), so it cannot ${what} that runs with full access. Ask the user to do it from the Companion UI.`;
  }
  return null;
}

/** Test hook: use another secret file and forget the cached secret. */
export function _setMcpSecretFileForTest(path: string): void {
  secretFile = path;
  cachedSecret = null;
}
