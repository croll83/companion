import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

/**
 * codex-ws-proxy.cjs, run for real against a local WebSocket server that
 * comes up late, like Codex's listener does. Regression: a refused
 * connection fires both "error" and "close", each scheduled its own retry,
 * and the proxy ended up with several sockets; requests then went to a
 * socket that never saw `initialize` and Codex answered "Not initialized".
 */

const PROXY = fileURLToPath(new URL("./codex-ws-proxy.cjs", import.meta.url));

let proxy: ChildProcess | null = null;
let server: WebSocketServer | null = null;

afterEach(async () => {
  proxy?.kill("SIGKILL");
  proxy = null;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("codex-ws-proxy", () => {
  it("opens a single connection when the server starts late, and relays both ways", async () => {
    const port = await freePort();
    proxy = spawn("node", [PROXY, `ws://127.0.0.1:${port}`, "10000", "10000"], { stdio: ["pipe", "pipe", "ignore"] });
    const out: string[] = [];
    proxy.stdout!.on("data", (d) => out.push(String(d)));
    // Queued before any connection exists, like Companion's initialize.
    proxy.stdin!.write('{"method":"initialize","id":1}\n');

    // Let several connection attempts fail first.
    await new Promise((r) => setTimeout(r, 700));
    const received: string[] = [];
    let connections = 0;
    server = new WebSocketServer({ host: "127.0.0.1", port });
    server.on("connection", (sock) => {
      connections++;
      sock.on("message", (data) => {
        received.push(String(data));
        sock.send('{"id":1,"result":{}}');
      });
    });

    await new Promise((r) => setTimeout(r, 1500));
    proxy.stdin!.write('{"method":"account/rateLimits/read","id":2}\n');
    await new Promise((r) => setTimeout(r, 300));

    expect(connections).toBe(1);
    expect(received).toEqual(['{"method":"initialize","id":1}', '{"method":"account/rateLimits/read","id":2}']);
    expect(out.join("")).toContain('{"id":1,"result":{}}');
  }, 15_000);
});
