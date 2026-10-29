import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Web search in the Companion LLM proxy (tools/llm-proxy/llm-proxy.mjs):
 * the proxy emulates Anthropic's web search server tool for Claude Code's
 * WebSearch, end to end over HTTP, with a fake search backend (Tavily- and
 * Brave-shaped, recording what it received) and the fake Anthropic server
 * standing in for vLLM. What these tests hold the proxy to is what Claude
 * Code 2.1.303 sends and parses (see the comment above webSearchToolOf):
 *  - the request: one tool {type: web_search_20250305, name: web_search,
 *    max_uses: 8}, one user message "Perform a web search for the query: …";
 *  - the answer: server_tool_use (input.query), web_search_tool_result
 *    (web_search_result items with url/title, or an error object with
 *    error_code), then the model's text; usage.server_tool_use;
 *  - JSON and SSE, errors that never hang (backend down, slow, rate
 *    limited, no backend), max_uses, allowed/blocked domains.
 */

import {
  domainMatches,
  filterByDomains,
  normalizeConfig,
  normalizeSearch,
  startProxy,
  webSearchQuery,
  webSearchToolOf,
} from "../../tools/llm-proxy/llm-proxy.mjs";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../scripts/fake-anthropic-server.js";

const TOKEN = "proxy-shared-token-0123456789";
const SEARCH_KEY = "tvly-test-key-never-forwarded";
const SID = "11111111-2222-3333-4444-555555555555";

interface SearchCall { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> | null }

interface FakeSearch {
  url: string;
  calls: SearchCall[];
  close(): Promise<void>;
}

const RESULTS = [
  { title: "vLLM releases", url: "https://github.com/vllm-project/vllm/releases", content: "v1.2.3 adds the Anthropic Messages API.", published_date: "2026-10-01" },
  { title: "vLLM docs", url: "https://docs.vllm.ai/en/latest/", content: "Serving models with vLLM." },
  { title: "Blog post", url: "https://blog.example.com/posts/vllm", content: "A third-party write-up." },
];

