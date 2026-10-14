import { brainUrls, readBrainToken, type BrainConfig } from "./brain-store.js";
import { mintBrainToken } from "./brain-token.js";

/**
 * Server-side checks of a remote brain, for the Brains page. Results never
 * carry the token. Every request has a timeout (5 s by default) so a brain
 * that is down never hangs the page.
 *
 *  - health: GET <healthUrl> (jarvis-brain's /healthz answers JSON with
 *    status, version, pages, content_hash...);
 *  - test: health, plus an MCP `initialize` POSTed to <mcpUrl> the way a
 *    client would (JSON or SSE answer), then a DELETE of the MCP session when
 *    the server opened one (a stateful server keeps a limited number).
 *
 * OAuth brains: Companion holds no token (each CLI signs in from a session),
 * so the health check (public on brain servers) is sent without one and an
 * MCP answer of 401 with a WWW-Authenticate challenge means "reachable,
 * sign-in required", not a failure.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrainHealth {
  reachable: boolean;
  /** HTTP status of the health URL. */
  status?: number;
  /** From the health JSON, when it has them. */
  healthStatus?: string;
  version?: string;
  pages?: number;
  content_hash?: string;
  error?: string;
  checkedAt: number;
}

export interface BrainMcpCheck {
  ok: boolean;
  status?: number;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  /** The server sends MCP instructions (Claude shows them to the model; Codex does not). */
  hasInstructions?: boolean;
  /** "json" or "sse": how the server answered. */
  transport?: "json" | "sse";
  /** The MCP session the server opened was closed again (DELETE). */
  sessionClosed?: boolean;
  /** OAuth brain: the server answered 401 with a WWW-Authenticate challenge, i.e. it is up and wants a sign-in. */
  signInRequired?: boolean;
  error?: string;
}

export interface BrainTestResult {
  health: BrainHealth;
  mcp: BrainMcpCheck;
}

export interface ProbeOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** A fetch error as one line: a timeout, or the message and its cause. */
export function errorText(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return `No answer within ${Math.round(timeoutMs / 1000)} s`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `${msg}${cause}`;
}

function authHeaders(brain: BrainConfig): Record<string, string> {
  // An embedded brain's MCP URL is Companion's own proxy: a token of its own, as if from a GLOBAL session.
  if (brain.kind === "embedded") {
    const token = mintBrainToken(brain.slug, "GLOBAL", "companion-test");
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (brain.remote?.auth.mode !== "bearer") return {};
  const token = readBrainToken(brain.slug);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Whether two URLs share an origin (a token goes only to the MCP server's own origin). */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function pick<T>(obj: Record<string, unknown>, key: string, type: "string" | "number"): T | undefined {
  return typeof obj[key] === type ? (obj[key] as T) : undefined;
}

/** GET the brain's health URL. The token goes along only to the MCP server's own origin. */
export async function checkBrainHealth(brain: BrainConfig, opts: ProbeOptions = {}): Promise<BrainHealth> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const { healthUrl, mcpUrl } = brainUrls(brain);
  const checkedAt = Date.now();
  try {
    const res = await doFetch(healthUrl, {
      headers: { Accept: "application/json", ...(sameOrigin(healthUrl, mcpUrl) ? authHeaders(brain) : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      /* not JSON: reachable is all we know */
    }
    return {
      reachable: res.ok,
      status: res.status,
      ...(pick<string>(body, "status", "string") ? { healthStatus: pick<string>(body, "status", "string") } : {}),
      ...(pick<string>(body, "version", "string") ? { version: pick<string>(body, "version", "string") } : {}),
      ...(pick<number>(body, "pages", "number") !== undefined ? { pages: pick<number>(body, "pages", "number") } : {}),
      ...(pick<string>(body, "content_hash", "string") ? { content_hash: pick<string>(body, "content_hash", "string") } : {}),
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      checkedAt,
    };
  } catch (err) {
    return { reachable: false, error: errorText(err, timeoutMs), checkedAt };
  }
}

/** The JSON-RPC message with `id` in an SSE body (`data:` lines, events split by a blank line). */
async function readSseResponse(res: Response, id: number): Promise<Record<string, unknown> | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseEvent = (event: string): Record<string, unknown> | undefined => {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return undefined;
    try {
      const msg = JSON.parse(data) as Record<string, unknown>;
      return msg && msg.id === id ? msg : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : events.pop() ?? "";
      for (const e of events) {
        const msg = parseEvent(e);
        if (msg) return msg;
      }
      if (done) return undefined;
    }
  } finally {
    // The stream may stay open after the answer: stop reading it.
    reader.cancel().catch(() => {});
  }
}

/** POST an MCP `initialize` to the brain's MCP URL, then close the session it opened. */
export async function checkBrainMcp(brain: BrainConfig, opts: ProbeOptions = {}): Promise<BrainMcpCheck> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const { mcpUrl } = brainUrls(brain);
  const auth = authHeaders(brain);
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await doFetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "companion-brain-test", version: "1.0.0" } },
      }),
      signal,
    });
  } catch (err) {
    return { ok: false, error: errorText(err, timeoutMs) };
  }
  const sessionId = res.headers.get("mcp-session-id");
  const out: BrainMcpCheck = { ok: false, status: res.status };
  try {
    const challenge = res.status === 401 && !!res.headers.get("www-authenticate");
    if (!res.ok && challenge && brain.remote?.auth.mode === "oauth") {
      await res.body?.cancel().catch(() => {});
      out.signInRequired = true;
    } else if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      out.error = res.status === 401 || res.status === 403
        ? challenge && brain.remote?.auth.mode === "none"
          ? `HTTP ${res.status}: the brain requires sign-in (choose OAuth as its authentication)`
          : `HTTP ${res.status}: the brain refused the credentials`
        : `HTTP ${res.status}`;
    } else {
      const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      out.transport = sse ? "sse" : "json";
      const msg = sse ? await readSseResponse(res, 1) : (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const result = msg?.result as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown }; instructions?: unknown } | undefined;
      if (result && typeof result === "object") {
        out.ok = true;
        if (typeof result.serverInfo?.name === "string") out.serverName = result.serverInfo.name;
        if (typeof result.serverInfo?.version === "string") out.serverVersion = result.serverInfo.version;
        if (typeof result.protocolVersion === "string") out.protocolVersion = result.protocolVersion;
        out.hasInstructions = typeof result.instructions === "string" && result.instructions.length > 0;
      } else {
        const rpcError = (msg?.error as { message?: unknown } | undefined)?.message;
        out.error = typeof rpcError === "string" ? `MCP error: ${rpcError}` : "The answer is not an MCP initialize result";
      }
    }
  } catch (err) {
    out.error = errorText(err, timeoutMs);
  }
  if (sessionId) {
    try {
      const del = await doFetch(mcpUrl, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId, ...auth },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await del.body?.cancel().catch(() => {});
      out.sessionClosed = del.ok;
    } catch {
      out.sessionClosed = false;
    }
  }
  return out;
}

/** "Test connection": health and an MCP initialize, side by side. */
export async function testBrainConnection(brain: BrainConfig, opts: ProbeOptions = {}): Promise<BrainTestResult> {
  const [health, mcp] = await Promise.all([checkBrainHealth(brain, opts), checkBrainMcp(brain, opts)]);
  return { health, mcp };
}
