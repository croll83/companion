import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Health and "Test connection" against a fake brain: a node http server on
 * an ephemeral 127.0.0.1 port (never PORT from env, never the network). It
 * answers /healthz, and an MCP initialize as JSON or SSE, records what it
 * received (headers, DELETE of the MCP session).
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { createRemoteBrain, type BrainConfig } from "./brain-store.js";
import { checkBrainHealth, checkBrainMcp, testBrainConnection } from "./brain-probe.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let server: Server;
let base: string;
let handler: Handler;
const seen: { method?: string; url?: string; auth?: string; session?: string; body: string }[] = [];
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "brain-probe-"));
  h.home = join(tmp, "companion");
  seen.length = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

function brain(over: Record<string, unknown> = {}): BrainConfig {
  const r = createRemoteBrain({ name: "Fake", baseUrl: base, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.brain;
}

const initResult = {
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2025-06-18", serverInfo: { name: "jarvis-brain", version: "0.3.0" }, capabilities: {}, instructions: "Read before answering." },
};

describe("checkBrainHealth", () => {
  // jarvis-brain's /healthz fields come through; nothing else.
  it("reads status, version, pages and content hash", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", version: "0.3.0", pages: 80, raw: 16, content_hash: "06d7e3f0a057" }));
    };
    const health = await checkBrainHealth(brain());
    expect(health).toMatchObject({ reachable: true, status: 200, healthStatus: "ok", version: "0.3.0", pages: 80, content_hash: "06d7e3f0a057" });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/healthz" });
  });

  // The inbox counts feed "N notes waiting" on the brain's card; junk values are dropped.
  it("passes the inbox counts through", async () => {
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", inbox: { pending: 3, accepted: 1, bogus: "x" } }));
    };
    const b = brain();
    expect((await checkBrainHealth(b)).inbox).toEqual({ pending: 3, accepted: 1 });
    handler = (_req, res) => res.end(JSON.stringify({ status: "ok", inbox: [1] }));
    expect((await checkBrainHealth(b)).inbox).toBeUndefined();
  });

  it("reports an HTTP error and a non-JSON body", async () => {
    handler = (_req, res) => { res.statusCode = 503; res.end("down"); };
    expect(await checkBrainHealth(brain())).toMatchObject({ reachable: false, status: 503, error: "HTTP 503" });
  });

  // A brain that never answers must not hang the page.
  it("times out", async () => {
    handler = () => { /* never answers */ };
    const health = await checkBrainHealth(brain(), { timeoutMs: 100 });
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/No answer within|aborted|timeout/i);
  });

  it("reports a refused connection", async () => {
    const b = brain();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const health = await checkBrainHealth(b);
    expect(health.reachable).toBe(false);
    expect(health.error).toBeTruthy();
    server = createServer(() => {}); // for afterEach
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  // The token goes to the health URL only on the MCP server's own origin.
  it("sends the bearer token only to the MCP server's origin", async () => {
    handler = (_req, res) => res.end("{}");
    const b = brain({ auth: { mode: "bearer" }, token: "tok-1" });
    await checkBrainHealth(b);
    expect(seen[0].auth).toBe("Bearer tok-1");
    const other = { ...b, remote: { ...b.remote!, healthUrl: `http://localhost:${new URL(base).port}/healthz` } };
    await checkBrainHealth(other);
    expect(seen[1].auth).toBeUndefined();
  });
});

