import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

/**
 * The Companion LLM proxy (tools/llm-proxy/llm-proxy.mjs, the standalone
 * service that runs next to vLLM), end to end over HTTP in front of the fake
 * Anthropic-compatible server, which records what it received:
 *  - the shared token is required; every credential the client sent (an
 *    Anthropic OAuth token included) is dropped, only the upstream token
 *    leaves, and which kinds arrived is logged and kept in /metrics;
 *  - Claude Code's own effort (output_config.effort) becomes the model's
 *    parameters (Qwen chat_template_kwargs by default), so a runtime effort
 *    change applies to the next request;
 *  - model mapping, Anthropic-only fields and server tools dropped;
 *  - SSE streamed through, tokens/TTFT/duration recorded per session
 *    (X-Companion-Session header);
 *  - count_tokens estimated when the upstream lacks it; vLLM's context
 *    error reworded as Anthropic's "prompt is too long".
 */

import {
  classifyCredential,
  estimateInputTokens,
  levelFor,
  loadConfig,
  normalizeConfig,
  normalizeRequestBody,
  rewordContextError,
  startProxy,
  QWEN_LEVELS,
} from "../../tools/llm-proxy/llm-proxy.mjs";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../scripts/fake-anthropic-server.js";

const TOKEN = "proxy-shared-token-0123456789";
const OAUTH = "sk-ant-oat01-REAL-OAUTH-TOKEN";
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let fake: FakeAnthropicServer;
let proxy: Server;
let url: string;
let logs: { line: string; warn?: boolean }[];

async function setup(fakeOpts: Parameters<typeof startFakeAnthropicServer>[0] = {}, extra: Record<string, unknown> = {}) {
  fake = await startFakeAnthropicServer({ token: "upstream-token", ...fakeOpts });
  logs = [];
  const config = normalizeConfig({
    listen: { host: "127.0.0.1", port: 0 },
    upstream: { url: `${fake.url}/v1`, token: "upstream-token" },
    token: TOKEN,
    model: "my-model",
    contextWindow: 131072,
    effort: { default: "high" },
    ...extra,
  });
  proxy = await startProxy(config, { logger: (line, warn) => logs.push({ line, warn }) });
  url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise((r) => proxy?.close(r));
  await fake?.close();
});

