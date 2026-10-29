/**
 * A fake Anthropic-compatible server (what vLLM's `/v1/messages` looks like
 * from Claude Code), for the local-provider tests and for a dev walkthrough
 * without a GPU. It records every request (path, headers, parsed body), so
 * tests can assert what the Companion LLM proxy really sent: the injected
 * `chat_template_kwargs`, the token swap, the model mapping.
 *
 *  - GET  /health, GET /v1/models ({data: [{id}]})
 *  - POST /v1/messages: streaming SSE (or JSON when `stream` is not set).
 *    Default script: when the conversation's last user turn carries a
 *    tool_result, answer with text quoting it; otherwise, when the request
 *    offers a Bash tool and the prompt contains "run", call Bash once; else
 *    plain text. `script` replaces it.
 *  - POST /v1/messages/count_tokens: 404 unless `countTokens` is on (the
 *    proxy then estimates locally).
 *
 * As a script (dev walkthrough):
 *   bun scripts/fake-anthropic-server.ts [--port 39999] [--token secret] [--model my-model]
 * Uses node:http so the same code runs under vitest (Node) and Bun.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export type FakeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };

export interface FakeAnthropicOptions {
  port?: number;
  /** Required bearer token (Authorization or x-api-key); none = anything goes. */
  token?: string;
  models?: string[];
  countTokens?: boolean;
  /** Serve /health (vLLM does); off = 404, so the health check falls back to /v1/models. */
  health?: boolean;
  /** What to answer to a /v1/messages body. */
  script?: (body: Record<string, unknown>) => FakeBlock[];
  /** Status + body to fail /v1/messages with (e.g. vLLM's context-length 400). */
  failWith?: { status: number; body: string };
  /** Delay before the first token (ms), to see TTFT. */
  firstTokenDelayMs?: number;
  log?: boolean;
}

export interface FakeAnthropicServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** The /v1/messages requests only. */
  messages(): RecordedRequest[];
  close(): Promise<void>;
}

type Msg = { role?: string; content?: unknown };

function lastUserContent(body: Record<string, unknown>): unknown[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Msg[]) : [];
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return [];
  return typeof last.content === "string" ? [{ type: "text", text: last.content }] : Array.isArray(last.content) ? last.content : [];
}

/** The default conversation: one Bash call when asked to "run", then a text answer quoting the result. */
export function defaultScript(body: Record<string, unknown>): FakeBlock[] {
  const content = lastUserContent(body) as { type?: string; text?: string; content?: unknown }[];
  const result = content.find((b) => b.type === "tool_result");
  if (result) {
    const text = typeof result.content === "string"
      ? result.content
      : Array.isArray(result.content) ? (result.content as { text?: string }[]).map((c) => c.text ?? "").join("") : "";
    return [{ type: "text", text: `The command printed: ${text.trim().slice(0, 200)}` }];
  }
  const prompt = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
  const tools = Array.isArray(body.tools) ? (body.tools as { name?: string }[]) : [];
  if (/\brun\b/i.test(prompt) && tools.some((t) => t.name === "Bash")) {
    return [
      { type: "text", text: "Running it." },
      { type: "tool_use", name: "Bash", input: { command: "echo hello-from-fake-provider", description: "Print a greeting" } },
    ];
  }
  return [{ type: "text", text: "Hello from the fake provider." }];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startFakeAnthropicServer(opts: FakeAnthropicOptions = {}): Promise<FakeAnthropicServer> {
  const requests: RecordedRequest[] = [];
  const models = opts.models ?? ["my-model"];
  const script = opts.script ?? defaultScript;
  let counter = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const raw = req.method === "GET" || req.method === "HEAD" ? "" : await readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch { /* not JSON */ }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers, body });
    if (opts.log) console.log(`[fake-anthropic] ${req.method} ${url.pathname} auth=${headers.authorization ? "yes" : "no"} model=${String(body?.model ?? "")}`);

    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/health") {
      if (opts.health === false) return json(404, { error: "not found" });
      res.writeHead(200);
      return res.end();
    }
    if (opts.token) {
      const presented = headers.authorization?.replace(/^Bearer\s+/i, "") ?? headers["x-api-key"];
      if (presented !== opts.token) return json(401, { type: "error", error: { type: "authentication_error", message: "bad token" } });
    }
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return json(200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) });
    }
    if (url.pathname === "/v1/messages/count_tokens") {
      if (!opts.countTokens) return json(404, { detail: "Not Found" });
      return json(200, { input_tokens: 42 });
    }
    if (url.pathname !== "/v1/messages" || req.method !== "POST" || !body) return json(404, { detail: "Not Found" });
    if (opts.failWith) {
      res.writeHead(opts.failWith.status, { "content-type": "application/json" });
      return res.end(opts.failWith.body);
    }

    const blocks = script(body);
    const id = `msg_fake_${++counter}`;
    const model = String(body.model ?? models[0]);
    const inputTokens = Math.ceil(raw.length / 4);
    const outputTokens = blocks.reduce((n, b) => n + Math.ceil(JSON.stringify(b).length / 4), 0);
    const stopReason = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    const content = blocks.map((b, i) => (b.type === "tool_use" ? { type: "tool_use", id: `toolu_fake_${counter}_${i}`, name: b.name, input: b.input } : b.type === "thinking" ? { ...b, signature: "" } : b));

    if (!body.stream) {
      return json(200, {
        id, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sse(res, "message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
    });
    if (opts.firstTokenDelayMs) await sleep(opts.firstTokenDelayMs);
    content.forEach((block, index) => {
      if (block.type === "text") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        const text = (block as { text: string }).text;
        for (const part of text.match(/.{1,12}/gs) ?? [""]) {
          sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
        }
      } else if (block.type === "thinking") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: (block as { thinking: string }).thinking } });
      } else {
        const tool = block as { id: string; name: string; input: Record<string, unknown> };
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
      }
      sse(res, "content_block_stop", { type: "content_block_stop", index });
    });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    messages: () => requests.filter((r) => r.path.startsWith("/v1/messages") && !r.path.startsWith("/v1/messages/count_tokens")),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// CLI entry (bun scripts/fake-anthropic-server.ts): a server for a dev walkthrough.
const isMain = typeof process !== "undefined" && process.argv[1] && /fake-anthropic-server\.ts$/.test(process.argv[1]);
if (isMain) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const srv = await startFakeAnthropicServer({
    port: Number(arg("port") ?? 39999),
    token: arg("token"),
    models: arg("model") ? [arg("model") as string] : undefined,
    log: true,
  });
  console.log(`[fake-anthropic] listening on ${srv.url}`);
  const dump = arg("dump");
  if (dump) {
    const { writeFileSync } = await import("node:fs");
    setInterval(() => writeFileSync(dump, JSON.stringify(srv.requests, null, 2)), 1000);
  }
}
