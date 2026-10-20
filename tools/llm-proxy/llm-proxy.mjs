#!/usr/bin/env node
// Companion LLM proxy: an Anthropic Messages API in front of vLLM (or any
// Anthropic-compatible server), for Claude Code sessions that Companion runs
// on a local model. Runs NEXT TO vLLM, as its own service (install.sh).
// Single file, no dependencies, Node >= 22 (or Bun). See docs/local-llm.md.
//
// What it does, per request from Claude Code:
//  - checks the shared token (Authorization: Bearer or x-api-key) and drops
//    every credential the client sent: only the upstream token (if any)
//    leaves. Which credentials arrived is logged by kind, never by value,
//    and an Anthropic credential (sk-ant-...) is logged as a warning;
//  - maps Claude Code's own effort (`output_config.effort`, which follows
//    the effort switcher at runtime) to the model's reasoning parameters
//    (`effort.levels` in the config, e.g. chat_template_kwargs);
//  - rewrites `model` to the served model, drops Anthropic-only fields and
//    server tools, streams SSE back untouched;
//  - emulates Anthropic's web search server tool (web_search_20250305, what
//    Claude Code's WebSearch asks for) when `search` is configured: it runs
//    the search itself (Tavily or Brave), has the model write the answer
//    from the results, and returns the server_tool_use and
//    web_search_tool_result blocks the CLI reads (see webSearch below);
//  - answers count_tokens locally when the upstream has none, and words a
//    context-length 400 as Anthropic does ("prompt is too long") so Claude
//    Code compacts;
//  - records tokens in/out, time to first token and duration per session
//    (X-Companion-Session header, else Claude Code's x-claude-code-session-id),
//    served on GET /metrics and logged one line per request.
//
// Endpoints: GET /health (no token), GET /info, GET /metrics[?session=],
// GET /v1/models, POST /v1/messages, POST /v1/messages/count_tokens,
// anything else under /v1/ is forwarded as is.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VERSION = "1.1.0";

/** Fields of the Anthropic API that other servers do not implement (the effort is mapped, not forwarded). */
export const DEFAULT_DROP_FIELDS = ["context_management", "output_config", "container", "mcp_servers", "service_tier", "metadata", "betas", "speed", "thread", "diagnostics"];

/** Request headers passed upstream. Everything else (credentials, betas, cookies) stays here. */
const FORWARDED_HEADERS = ["content-type", "accept", "anthropic-version", "user-agent"];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

/** Claude Code's effort values (what travels in output_config.effort). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Levels for Qwen3 chat templates (vLLM --reasoning-parser qwen3): Claude
 * Code's effort values carry the model's levels, lowest to highest. The
 * names are what Companion's effort selector shows.
 */
export const QWEN_LEVELS = [
  { name: "off", claude: "low", params: { chat_template_kwargs: { enable_thinking: false } } },
  { name: "low", claude: "medium", params: { chat_template_kwargs: { reasoning_effort: "low" } } },
  { name: "medium", claude: "high", params: { chat_template_kwargs: { reasoning_effort: "medium" } } },
  { name: "xhigh", claude: "xhigh", params: { chat_template_kwargs: { reasoning_effort: "xhigh" } } },
];

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Web search backends (config `search.backend`) and their default endpoints. */
export const SEARCH_BACKENDS = ["tavily", "brave"];
const SEARCH_URLS = { tavily: "https://api.tavily.com/search", brave: "https://api.search.brave.com/res/v1/web/search" };
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
/** Longest query sent to a backend (Tavily and Brave both stop at 400 characters). */
export const MAX_QUERY_LENGTH = 400;

