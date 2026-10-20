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
//    server tools (web search), streams SSE back untouched;
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
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VERSION = "1.0.0";

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
  const totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  let countTokensMissing = false;

  const sessionOf = (headers) => String(headers["x-companion-session"] || headers["x-claude-code-session-id"] || "unknown").slice(0, 100);
  const metricsOf = (id) => {
    let m = sessions.get(id);
    if (!m) {
      m = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalDurationMs: 0, authSeen: [] };
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
      logger(`[llm-proxy] ${id.slice(0, 8)} ${info.status} ${info.model} effort=${info.claudeEffort ?? "-"}→${info.level?.name ?? "-"} in=${tap.inputTokens} out=${tap.outputTokens} ttft=${ttftMs ?? "-"}ms dur=${durationMs}ms`);
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

// CLI: node llm-proxy.mjs --config /etc/companion-llm-proxy/config.json
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
  const server = await startProxy(config);
  const addr = server.address();
  console.log(`[llm-proxy] ${VERSION} listening on ${addr.address}:${addr.port} → ${config.upstream.url} (model ${config.model ?? "from upstream"}, ${config.effort.levels.length} levels)`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