describe("checkBrainMcp", () => {
  // A stateful server (jarvis-brain today) opens a session on initialize:
  // the test closes it again, since the server keeps a limited number.
  it("initializes over JSON and deletes the MCP session", async () => {
    handler = (req, res) => {
      if (req.method === "DELETE") { res.statusCode = 200; res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "sess-42");
      res.end(JSON.stringify(initResult));
    };
    const check = await checkBrainMcp(brain({ auth: { mode: "bearer" }, token: "tok-1" }));
    expect(check).toEqual({
      ok: true, status: 200, transport: "json", serverName: "jarvis-brain", serverVersion: "0.3.0",
      protocolVersion: "2025-06-18", hasInstructions: true, sessionClosed: true,
    });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/mcp", auth: "Bearer tok-1" });
    expect(JSON.parse(seen[0].body)).toMatchObject({ method: "initialize", id: 1 });
    expect(seen[1]).toMatchObject({ method: "DELETE", url: "/mcp", session: "sess-42", auth: "Bearer tok-1" });
  });

  // Streamable HTTP may answer with an SSE stream that stays open.
  it("reads an SSE answer, even from a stream left open", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": ping\n\n");
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/x" })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify({ ...initResult, result: { ...initResult.result, instructions: undefined } })}\n\n`);
    };
    const check = await checkBrainMcp(brain(), { timeoutMs: 2000 });
    expect(check).toMatchObject({ ok: true, transport: "sse", serverName: "jarvis-brain", hasInstructions: false });
    expect(check.sessionClosed).toBeUndefined();
  });

  it("reports an SSE stream that ends without the answer", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: not json\n\n");
    };
    expect(await checkBrainMcp(brain())).toMatchObject({ ok: false, error: "The answer is not an MCP initialize result" });
  });

  it.each([
    [401, "refused the credentials"],
    [500, "HTTP 500"],
  ])("reports HTTP %i", async (status, error) => {
    handler = (_req, res) => { res.statusCode = status; res.end("no"); };
    expect(await checkBrainMcp(brain())).toMatchObject({ ok: false, status, error: expect.stringContaining(error) });
  });

  it("reports a JSON-RPC error and a failed session delete", async () => {
    handler = (req, res) => {
      if (req.method === "DELETE") { res.statusCode = 405; res.end(); return; }
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "s1");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad version" } }));
    };
    expect(await checkBrainMcp(brain())).toMatchObject({ ok: false, error: "MCP error: bad version", sessionClosed: false });
  });

  it("reports an unreachable MCP URL", async () => {
    const failing = vi.fn(async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); });
    expect(await checkBrainMcp(brain(), { fetch: failing })).toEqual({ ok: false, error: "fetch failed: ECONNREFUSED" });
  });

  it("records a session delete that throws", async () => {
    let calls = 0;
    const fake = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error("gone");
      return new Response(JSON.stringify(initResult), { headers: { "content-type": "application/json", "mcp-session-id": "x" } });
    });
    expect(await checkBrainMcp(brain(), { fetch: fake })).toMatchObject({ ok: true, sessionClosed: false });
  });
});

describe("OAuth brains", () => {
  // Companion holds no OAuth token: a 401 with a WWW-Authenticate challenge
  // means "up, sign in from a session", not a failure; health goes unauthenticated.
  it("reports reachable, sign-in required", async () => {
    handler = (req, res) => {
      if (req.url === "/healthz") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "ok" })); return; }
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource"');
      res.end();
    };
    const b = brain({ auth: { mode: "oauth", clientId: "app-1" } });
    const { health, mcp } = await testBrainConnection(b);
    expect(health).toMatchObject({ reachable: true });
    expect(mcp).toEqual({ ok: false, status: 401, signInRequired: true });
    expect(seen.every((s) => s.auth === undefined)).toBe(true);
  });

  // The same challenge on a brain set to "none" tells the user to pick OAuth;
  // a 401 without a challenge stays a refusal.
  it("explains a challenge on a brain without auth", async () => {
    handler = (_req, res) => { res.statusCode = 401; res.setHeader("www-authenticate", "Bearer"); res.end(); };
    expect((await checkBrainMcp(brain())).error).toContain("requires sign-in");
    handler = (_req, res) => { res.statusCode = 401; res.end(); };
    const oauth = { ...brain({ name: "O" }), remote: { baseUrl: base, auth: { mode: "oauth" as const, clientId: "a" } } };
    expect(await checkBrainMcp(oauth)).toMatchObject({ ok: false, error: expect.stringContaining("refused the credentials") });
  });
});

describe("testBrainConnection", () => {
  it("returns health and MCP side by side", async () => {
    handler = (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/healthz" ? JSON.stringify({ status: "ok", pages: 3 }) : JSON.stringify(initResult));
    };
    const result = await testBrainConnection(brain());
    expect(result.health).toMatchObject({ reachable: true, pages: 3 });
    expect(result.mcp).toMatchObject({ ok: true });
  });
});
