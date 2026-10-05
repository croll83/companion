import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * The real `companion` MCP server process, as Claude Code and Codex start it
 * (`bun companion-mcp.ts` with the three env variables), speaking MCP stdio
 * to this test and calling a fake Companion API over HTTP. Proves the
 * handshake, tools/list and tools/call work end to end, with the session's
 * bearer token on the wire, and that the process exits when stdin closes.
 */

const SCRIPT = fileURLToPath(new URL("./companion-mcp.ts", import.meta.url));
const BUN = process.versions.bun ? process.execPath : "bun";

interface Received {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let api: Server;
let apiUrl: string;
let received: Received[];
let child: ChildProcessWithoutNullStreams | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolveBody(data));
  });
}

beforeEach(async () => {
  received = [];
  api = createServer(async (req, res) => {
    const raw = await readBody(req);
    received.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/api/sessions/sess-proc/wakeups") {
      res.statusCode = 201;
      res.end(JSON.stringify({ wakeup: { id: "wk-p", status: "pending", nextRunAt: Date.parse("2030-01-01T09:00:00Z"), schedule: { at: "2030-01-01T09:00:00Z" } } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Session not found" }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  child = null;
  await new Promise<void>((r) => api.close(() => r()));
});

/** Start the MCP process; returns a request helper and an exit promise. */
function startServer(env: Record<string, string>) {
  const proc = spawn(BUN, [SCRIPT], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  child = proc;
  const stderr: string[] = [];
  proc.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    pending.get(msg.id as number)?.(msg);
  });
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  let nextId = 1;
  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    const reply = new Promise<Record<string, unknown>>((r) => pending.set(id, r));
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return reply;
  };
  const notify = (method: string) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return { proc, request, notify, exited, stderr };
}

describe("companion MCP server process", () => {
  it("handshakes, lists tools and calls the API with the session token", async () => {
    const server = startServer({ COMPANION_API_URL: apiUrl, COMPANION_MCP_TOKEN: "cmcp_sess-proc.tok", COMPANION_SESSION_ID: "sess-proc" });

    const init = await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "companion" } });
    server.notify("notifications/initialized");

    const list = await server.request("tools/list");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain("schedule_wakeup");
    expect(names).toContain("create_agent");

    const call = await server.request("tools/call", { name: "schedule_wakeup", arguments: { message: "wake up", at: "2030-01-01T09:00:00Z" } });
    expect(call.result).toMatchObject({ content: [{ type: "text" }] });
    expect((call.result as { content: Array<{ text: string }> }).content[0].text).toMatch(/Scheduled wake-up wk-p for this session/);
    expect(received).toEqual([{
      method: "POST",
      url: "/api/sessions/sess-proc/wakeups",
      auth: "Bearer cmcp_sess-proc.tok",
      body: { message: "wake up", at: "2030-01-01T09:00:00Z" },
    }]);

    // An API refusal comes back as a tool error, not a crash.
    const failed = await server.request("tools/call", { name: "list_wakeups", arguments: { session_id: "gone" } });
    expect(failed.result).toMatchObject({ isError: true });

    server.proc.stdin.end();
    expect(await server.exited).toBe(0);
  }, 20_000);

  // Started without its variables (not by Companion): a clear error, exit 1.
  it("exits with an error when its environment is missing", async () => {
    const server = startServer({});
    expect(await server.exited).toBe(1);
    expect(server.stderr.join("")).toMatch(/COMPANION_API_URL, COMPANION_MCP_TOKEN and COMPANION_SESSION_ID must be set/);
  }, 20_000);
});