const claudeCodeBody = (extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5-5",
  max_tokens: 32000,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code." }],
  messages: [{ role: "user", content: [{ type: "text", text: "please run a command" }] }],
  tools: [
    { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "low" },
  metadata: { user_id: "device|account|session" },
  ...extra,
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,effort-2025-11-24",
      authorization: `Bearer ${TOKEN}`,
      "x-companion-session": SID,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("access", () => {
  beforeEach(() => setup());

  it("answers /health without a token and refuses everything else without it", async () => {
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: true, upstream: "up" });
    expect((await fetch(`${url}/info`)).status).toBe(401);
    const oauth = await post("/v1/messages", claudeCodeBody(), { authorization: `Bearer ${OAUTH}` });
    expect(oauth.status).toBe(401);
    expect(await oauth.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    expect(fake.messages()).toHaveLength(0);
    expect((await fetch(`${url}/nope`, { headers: auth })).status).toBe(404);
  });

  it("accepts the token as x-api-key and proxies /v1/models", async () => {
    const res = await fetch(`${url}/v1/models`, { headers: { "x-api-key": TOKEN } });
    expect(await res.json()).toMatchObject({ data: [{ id: "my-model" }] });
  });

  // What Companion reads to fill a provider: models, window, levels (Claude effort value → model level).
  it("publishes its models, window and levels on /info", async () => {
    const info = await (await fetch(`${url}/info`, { headers: auth })).json();
    expect(info).toMatchObject({
      models: ["my-model"],
      contextWindow: 131072,
      upstream: "up",
      effort: { default: "high", levels: QWEN_LEVELS.map(({ name, claude }) => ({ name, claude })) },
    });
  });
});

describe("POST /v1/messages", () => {
  // The guarantee of docs/local-llm.md: whatever Claude Code sends, only the upstream token leaves.
  it("swaps the credentials and records which ones arrived", async () => {
    await setup();
    const res = await post("/v1/messages?beta=true", claudeCodeBody(), { "x-api-key": OAUTH, cookie: "a=b" });
    expect(res.status).toBe(200);
    await res.text();
    const sent = fake.messages()[0];
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers.authorization).toBe("Bearer upstream-token");
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers["anthropic-beta"]).toBeUndefined();
    expect(sent.headers["x-companion-session"]).toBeUndefined();
    expect(JSON.stringify(fake.requests)).not.toContain("sk-ant-");
    expect(JSON.stringify(fake.requests)).not.toContain(TOKEN);
    const m = await (await fetch(`${url}/metrics?session=${SID}`, { headers: auth })).json();
    expect(m.metrics.authSeen).toEqual(["authorization: proxy token", "x-api-key: ANTHROPIC OAUTH TOKEN", "cookie: present"]);
    expect(logs.some((l) => l.warn && l.line.includes("was NOT forwarded"))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("sk-ant-oat01-REAL");
  });

  it("maps the model, drops Anthropic-only fields and maps Claude Code's effort to the model level", async () => {
    await setup();
    await (await post("/v1/messages", claudeCodeBody())).text();
    const body = fake.messages()[0].body!;
    expect(body.model).toBe("my-model");
    // low → "off": thinking disabled on Qwen templates.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    for (const field of ["thinking", "context_management", "output_config", "metadata"]) expect(body).not.toHaveProperty(field);
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["Bash"]);
    expect(body.max_tokens).toBe(32000);
  });

  // The effort switcher changes Claude Code's effort at runtime: the next request carries the new one.
  it("follows the effort of each request; none = the default level", async () => {
    await setup();
    await (await post("/v1/messages", claudeCodeBody({ output_config: { effort: "xhigh" } }))).text();
    await (await post("/v1/messages", claudeCodeBody({ output_config: undefined }))).text();
    await (await post("/v1/messages", claudeCodeBody({ output_config: { effort: "max" } }))).text();
    expect(fake.messages().map((m) => m.body!.chat_template_kwargs)).toEqual([
      { reasoning_effort: "xhigh" },
      { reasoning_effort: "medium" },
      { reasoning_effort: "medium" },
    ]);
  });

  it("streams SSE through and records tokens, TTFT and duration per session", async () => {
    await setup({ firstTokenDelayMs: 30 });
    const res = await post("/v1/messages", claudeCodeBody({ output_config: { effort: "high" } }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain("echo hello-from-fake-provider");
    expect(text).toContain("event: message_stop");
    const { metrics: m } = await (await fetch(`${url}/metrics?session=${SID}`, { headers: auth })).json();
    expect(m.requests).toBe(1);
    expect(m.inputTokens).toBeGreaterThan(0);
    expect(m.outputTokens).toBeGreaterThan(0);
    expect(m.last).toMatchObject({ status: 200, model: "my-model", effort: "medium" });
    expect(m.last.ttftMs).toBeGreaterThanOrEqual(25);
    expect(m.last.durationMs).toBeGreaterThanOrEqual(m.last.ttftMs);
    expect(logs.some((l) => /200 my-model effort=high→medium in=\d+ out=\d+ ttft=\d+ms/.test(l.line))).toBe(true);
    const all = await (await fetch(`${url}/metrics`, { headers: auth })).json();
    expect(all.totals.requests).toBe(1);
    expect(Object.keys(all.sessions)).toEqual([SID]);
  });

  it("passes JSON answers through and counts their usage", async () => {
    await setup();
    const res = await post("/v1/messages", claudeCodeBody({ stream: false }));
    const json = await res.json() as { content: { type: string }[]; usage: { output_tokens: number } };
    expect(json.content.map((c) => c.type)).toEqual(["text", "tool_use"]);
    const { metrics } = await (await fetch(`${url}/metrics?session=${SID}`, { headers: auth })).json();
    expect(metrics.outputTokens).toBe(json.usage.output_tokens);
  });

  it("rewords vLLM's context-length error as Anthropic's prompt-too-long", async () => {
    await setup({
      failWith: { status: 400, body: JSON.stringify({ object: "error", message: "This model's maximum context length is 131072 tokens. However, your request has 140000 input tokens." }) },
    });
    const res = await post("/v1/messages", claudeCodeBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 140000 tokens > 131072 maximum" } });
  });

  it("passes other errors through and reports an unreachable upstream as 502", async () => {
    await setup({ failWith: { status: 500, body: "boom" } });
    const res = await post("/v1/messages", claudeCodeBody());
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("boom");
    await fake.close();
    const down = await post("/v1/messages", claudeCodeBody());
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: { type: "api_error" } });
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: false, upstream: "down" });
  });

  it("forwards a body that is not JSON as it is", async () => {
    await setup();
    const res = await post("/v1/messages", "not json");
    expect(res.status).toBe(404);
    expect(fake.requests.at(-1)!.body).toBeNull();
  });
});