/** A search backend: Tavily (POST JSON) or Brave (GET) shaped, or failing / slow on demand. */
async function startFakeSearch(opts: { status?: number; delayMs?: number; brave?: boolean } = {}): Promise<FakeSearch> {
  const calls: SearchCall[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.status) {
      res.writeHead(opts.status, { "content-type": "application/json" });
      return res.end('{"detail":"nope"}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (opts.brave) {
      return res.end(JSON.stringify({ web: { results: RESULTS.map((r) => ({ title: `<strong>${r.title}</strong>`, url: r.url, description: `${r.content} &amp; more`, page_age: r.published_date })) } }));
    }
    res.end(JSON.stringify({ query: "x", results: RESULTS, response_time: 0.1 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/search`,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

let fake: FakeAnthropicServer;
let search: FakeSearch | undefined;
let proxy: Server;
let url: string;
let logs: string[];

/** The model's answer: quotes the search results it was given, so the tests see them arrive. */
const quoteResults = (body: Record<string, unknown>) => {
  const msgs = body.messages as { role: string; content: { type: string; text?: string }[] }[];
  const text = msgs.at(-1)!.content.map((b) => b.text ?? "").join("\n");
  return [{ type: "text" as const, text: `ANSWER (${(text.match(/^\[\d+\]/gm) ?? []).length} sources): ${/vLLM releases/.test(text) ? "[vLLM releases](https://github.com/vllm-project/vllm/releases)" : "none"}` }];
};

async function setup(searchOpts: Parameters<typeof startFakeSearch>[0] | null = {}, searchConfig: Record<string, unknown> = {}, fakeOpts: Parameters<typeof startFakeAnthropicServer>[0] = {}) {
  fake = await startFakeAnthropicServer({ script: quoteResults, ...fakeOpts });
  search = searchOpts ? await startFakeSearch(searchOpts) : undefined;
  logs = [];
  const config = normalizeConfig({
    listen: { host: "127.0.0.1", port: 0 },
    upstream: { url: fake.url },
    token: TOKEN,
    model: "my-model",
    effort: { default: "high" },
    ...(search ? { search: { backend: searchOpts?.brave ? "brave" : "tavily", apiKey: SEARCH_KEY, url: search.url, maxResults: 2, ...searchConfig } } : {}),
  });
  proxy = await startProxy(config, { logger: (line) => logs.push(line) });
  url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
}

afterEach(async () => {
  await new Promise((r) => proxy?.close(r));
  await fake?.close();
  await search?.close();
  search = undefined;
});

/** The request Claude Code's WebSearch sends (captured from CLI 2.1.303). */
const claudeCodeSearch = (tool: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5-5",
  max_tokens: 32000,
  stream: false,
  system: [{ type: "text", text: "You run a web search for another Claude model, which is waiting on the result and can search again. Search once, then reply with a brief summary of the results." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: latest vLLM release" }] }],
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, ...tool }],
  tool_choice: { type: "auto" },
  metadata: { user_id: "x" },
  output_config: { effort: "high" },
  ...extra,
});

function post(body: unknown) {
  return fetch(`${url}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-companion-session": SID },
    body: JSON.stringify(body),
  });
}

type Block = Record<string, unknown> & { type: string };

/** Folds an SSE answer the way Claude Code's stream reader does (content_block_start/delta/stop). */
function foldSse(text: string): { events: { event: string; data: Record<string, unknown> }[]; content: Block[]; usage: Record<string, unknown> } {
  const events = text.split("\n\n").filter((e) => e.trim()).map((e) => {
    const event = /^event: (.+)$/m.exec(e)?.[1] ?? "";
    const data = JSON.parse(/^data: (.+)$/m.exec(e)?.[1] ?? "{}") as Record<string, unknown>;
    return { event, data };
  });
  const content: Block[] = [];
  const partial: Record<number, string> = {};
  let usage: Record<string, unknown> = {};
  for (const { data } of events) {
    const i = data.index as number;
    if (data.type === "content_block_start") content[i] = { ...(data.content_block as Block) };
    if (data.type === "content_block_delta") {
      const d = data.delta as { type: string; text?: string; partial_json?: string };
      if (d.type === "text_delta") content[i].text = `${content[i].text ?? ""}${d.text}`;
      if (d.type === "input_json_delta") partial[i] = (partial[i] ?? "") + d.partial_json;
    }
    if (data.type === "content_block_stop" && partial[i] !== undefined) content[i].input = JSON.parse(partial[i]);
    if (data.type === "message_delta") usage = data.usage as Record<string, unknown>;
  }
  return { events, content, usage };
}

describe("emulated web search (Tavily)", () => {
  it("publishes webSearch and the backend on /info, and off without a backend", async () => {
    await setup();
    expect(await (await fetch(`${url}/info`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toMatchObject({ webSearch: true, searchBackend: "tavily" });
    await new Promise((r) => proxy.close(r));
    await fake.close();
    await search?.close();
    await setup(null);
    expect(await (await fetch(`${url}/info`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toMatchObject({ webSearch: false, searchBackend: null });
  });

  // The JSON answer: the blocks Claude Code parses, in its order, and what each side received.
  it("searches, has the model answer from the results and returns Anthropic's blocks (JSON)", async () => {
    await setup();
    const res = await post(claudeCodeSearch());
    expect(res.status).toBe(200);
    const msg = await res.json() as { content: Block[]; usage: { server_tool_use: { web_search_requests: number }; output_tokens: number } };
    expect(msg.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    const [use, result, text] = msg.content;
    expect(use).toMatchObject({ name: "web_search", input: { query: "latest vLLM release" } });
    expect(String(use.id)).toMatch(/^srvtoolu_/);
    expect(result.tool_use_id).toBe(use.id);
    // maxResults 2: the first two results, with Anthropic's fields.
    expect(result.content).toEqual([
      { type: "web_search_result", url: RESULTS[0].url, title: RESULTS[0].title, encrypted_content: Buffer.from(RESULTS[0].content).toString("base64"), page_age: "2026-10-01" },
      { type: "web_search_result", url: RESULTS[1].url, title: RESULTS[1].title, encrypted_content: Buffer.from(RESULTS[1].content).toString("base64"), page_age: null },
    ]);
    expect(text.text).toBe("ANSWER (2 sources): [vLLM releases](https://github.com/vllm-project/vllm/releases)");
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    expect(msg.usage.output_tokens).toBeGreaterThan(0);

    // Tavily got the query and the key; the model got no tools, the results, and the lowest level
    // (Claude Code's search call carries no thinking).
    expect(search!.calls).toHaveLength(1);
    expect(search!.calls[0].headers.authorization).toBe(`Bearer ${SEARCH_KEY}`);
    expect(search!.calls[0].body).toMatchObject({ query: "latest vLLM release", max_results: 2, search_depth: "basic" });
    const sent = fake.messages()[0].body!;
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.model).toBe("my-model");
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(sent.messages)).toContain("[1] vLLM releases\\nURL: https://github.com/vllm-project/vllm/releases\\nPublished: 2026-10-01");
    expect(JSON.stringify(fake.requests)).not.toContain(SEARCH_KEY);
    expect(JSON.stringify(logs)).not.toContain(SEARCH_KEY);

    const { metrics } = await (await fetch(`${url}/metrics?session=${SID}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(metrics.webSearches).toBe(1);
    expect(logs.some((l) => /web_search tavily 2 results/.test(l))).toBe(true);
    expect(logs.some((l) => / 200 my-model .* web_search=1$/.test(l))).toBe(true);
  });

  // The stream: query first, then results, then the model's blocks shifted after them.
  it("streams the two blocks first, then the model's stream re-indexed (SSE)", async () => {
    await setup();
    const res = await post(claudeCodeSearch({}, { stream: true, thinking: { type: "adaptive" } }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events, content, usage } = foldSse(await res.text());
    expect(events[0].event).toBe("message_start");
    expect(events.filter((e) => e.event === "message_start")).toHaveLength(1);
    expect(events.filter((e) => e.event === "message_stop")).toHaveLength(1);
    expect(events.at(-1)!.event).toBe("message_stop");
    expect(content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"]);
    expect(content[0].input).toEqual({ query: "latest vLLM release" });
    expect((content[1].content as unknown[]).length).toBe(2);
    expect(content[2].text).toContain("ANSWER (2 sources)");
    expect(usage).toMatchObject({ server_tool_use: { web_search_requests: 1 } });
    expect(Number(usage.input_tokens)).toBeGreaterThan(0);
    // With thinking asked, the request's own effort applies (high → medium).
    expect(fake.messages()[0].body!.chat_template_kwargs).toEqual({ reasoning_effort: "medium" });
  });

  it("takes the last user message as the query when the prompt is not Claude Code's", async () => {
    await setup();
    const body = claudeCodeSearch();
    body.messages = [{ role: "user", content: [{ type: "text", text: `  what is new in vLLM ${"x".repeat(500)}` }] }];
    const msg = await (await post(body)).json() as { content: Block[] };
    const query = (msg.content[0].input as { query: string }).query;
    expect(query.startsWith("what is new in vLLM")).toBe(true);
    expect(query.length).toBeLessThanOrEqual(400);
  });

  // The model request the emulation builds goes through the same folding as /v1/messages:
  // a {role: "system"} entry inside messages reaches vLLM as user text, not as a system role.
  it("folds a system entry inside messages into user text in the model request", async () => {
    await setup();
    const body = claudeCodeSearch();
    body.messages = [...body.messages, { role: "system", content: "Answer in Italian." }] as typeof body.messages;
    const res = await post(body);
    expect(res.status).toBe(200);
    await res.json();
    const sent = fake.messages()[0].body!.messages as { role: string; content: { type: string; text: string }[] }[];
    expect(sent.map((m) => m.role)).toEqual(["user"]);
    expect(sent[0].content.at(-1)!.text).toBe("<system-reminder>\nAnswer in Italian.\n</system-reminder>");
    expect(sent[0].content.some((b) => b.text.startsWith("Web search results for"))).toBe(true);
  });

  it("does not emulate a request that offers other tools too (server tools dropped as before)", async () => {
    await setup();
    const body = claudeCodeSearch({}, { tools: [{ name: "Bash", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }] });
    const msg = await (await post(body)).json() as { content: Block[] };
    expect(msg.content.map((b) => b.type)).toEqual(["text"]);
    expect(search!.calls).toHaveLength(0);
    expect((fake.messages()[0].body!.tools as { name: string }[]).map((t) => t.name)).toEqual(["Bash"]);
  });
});

describe("web search errors never hang", () => {
  const errorOf = (msg: { content: Block[] }) => (msg.content[1].content as { type: string; error_code: string });

  // An error is a 200 whose web_search_tool_result holds {type: web_search_tool_result_error, error_code}:
  // Claude Code turns it into "Web search error: <code>" for the main model. The model is not asked.
  it.each([
    [{ status: 500 }, "unavailable"],
    [{ status: 429 }, "too_many_requests"],
    [{ status: 432 }, "too_many_requests"],
    [{ status: 422 }, "invalid_tool_input"],
  ])("backend %j → %s", async (opts, code) => {
    await setup(opts);
    const msg = await (await post(claudeCodeSearch())).json() as { content: Block[]; usage: { server_tool_use: { web_search_requests: number } } };
    expect(msg.content.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result"]);
    expect(errorOf(msg)).toEqual({ type: "web_search_tool_result_error", error_code: code });
    expect(msg.usage.server_tool_use.web_search_requests).toBe(0);
    expect(fake.messages()).toHaveLength(0);
    expect(logs.some((l) => l.includes(`error=${code}`))).toBe(true);
  });

  it("times out a slow backend (timeoutMs) as unavailable, streaming", async () => {
    await setup({ delayMs: 3000 }, { timeoutMs: 1000 });
    const started = Date.now();
    const { content, events } = foldSse(await (await post(claudeCodeSearch({}, { stream: true }))).text());
    expect(Date.now() - started).toBeLessThan(2500);
    expect(content[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" });
    expect(events.at(-1)!.event).toBe("message_stop");
    expect(logs.some((l) => l.includes("no answer within 1 s"))).toBe(true);
  });

  it("answers unavailable when no backend is configured", async () => {
    await setup(null);
    const msg = await (await post(claudeCodeSearch())).json() as { content: Block[] };
    expect(errorOf(msg).error_code).toBe("unavailable");
  });

  it("honours max_uses and the query length", async () => {
    await setup();
    expect(errorOf(await (await post(claudeCodeSearch({ max_uses: 0 }))).json()).error_code).toBe("max_uses_exceeded");
    const long = claudeCodeSearch();
    long.messages = [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${"q".repeat(401)}` }] }];
    expect(errorOf(await (await post(long)).json()).error_code).toBe("query_too_long");
    const empty = claudeCodeSearch();
    empty.messages = [{ role: "user", content: [{ type: "text", text: "Perform a web search for the query: " }] }];
    expect(errorOf(await (await post(empty)).json()).error_code).toBe("invalid_tool_input");
    expect(search!.calls).toHaveLength(0);
  });

  it("refuses allowed and blocked domains together, as the API does", async () => {
    await setup();
    const res = await post(claudeCodeSearch({ allowed_domains: ["a.com"], blocked_domains: ["b.com"] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("reports the model server's failure after the search (JSON status, SSE error event)", async () => {
    await setup({}, {}, { failWith: { status: 500, body: "boom" } });
    const res = await post(claudeCodeSearch());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { type: "api_error", message: expect.stringContaining("boom") } });
    const { events } = foldSse(await (await post(claudeCodeSearch({}, { stream: true }))).text());
    expect(events.at(-1)).toMatchObject({ event: "error", data: { error: { type: "api_error" } } });
  });

  it("words a context overflow as prompt-too-long, and reports an unreachable model server", async () => {
    await setup({}, {}, { failWith: { status: 400, body: "maximum context length is 131072 tokens. However, your request has 140000 input tokens" } });
    expect(await (await post(claudeCodeSearch())).json()).toMatchObject({ error: { type: "invalid_request_error", message: "prompt is too long: 140000 tokens > 131072 maximum" } });
    await fake.close();
    const res = await post(claudeCodeSearch());
    expect(res.status).toBe(502);
  });
});

describe("domains", () => {
  it("passes the hosts to Tavily and filters the results by Anthropic's rules", async () => {
    await setup({}, { maxResults: 5 });
    const msg = await (await post(claudeCodeSearch({ allowed_domains: ["vllm.ai", "github.com/vllm-project/*/releases"] }))).json() as { content: Block[] };
    expect(search!.calls[0].body).toMatchObject({ include_domains: ["vllm.ai", "github.com"], max_results: 20 });
    expect((msg.content[1].content as { url: string }[]).map((r) => r.url)).toEqual([RESULTS[0].url, RESULTS[1].url]);
    const blocked = await (await post(claudeCodeSearch({ blocked_domains: ["example.com"] }))).json() as { content: Block[] };
    expect(search!.calls[1].body).toMatchObject({ exclude_domains: ["example.com"] });
    expect((blocked.content[1].content as { url: string }[]).map((r) => r.url)).toEqual([RESULTS[0].url, RESULTS[1].url]);
  });

  it("matches subdomains, paths and path wildcards only", () => {
    expect(domainMatches("https://docs.example.com/a", "example.com")).toBe(true);
    expect(domainMatches("https://example.com/a", "docs.example.com")).toBe(false);
    expect(domainMatches("https://notexample.com/", "example.com")).toBe(false);
    expect(domainMatches("https://example.com/blog/post-1", "example.com/blog")).toBe(true);
    expect(domainMatches("https://example.com/about", "example.com/blog")).toBe(false);
    expect(domainMatches("https://example.com/x/articles/1", "https://example.com/*/articles")).toBe(true);
    expect(domainMatches("not a url", "example.com")).toBe(false);
    expect(filterByDomains([{ url: "https://a.com/" }, { url: "https://b.com/" }], [], ["b.com"])).toEqual([{ url: "https://a.com/" }]);
  });
});

describe("Brave backend", () => {
  it("asks with GET and the subscription token, and cleans titles and snippets", async () => {
    await setup({ brave: true });
    const msg = await (await post(claudeCodeSearch())).json() as { content: Block[] };
    const call = search!.calls[0];
    expect(call.method).toBe("GET");
    expect(call.url).toBe("/search?q=latest+vLLM+release&count=2");
    expect(call.headers["x-subscription-token"]).toBe(SEARCH_KEY);
    const results = msg.content[1].content as { title: string; encrypted_content: string; page_age: string | null }[];
    expect(results[0].title).toBe("vLLM releases");
    expect(Buffer.from(results[0].encrypted_content, "base64").toString()).toBe(`${RESULTS[0].content} & more`);
    expect(results[0].page_age).toBe("2026-10-01");
  });
});

describe("config and helpers", () => {
  it("validates the search block", () => {
    expect(normalizeSearch(undefined)).toBeNull();
    expect(normalizeSearch({ backend: "none" })).toBeNull();
    expect(normalizeSearch({ backend: "tavily", apiKey: " k " })).toEqual({ backend: "tavily", apiKey: "k", url: "https://api.tavily.com/search", maxResults: 5, timeoutMs: 10000 });
    expect(normalizeSearch({ backend: "brave", apiKey: "k" })?.url).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(() => normalizeSearch({ backend: "duckduckgo" })).toThrow(/search.backend/);
    expect(() => normalizeSearch({ backend: "tavily" })).toThrow(/apiKey/);
    expect(() => normalizeSearch({ backend: "tavily", apiKey: "k", url: "ftp://x" })).toThrow(/search.url/);
    expect(() => normalizeSearch({ backend: "tavily", apiKey: "k", maxResults: 50 })).toThrow(/maxResults/);
    expect(() => normalizeSearch({ backend: "tavily", apiKey: "k", timeoutMs: 10 })).toThrow(/timeoutMs/);
  });

  it("recognises a web search request and its query", () => {
    expect(webSearchToolOf({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).toMatchObject({ name: "web_search" });
    expect(webSearchToolOf({ tools: [{ name: "Bash" }] })).toBeNull();
    expect(webSearchToolOf({})).toBeNull();
    expect(webSearchQuery({ messages: [{ role: "user", content: "Perform a web search for the query: a b" }] })).toEqual({ query: "a b", explicit: true });
    expect(webSearchQuery({ messages: [] })).toEqual({ query: "", explicit: false });
  });
});