/** Validate and complete a config object. Throws with a readable message. */
export function normalizeConfig(raw) {
  if (!isObject(raw)) throw new Error("config must be a JSON object");
  const listen = isObject(raw.listen) ? raw.listen : {};
  const upstream = isObject(raw.upstream) ? raw.upstream : {};
  if (typeof upstream.url !== "string" || !/^https?:\/\//.test(upstream.url)) throw new Error("upstream.url must be the vLLM URL, e.g. http://127.0.0.1:30000");
  if (typeof raw.token !== "string" || raw.token.length < 16) throw new Error("token must be a shared secret of at least 16 characters");
  const effort = isObject(raw.effort) ? raw.effort : {};
  const levels = Array.isArray(effort.levels) ? effort.levels : QWEN_LEVELS;
  for (const l of levels) {
    if (!isObject(l) || typeof l.name !== "string" || !CLAUDE_EFFORTS.includes(l.claude) || (l.params !== undefined && !isObject(l.params))) {
      throw new Error(`effort.levels: each level needs {name, claude: one of ${CLAUDE_EFFORTS.join("/")}, params: {...}}`);
    }
  }
  if (new Set(levels.map((l) => l.claude)).size !== levels.length) throw new Error("effort.levels: each Claude effort value may carry one level only");
  const defaultClaude = effort.default ?? levels[0]?.claude;
  if (levels.length > 0 && !levels.some((l) => l.claude === defaultClaude)) throw new Error("effort.default must be the `claude` value of one of the levels");
  const window = Number(raw.contextWindow ?? 0);
  return {
    search: normalizeSearch(raw.search),
    listen: { host: typeof listen.host === "string" ? listen.host : "0.0.0.0", port: Number(listen.port ?? 8787) },
    upstream: { url: upstream.url.replace(/\/+$/, "").replace(/\/v1$/, ""), token: typeof upstream.token === "string" ? upstream.token : "" },
    token: raw.token,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    contextWindow: Number.isInteger(window) && window > 0 ? window : null,
    effort: { default: levels.length > 0 ? defaultClaude : null, levels },
    dropFields: Array.isArray(raw.dropFields) ? raw.dropFields : DEFAULT_DROP_FIELDS,
    keepThinking: raw.keepThinking === true,
    log: raw.log !== false,
  };
}

/** The `search` block: null when web search is off (absent, null or backend "none"). */
export function normalizeSearch(raw) {
  if (raw === undefined || raw === null || (isObject(raw) && (raw.backend === undefined || raw.backend === "none"))) return null;
  if (!isObject(raw) || !SEARCH_BACKENDS.includes(raw.backend)) throw new Error(`search.backend must be one of ${SEARCH_BACKENDS.join(", ")} (or "none")`);
  if (typeof raw.apiKey !== "string" || !raw.apiKey.trim()) throw new Error(`search.apiKey is required for ${raw.backend}`);
  if (raw.url !== undefined && (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url))) throw new Error("search.url must be an http(s) URL");
  const maxResults = Number(raw.maxResults ?? DEFAULT_SEARCH_RESULTS);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) throw new Error("search.maxResults must be a whole number from 1 to 20");
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) throw new Error("search.timeoutMs must be between 1000 and 60000");
  return { backend: raw.backend, apiKey: raw.apiKey.trim(), url: raw.url ?? SEARCH_URLS[raw.backend], maxResults, timeoutMs };
}

export function loadConfig(path) {
  return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
}

function deepMerge(target, extra) {
  for (const [k, v] of Object.entries(extra)) {
    target[k] = isObject(v) && isObject(target[k]) ? deepMerge({ ...target[k] }, v) : v;
  }
  return target;
}

/** The level a request runs at: Claude Code's effort, else the default. */
export function levelFor(config, body) {
  const asked = isObject(body.output_config) ? body.output_config.effort : undefined;
  return config.effort.levels.find((l) => l.claude === asked) ?? config.effort.levels.find((l) => l.claude === config.effort.default) ?? null;
}

/** The body sent upstream (pure). `inject`: add the level's parameters (messages, not count_tokens). */
export function normalizeRequestBody(config, body, model, inject) {
  const level = levelFor(config, body);
  const out = { ...body, model };
  for (const field of config.dropFields) delete out[field];
  if (!config.keepThinking) delete out.thinking;
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.filter((t) => !(isObject(t) && typeof t.type === "string" && t.type !== "custom"));
    if (out.tools.length === 0) {
      delete out.tools;
      delete out.tool_choice;
    }
  }
  return { body: inject && level?.params ? deepMerge(out, level.params) : out, level };
}

export function estimateInputTokens(body) {
  return Math.ceil(JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length / 4);
}

/** vLLM's "maximum context length" 400 as Anthropic words it, or null. */
export function rewordContextError(text, contextWindow) {
  if (!/maximum context length|max_model_len|too many tokens|prompt is too long/i.test(text)) return null;
  const limit = Number(/maximum context length is (\d+)/i.exec(text)?.[1]) || contextWindow || 0;
  const asked = Number(/(?:request has|resulted in|has) (\d+) (?:input )?tokens/i.exec(text)?.[1]) || limit + 1;
  return `prompt is too long: ${asked} tokens > ${limit} maximum`;
}