describe("count_tokens", () => {
  // An upstream without count_tokens: answered locally, and not asked again.
  it("estimates locally when the upstream lacks it, then stops asking", async () => {
    await setup();
    const body = { model: "claude-haiku", messages: [{ role: "user", content: "x".repeat(400) }] };
    expect(await (await post("/v1/messages/count_tokens?beta=true", body)).json()).toEqual({ input_tokens: estimateInputTokens(body) });
    const asked = fake.requests.filter((r) => r.path.startsWith("/v1/messages/count_tokens")).length;
    await (await post("/v1/messages/count_tokens", body)).json();
    expect(fake.requests.filter((r) => r.path.startsWith("/v1/messages/count_tokens")).length).toBe(asked);
  });

  it("forwards it (model mapped, no level injected) when the upstream has it", async () => {
    await setup({ countTokens: true });
    const res = await post("/v1/messages/count_tokens", { model: "claude-haiku", messages: [], thinking: {}, output_config: { effort: "low" } });
    expect(await res.json()).toEqual({ input_tokens: 42 });
    expect(fake.requests.find((r) => r.path.startsWith("/v1/messages/count_tokens"))!.body).toEqual({ model: "my-model", messages: [] });
  });
});

describe("config", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "llm-proxy-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("loads a file and fills the defaults", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ upstream: { url: "http://vllm.example:8000/v1/" }, token: TOKEN }));
    const c = loadConfig(path);
    expect(c).toMatchObject({ listen: { host: "0.0.0.0", port: 8787 }, upstream: { url: "http://vllm.example:8000", token: "" }, model: null, contextWindow: null, keepThinking: false, log: true });
    expect(c.effort).toEqual({ default: "low", levels: QWEN_LEVELS });
  });

  it("refuses what would not work", () => {
    expect(() => normalizeConfig(null)).toThrow(/JSON object/);
    expect(() => normalizeConfig({ token: TOKEN })).toThrow(/upstream.url/);
    expect(() => normalizeConfig({ upstream: { url: "http://x" }, token: "short" })).toThrow(/16 characters/);
    expect(() => normalizeConfig({ upstream: { url: "http://x" }, token: TOKEN, effort: { levels: [{ name: "a", claude: "ultra" }] } })).toThrow(/effort.levels/);
    expect(() => normalizeConfig({ upstream: { url: "http://x" }, token: TOKEN, effort: { levels: [{ name: "a", claude: "low" }, { name: "b", claude: "low" }] } })).toThrow(/one level only/);
    expect(() => normalizeConfig({ upstream: { url: "http://x" }, token: TOKEN, effort: { default: "max" } })).toThrow(/effort.default/);
  });

  it("keeps thinking when asked and maps custom levels", () => {
    const c = normalizeConfig({
      upstream: { url: "http://x" }, token: TOKEN, keepThinking: true, dropFields: [],
      effort: { default: "low", levels: [{ name: "fast", claude: "low", params: { top_k: 1 } }] },
    });
    const out = normalizeRequestBody(c, { model: "x", thinking: { type: "adaptive" }, metadata: {}, tools: [{ type: "web_search_20250305" }], tool_choice: {} }, "m", true);
    expect(out.body).toEqual({ model: "m", thinking: { type: "adaptive" }, metadata: {}, top_k: 1 });
    expect(levelFor(c, {})?.name).toBe("fast");
    expect(levelFor({ ...c, effort: { default: null, levels: [] } }, {})).toBeNull();
  });
});

describe("pure helpers", () => {
  it("classifies credentials without exposing them", () => {
    expect(classifyCredential(`Bearer ${TOKEN}`, TOKEN)).toBe("proxy token");
    expect(classifyCredential("Bearer sk-ant-oat01-abc", TOKEN)).toBe("ANTHROPIC OAUTH TOKEN");
    expect(classifyCredential("sk-ant-api03-abc", TOKEN)).toBe("ANTHROPIC API KEY");
    expect(classifyCredential("whatever", TOKEN)).toBe("unknown credential");
    expect(classifyCredential("Bearer ", TOKEN)).toBe("empty");
  });

  it("recognises context errors only", () => {
    expect(rewordContextError("max_model_len exceeded", 65536)).toBe("prompt is too long: 65537 tokens > 65536 maximum");
    expect(rewordContextError("some other problem", 65536)).toBeNull();
  });
});