/** What a credential is, never its value. */
export function classifyCredential(value, token) {
  const v = String(value).replace(/^Bearer\s+/i, "").trim();
  if (!v) return "empty";
  if (safeEqual(v, token)) return "proxy token";
  if (v.startsWith("sk-ant-oat")) return "ANTHROPIC OAUTH TOKEN";
  if (v.startsWith("sk-ant-")) return "ANTHROPIC API KEY";
  return "unknown credential";
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function presented(headers) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization ?? "").trim())?.[1];
  return bearer ?? (typeof headers["x-api-key"] === "string" ? headers["x-api-key"].trim() : "");
}

// ─── Web search ──────────────────────────────────────────────────────────────
// Claude Code's WebSearch tool (checked on CLI 2.1.303) does not search by
// itself: it sends a separate POST /v1/messages whose only tool is the
// Anthropic server tool {type: "web_search_20250305", name: "web_search",
// max_uses: 8, allowed_domains?, blocked_domains?}, with one user message
// "Perform a web search for the query: <query>" and a system prompt asking
// for one search and a brief summary. From the answer it reads, in order:
// server_tool_use blocks, web_search_tool_result blocks (only `title` and
// `url` of each result, or `content.error_code` on an error) and the text,
// which becomes the WebSearch tool result the main model sees.
//
// The proxy answers that request itself when `search` is configured: one
// search per request (the query of the prompt), the results given to the
// model as context, and an Anthropic-shaped answer (JSON or SSE, as asked).
// A request that carries other tools besides web search is not emulated:
// its server tools are dropped as before.

/** Error codes of a web_search_tool_result (Anthropic API). */
export const SEARCH_ERROR_CODES = ["too_many_requests", "invalid_tool_input", "max_uses_exceeded", "query_too_long", "request_too_large", "unavailable"];

const CLAUDE_CODE_SEARCH_PROMPT = /^\s*Perform a web search for the query:\s*/;

/** The web search server tool of a request that has no other tool, else null. */
export function webSearchToolOf(body) {
  if (!Array.isArray(body.tools) || body.tools.length !== 1) return null;
  const t = body.tools[0];
  return isObject(t) && typeof t.type === "string" && t.type.startsWith("web_search_") ? t : null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => isObject(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/**
 * The query of a web search request: Claude Code's "Perform a web search for
 * the query: …" (kept whole: a longer one is query_too_long), else the last
 * user message, cut to MAX_QUERY_LENGTH.
 */
export function webSearchQuery(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m) => isObject(m) && m.role === "user");
  const text = textOf(last?.content).trim();
  if (CLAUDE_CODE_SEARCH_PROMPT.test(text)) return { query: text.replace(CLAUDE_CODE_SEARCH_PROMPT, "").trim(), explicit: true };
  return { query: text.slice(0, MAX_QUERY_LENGTH).trim(), explicit: false };
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Anthropic's domain filter rules: `example.com` also covers its subdomains,
 * `docs.example.com` only that subdomain (and below), `example.com/blog`
 * the paths under /blog, `*` is a wildcard in the path only.
 */
export function domainMatches(url, entry) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const [host, ...rest] = String(entry).trim().toLowerCase().replace(/^https?:\/\//, "").split("/");
  const h = u.hostname.toLowerCase();
  if (!host || (h !== host && !h.endsWith(`.${host}`))) return false;
  const path = rest.join("/");
  if (!path) return true;
  return new RegExp(`^/${path.split("*").map(escapeRe).join(".*")}`).test(u.pathname);
}

export function filterByDomains(results, allowed, blocked) {
  return results.filter((r) =>
    (!allowed?.length || allowed.some((d) => domainMatches(r.url, d))) && !(blocked?.length && blocked.some((d) => domainMatches(r.url, d))));
}

const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

/** Bare host names for a backend's own domain filter (paths are filtered here afterwards). */
const hostsOf = (domains) => [...new Set((domains ?? []).map((d) => String(d).replace(/^https?:\/\//, "").split("/")[0]).filter(Boolean))];

class SearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function backendError(status) {
  if (status === 429 || status === 432 || status === 433) return "too_many_requests";
  if (status === 400 || status === 422) return "invalid_tool_input";
  return "unavailable";
}

/** One search on the configured backend: [{url, title, snippet, pageAge}]. Throws SearchError. */
async function searchBackend(search, query, filter, doFetch) {
  const signal = AbortSignal.timeout(search.timeoutMs);
  // Ask for more when the results are filtered here, so some are left.
  const wanted = filter.allowed?.length || filter.blocked?.length ? 20 : search.maxResults;
  let res;
  try {
    if (search.backend === "tavily") {
      res = await doFetch(search.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${search.apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: wanted,
          include_published_date: true,
          ...(filter.allowed?.length ? { include_domains: hostsOf(filter.allowed) } : {}),
          ...(filter.blocked?.length ? { exclude_domains: hostsOf(filter.blocked) } : {}),
        }),
        signal,
      });
    } else {
      const url = new URL(search.url);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(wanted));
      res = await doFetch(url.toString(), { headers: { accept: "application/json", "x-subscription-token": search.apiKey }, signal });
    }
  } catch (err) {
    throw new SearchError("unavailable", err?.name === "TimeoutError" ? `no answer within ${search.timeoutMs / 1000} s` : String(err?.message ?? err));
  }
  if (!res.ok) {
    await res.body?.cancel?.();
    throw new SearchError(backendError(res.status), `HTTP ${res.status}`);
  }
  let data;
  try { data = await res.json(); } catch (err) { throw new SearchError("unavailable", `not JSON (${err?.message ?? err})`); }
  const raw = search.backend === "tavily"
    ? (Array.isArray(data?.results) ? data.results : []).map((r) => ({ url: r?.url, title: r?.title, snippet: r?.content, pageAge: r?.published_date }))
    : (Array.isArray(data?.web?.results) ? data.web.results : []).map((r) => ({ url: r?.url, title: stripTags(r?.title), snippet: stripTags(r?.description), pageAge: r?.page_age ?? r?.age }));
  return raw
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .map((r) => ({ url: r.url, title: typeof r.title === "string" && r.title ? r.title : r.url, snippet: typeof r.snippet === "string" ? r.snippet : "", pageAge: typeof r.pageAge === "string" && r.pageAge ? r.pageAge : null }));
}

/**
 * Run the search a web search request asks for, or say why not:
 * {ok: true, query, results} | {ok: false, query, code, reason}. Never throws.
 */
export async function runWebSearch(search, tool, body, doFetch) {
  const { query, explicit } = webSearchQuery(body);
  const fail = (code, reason) => ({ ok: false, query, code, reason });
  if (!search) return fail("unavailable", "no search backend configured");
  if (tool.max_uses !== undefined && !(Number(tool.max_uses) >= 1)) return fail("max_uses_exceeded", `max_uses is ${tool.max_uses}`);
  if (!query) return fail("invalid_tool_input", "empty query");
  if (explicit && query.length > MAX_QUERY_LENGTH) return fail("query_too_long", `${query.length} characters > ${MAX_QUERY_LENGTH}`);
  const filter = { allowed: Array.isArray(tool.allowed_domains) ? tool.allowed_domains : [], blocked: Array.isArray(tool.blocked_domains) ? tool.blocked_domains : [] };
  try {
    const found = await searchBackend(search, query, filter, doFetch);
    return { ok: true, query, results: filterByDomains(found, filter.allowed, filter.blocked).slice(0, search.maxResults) };
  } catch (err) {
    return fail(err instanceof SearchError ? err.code : "unavailable", String(err?.message ?? err));
  }
}

/** The web_search_tool_result block of an outcome (encrypted_content: the snippet in base64, nothing is encrypted). */
export function webSearchResultBlock(toolUseId, outcome) {
  return {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: outcome.ok
      ? outcome.results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: Buffer.from(r.snippet).toString("base64"), page_age: r.pageAge }))
      : { type: "web_search_tool_result_error", error_code: outcome.code },
  };
}

/** The results as the model reads them, appended to the last user message. */
export function webSearchContext(outcome) {
  if (outcome.results.length === 0) return `The web search for "${outcome.query}" returned no results. Say so.`;
  const lines = outcome.results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}${r.pageAge ? `\nPublished: ${r.pageAge}` : ""}${r.snippet ? `\n${r.snippet}` : ""}`);
  return `Web search results for "${outcome.query}":\n\n${lines.join("\n\n")}\n\nAnswer from these results only and cite the sources you use as markdown links.`;
}

/**
 * The model request of an emulated web search: no tools, the results added
 * to the last user message. Claude Code asks without thinking (its search
 * call has no `thinking` field), so it runs at the lowest level then.
 */
export function webSearchModelBody(config, body, outcome) {
  const messages = Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : [];
  const idx = messages.map((m) => m?.role).lastIndexOf("user");
  const extra = { type: "text", text: webSearchContext(outcome) };
  if (idx >= 0) {
    const c = messages[idx].content;
    messages[idx].content = [...(typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []), extra];
  } else {
    messages.push({ role: "user", content: [extra] });
  }
  const out = { ...body, messages };
  delete out.tools;
  delete out.tool_choice;
  const thinkingOff = !isObject(body.thinking) || body.thinking.type === "disabled";
  if (thinkingOff && config.effort.levels.length > 0) out.output_config = { ...(isObject(body.output_config) ? body.output_config : {}), effort: config.effort.levels[0].claude };
  return out;
}

export const newServerToolUseId = () => `srvtoolu_${randomBytes(12).toString("hex")}`;

/** Tokens and timings collected while an answer streams through. */
class AnswerTap {
  constructor(now) {
    this.now = now;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.firstTokenAt = undefined;
    this.buffer = "";
    this.decoder = new TextDecoder();
  }
  usage(u) {
    if (!isObject(u)) return;
    if (typeof u.input_tokens === "number" && u.input_tokens > 0) this.inputTokens = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.output_tokens === "number") this.outputTokens = Math.max(this.outputTokens, u.output_tokens);
  }
  sse(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === "message_start") this.usage(ev.message?.usage);
      else if (ev.type === "message_delta") this.usage(ev.usage);
      else if ((ev.type === "content_block_delta" || ev.type === "content_block_start") && this.firstTokenAt === undefined) this.firstTokenAt = this.now();
    }
  }
}

/**
 * The proxy as a request handler (node:http). `deps.fetch` and `deps.now`
 * are injectable for tests; `deps.logger` gets one line per request.
 */
export function createProxy(config, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? ((line, warn) => (warn ? console.warn : console.log)(line));
  const startedAt = now();
  /** Per-session numbers (bounded: the 500 most recent sessions). */
  const sessions = new Map();
  const totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, webSearches: 0 };
  let countTokensMissing = false;

  const sessionOf = (headers) => String(headers["x-companion-session"] || headers["x-claude-code-session-id"] || "unknown").slice(0, 100);
  const metricsOf = (id) => {
    let m = sessions.get(id);
    if (!m) {
      m = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalDurationMs: 0, webSearches: 0, authSeen: [] };
      sessions.set(id, m);
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
    }
    return m;
  };

  function record(id, tap, info) {
    const m = metricsOf(id);
    const durationMs = info.ended - info.started;
    m.requests += 1;
    totals.requests += 1;
    if (info.status >= 400) {
      m.errors += 1;
      totals.errors += 1;
    }
    m.inputTokens += tap.inputTokens;
    m.outputTokens += tap.outputTokens;
    m.cacheReadTokens += tap.cacheReadTokens;
    m.totalDurationMs += durationMs;
    m.webSearches += info.webSearches ?? 0;
    totals.webSearches += info.webSearches ?? 0;
    totals.inputTokens += tap.inputTokens;
    totals.outputTokens += tap.outputTokens;
    const ttftMs = tap.firstTokenAt !== undefined ? tap.firstTokenAt - info.started : undefined;
    const genMs = tap.firstTokenAt !== undefined ? info.ended - tap.firstTokenAt : 0;
    m.last = {
      at: info.ended,
      status: info.status,
      model: info.model,
      ...(info.level ? { effort: info.level.name } : {}),
      inputTokens: tap.inputTokens,
      outputTokens: tap.outputTokens,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      durationMs,
      ...(genMs > 0 && tap.outputTokens > 0 ? { outputTokensPerSec: Math.round((tap.outputTokens / genMs) * 10_000) / 10 } : {}),
    };
    if (config.log) {
      logger(`[llm-proxy] ${id.slice(0, 8)} ${info.status} ${info.model} effort=${info.claudeEffort ?? "-"}→${info.level?.name ?? "-"} in=${tap.inputTokens} out=${tap.outputTokens} ttft=${ttftMs ?? "-"}ms dur=${durationMs}ms${info.webSearches !== undefined ? ` web_search=${info.webSearches}` : ""}`);
    }
  }

  /** Log (once per session and kind) which credentials arrived. */
  function noteAuth(id, headers) {
    const seen = [];
    for (const name of ["authorization", "x-api-key", "anthropic-api-key", "proxy-authorization"]) {
      if (headers[name] !== undefined) seen.push(`${name}: ${classifyCredential(headers[name], config.token)}`);
    }
    if (headers.cookie !== undefined) seen.push("cookie: present");
    const m = metricsOf(id);
    const fresh = seen.filter((s) => !m.authSeen.includes(s));
    if (fresh.length === 0) return;
    m.authSeen.push(...fresh);
    const anthropic = fresh.some((s) => s.includes("ANTHROPIC"));
    logger(`[llm-proxy] ${id.slice(0, 8)} credentials received: ${seen.join(", ")} (dropped; upstream gets ${config.upstream.token ? "its own token" : "no token"})${anthropic ? " — WARNING: an Anthropic credential reached the proxy and was NOT forwarded" : ""}`, anthropic);
  }

  function upstreamHeaders(headers) {
    const out = {};
    for (const name of FORWARDED_HEADERS) if (typeof headers[name] === "string") out[name] = headers[name];
    if (config.upstream.token) {
      out.authorization = `Bearer ${config.upstream.token}`;
      out["x-api-key"] = config.upstream.token;
    }
    return out;
  }

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, type, message) => json(res, status, { type: "error", error: { type, message } });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async function pipeResponse(res, upstream) {
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v; });
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  }

  /** The model name sent upstream: the configured one, else the first upstream model. */
  let upstreamModel = config.model;
  async function servedModel() {
    if (upstreamModel) return upstreamModel;
    try {
      const r = await doFetch(`${config.upstream.url}/v1/models`, { headers: upstreamHeaders({}), signal: AbortSignal.timeout(5000) });
      const id = (await r.json())?.data?.[0]?.id;
      if (typeof id === "string") upstreamModel = id;
    } catch { /* retried at the next request */ }
    return upstreamModel ?? "default";
  }

  /**
   * A web search request (webSearchToolOf): search, then the model's answer
   * from the results, returned after the server_tool_use and
   * web_search_tool_result blocks. Streaming: the two blocks go out first
   * (the query as soon as the request arrives), then the model's stream with
   * its block indexes shifted by two. On a search error the answer is the
   * two blocks only, the model is not asked.
   */
  async function handleWebSearch(req, res, id, parsed, tool) {
    const model = await servedModel();
    const claudeEffort = isObject(parsed.output_config) ? parsed.output_config.effort : undefined;
    if (Array.isArray(tool.allowed_domains) && tool.allowed_domains.length > 0 && Array.isArray(tool.blocked_domains) && tool.blocked_domains.length > 0) {
      return apiError(res, 400, "invalid_request_error", "web_search: use allowed_domains or blocked_domains, not both");
    }
    const started = now();
    const tap = new AnswerTap(now);
    const stream = parsed.stream === true;
    const toolUseId = newServerToolUseId();
    const msgId = `msg_${randomBytes(12).toString("hex")}`;
    const toolUse = { type: "server_tool_use", id: toolUseId, name: typeof tool.name === "string" ? tool.name : "web_search", input: { query: webSearchQuery(parsed).query } };
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let level = null;
    let searches = 0;
    const finish = (status) => record(id, tap, { started, ended: now(), status, model, level, claudeEffort, webSearches: searches });

    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { ...toolUse, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    const searchStarted = now();
    const outcome = await runWebSearch(config.search, tool, parsed, doFetch);
    if (outcome.ok) searches = 1;
    if (config.log) {
      logger(`[llm-proxy] ${id.slice(0, 8)} web_search ${config.search?.backend ?? "-"} ${outcome.ok ? `${outcome.results.length} results` : `error=${outcome.code} (${outcome.reason})`} in ${now() - searchStarted}ms`, !outcome.ok);
    }
    const resultBlock = webSearchResultBlock(toolUseId, outcome);
    const serverToolUse = { web_search_requests: searches };
    if (stream) {
      send("content_block_start", { type: "content_block_start", index: 1, content_block: resultBlock });
      send("content_block_stop", { type: "content_block_stop", index: 1 });
    }
    if (!outcome.ok) {
      if (stream) {
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0, server_tool_use: serverToolUse } });
        send("message_stop", { type: "message_stop" });
        res.end();
      } else {
        json(res, 200, { id: msgId, type: "message", role: "assistant", model, content: [toolUse, resultBlock], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, server_tool_use: serverToolUse } });
      }
      return finish(200);
    }

    const n = normalizeRequestBody(config, webSearchModelBody(config, parsed, outcome), model, true);
    level = n.level;
    const fail = (status, type, message) => {
      if (stream) {
        send("error", { type: "error", error: { type, message } });
        res.end();
      } else {
        apiError(res, status, type, message);
      }
      return finish(status);
    };
    let upstream;
    try {
      upstream = await doFetch(`${config.upstream.url}/v1/messages`, { method: "POST", headers: upstreamHeaders(req.headers), body: JSON.stringify(n.body), signal: controller.signal });
    } catch (err) {
      return fail(502, "api_error", `The model server did not answer: ${err?.message ?? err}`);
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      const reworded = upstream.status === 400 || upstream.status === 413 ? rewordContextError(text, config.contextWindow) : null;
      if (reworded) return fail(400, "invalid_request_error", reworded);
      return fail(upstream.status, "api_error", `The model server answered HTTP ${upstream.status}: ${text.slice(0, 500)}`);
    }
    const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!stream || !isSse || !upstream.body) {
      let answer;
      try { answer = await upstream.json(); } catch { answer = null; }
      if (!isObject(answer) || !Array.isArray(answer.content)) return fail(502, "api_error", "The model server's answer is not an Anthropic message");
      tap.usage(answer.usage);
      tap.firstTokenAt = now();
      if (!stream) {
        json(res, 200, { ...answer, content: [toolUse, resultBlock, ...answer.content], usage: { ...(isObject(answer.usage) ? answer.usage : {}), server_tool_use: serverToolUse } });
        return finish(200);
      }
      // A JSON answer to a streaming request: its text goes out as one block.
      const text = answer.content.filter((b) => b?.type === "text").map((b) => b.text).join("");
      send("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text } });
      send("content_block_stop", { type: "content_block_stop", index: 2 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: answer.stop_reason ?? "end_turn", stop_sequence: null }, usage: { ...(isObject(answer.usage) ? answer.usage : {}), server_tool_use: serverToolUse } });
      send("message_stop", { type: "message_stop" });
      res.end();
      return finish(200);
    }

    // The model's stream, after our two blocks.
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let stopped = false;
    const forward = (raw) => {
      const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) return;
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      if (ev.type === "message_start") {
        tap.usage(ev.message?.usage);
        inputTokens = Number(ev.message?.usage?.input_tokens) || 0;
        return;
      }
      if (typeof ev.type === "string" && ev.type.startsWith("content_block_")) {
        if (tap.firstTokenAt === undefined) tap.firstTokenAt = now();
        send(ev.type, { ...ev, index: Number(ev.index ?? 0) + 2 });
        return;
      }
      if (ev.type === "message_delta") {
        tap.usage(ev.usage);
        send(ev.type, { ...ev, usage: { input_tokens: inputTokens, ...(isObject(ev.usage) ? ev.usage : {}), server_tool_use: serverToolUse } });
        return;
      }
      if (ev.type === "message_stop") stopped = true;
      send(ev.type ?? "message", ev);
    };
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          forward(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
        }
      }
      if (buffer.trim()) forward(buffer);
    } catch { /* client went away: aborted upstream */ }
    if (!stopped && !res.destroyed) send("error", { type: "error", error: { type: "api_error", message: "The model server's stream ended early" } });
    res.end();
    return finish(stopped ? 200 : 502);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://proxy");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      let upstream = false;
      try {
        const r = await doFetch(`${config.upstream.url}/health`, { signal: AbortSignal.timeout(5000) });
        upstream = r.ok;
        await r.body?.cancel?.();
      } catch { /* upstream down */ }
      return json(res, upstream ? 200 : 503, { ok: upstream, upstream: upstream ? "up" : "down", version: VERSION });
    }

    if (!safeEqual(presented(req.headers), config.token)) {
      return apiError(res, 401, "authentication_error", "A valid proxy token is required (Authorization: Bearer <token>)");
    }

    if (path === "/info" && req.method === "GET") {
      let models = [];
      let maxModelLen = null;
      try {
        const r = await doFetch(`${config.upstream.url}/v1/models`, { headers: upstreamHeaders({}), signal: AbortSignal.timeout(5000) });
        const data = (await r.json())?.data ?? [];
        models = data.map((m) => m?.id).filter((x) => typeof x === "string");
        maxModelLen = data.find((m) => typeof m?.max_model_len === "number")?.max_model_len ?? null;
      } catch { /* upstream down: models unknown */ }
      return json(res, 200, {
        version: VERSION,
        models: config.model ? [config.model] : models,
        contextWindow: config.contextWindow ?? maxModelLen,
        effort: { default: config.effort.default, levels: config.effort.levels.map((l) => ({ name: l.name, claude: l.claude })) },
        upstream: models.length > 0 ? "up" : "down",
        webSearch: config.search !== null,
        searchBackend: config.search?.backend ?? null,
      });
    }

    if (path === "/metrics" && req.method === "GET") {
      const session = url.searchParams.get("session");
      if (session) return json(res, 200, { session, metrics: sessions.get(session) ?? null });
      return json(res, 200, { version: VERSION, uptimeMs: now() - startedAt, totals, sessions: Object.fromEntries(sessions) });
    }

    if (!path.startsWith("/v1/")) return apiError(res, 404, "not_found_error", `No route ${path}`);

    const id = sessionOf(req.headers);
    noteAuth(id, req.headers);
    const isMessages = req.method === "POST" && path === "/v1/messages";
    const isCount = req.method === "POST" && path === "/v1/messages/count_tokens";
    const search = new URLSearchParams(url.search);
    search.delete("beta");
    const target = `${config.upstream.url}${path}${search.size ? `?${search}` : ""}`;

    let body;
    let parsed = null;
    let level = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const raw = await readBody(req);
      body = raw;
      if (isMessages || isCount) {
        try {
          const j = JSON.parse(raw.toString("utf-8"));
          if (isObject(j)) parsed = j;
        } catch { /* forwarded as is */ }
        if (parsed) {
          const n = normalizeRequestBody(config, parsed, await servedModel(), isMessages);
          level = n.level;
          body = JSON.stringify(n.body);
        }
      }
    }
    const searchTool = isMessages && parsed ? webSearchToolOf(parsed) : null;
    if (searchTool) return handleWebSearch(req, res, id, parsed, searchTool);
    const model = parsed ? await servedModel() : "-";
    const claudeEffort = isObject(parsed?.output_config) ? parsed.output_config.effort : undefined;

    if (isCount && parsed && countTokensMissing) return json(res, 200, { input_tokens: estimateInputTokens(parsed) });

    const controller = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    const started = now();
    let upstream;
    try {
      upstream = await doFetch(target, { method: req.method, headers: upstreamHeaders(req.headers), body, signal: controller.signal });
    } catch (err) {
      if (isMessages) record(id, new AnswerTap(now), { started, ended: now(), status: 502, model, level, claudeEffort });
      return apiError(res, 502, "api_error", `The model server did not answer: ${err?.message ?? err}`);
    }

    if (isCount && parsed && [404, 405, 501].includes(upstream.status)) {
      await upstream.body?.cancel?.();
      countTokensMissing = true;
      return json(res, 200, { input_tokens: estimateInputTokens(parsed) });
    }
    if (!isMessages) return pipeResponse(res, upstream);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      record(id, new AnswerTap(now), { started, ended: now(), status: upstream.status, model, level, claudeEffort });
      const reworded = upstream.status === 400 || upstream.status === 413 ? rewordContextError(text, config.contextWindow) : null;
      if (reworded) return apiError(res, 400, "invalid_request_error", reworded);
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      return res.end(text);
    }

    const tap = new AnswerTap(now);
    const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isSse || !upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      try {
        tap.usage(JSON.parse(buf.toString("utf-8")).usage);
        tap.firstTokenAt = now();
      } catch { /* not JSON */ }
      record(id, tap, { started, ended: now(), status: upstream.status, model, level, claudeEffort });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      return res.end(buf);
    }
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v; });
    res.writeHead(upstream.status, headers);
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
        tap.sse(chunk);
      }
    } catch { /* client went away: aborted upstream */ }
    res.end();
    record(id, tap, { started, ended: now(), status: upstream.status, model, level, claudeEffort });
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) apiError(res, 500, "api_error", String(err?.message ?? err));
      else res.end();
    });
  };
}

export function startProxy(config, deps = {}) {
  const server = createServer(createProxy(config, deps));
  return new Promise((resolve) => server.listen(config.listen.port, config.listen.host, () => resolve(server)));
}

// CLI: node llm-proxy.mjs --config /etc/companion-llm-proxy/config.json [--check]
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf("--config");
  const path = i >= 0 ? process.argv[i + 1] : process.env.LLM_PROXY_CONFIG || "./config.json";
  let config;
  try {
    config = loadConfig(path);
  } catch (err) {
    console.error(`[llm-proxy] cannot load ${path}: ${err.message}`);
    process.exit(2);
  }
  if (process.argv.includes("--check")) {
    console.log(`[llm-proxy] ${path} is valid (web search: ${config.search?.backend ?? "off"})`);
    process.exit(0);
  }
  const server = await startProxy(config);
  const addr = server.address();
  console.log(`[llm-proxy] ${VERSION} listening on ${addr.address}:${addr.port} → ${config.upstream.url} (model ${config.model ?? "from upstream"}, ${config.effort.levels.length} levels, web search ${config.search?.backend ?? "off"})`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
