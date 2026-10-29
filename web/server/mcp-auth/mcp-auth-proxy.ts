import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCompanionPort } from "../brain/brain-endpoints.js";
import { isLoopbackAddress } from "../brain/brain-proxy.js";
import { GLOBAL_DOMAIN, readDomainMcp } from "../domain-store.js";
import { ensurePrivateDir, writePrivateFile } from "../private-file.js";
import { McpAuthError, accessToken, finishSignIn } from "./mcp-auth-oauth.js";
import { mcpAuthDir, readOwnerAuth } from "./mcp-auth-store.js";

/**
 * `ALL /mcp-auth/<owner>/<server>` on Companion's own port: the URL sessions
 * get for a private MCP server of a domain's (or GLOBAL's) mcp.json.
 * Companion forwards to the real server with the credentials it holds (an
 * OAuth access token, refreshed as needed, or an API key), so sessions never
 * see them and one sign-in serves every Claude and Codex session. Handled in
 * server/index.ts before Hono, like the brains' proxy:
 *
 *  - loopback connections only (sessions run on this machine);
 *  - `Authorization: Bearer mca_...`, minted per session at spawn and signed
 *    with Companion's key: a session of domain D reaches D's servers and
 *    GLOBAL's, nothing else;
 *  - the answer is streamed back (JSON or SSE). A 401 from the server is
 *    retried once with a refreshed token, then turned into a JSON-RPC error
 *    without WWW-Authenticate, so no CLI starts an OAuth login of its own
 *    against this URL.
 *
 * `GET /api/mcp-auth/callback`: where the provider's sign-in page lands (the
 * redirect URI). Loopback only: from another device the page does not load
 * and the user pastes its address on the Domains page instead.
 */

const PATH_RE = /^\/mcp-auth\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9_-]+)\/?$/;
export const CALLBACK_PATH = "/api/mcp-auth/callback";
const PREFIX = "mca_";
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "proxy-connection", "te", "trailer",
]);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ── Session tokens ──────────────────────────────────────────────────────────

function keyFile(): string {
  return join(mcpAuthDir(), "key");
}

/** Companion's signing key for session tokens, created on first use. */
function signingKey(): string {
  try {
    const hex = readFileSync(keyFile(), "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  } catch { /* create it */ }
  ensurePrivateDir(mcpAuthDir());
  const hex = randomBytes(32).toString("hex");
  writePrivateFile(keyFile(), `${hex}\n`);
  return hex;
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

/** A session's token for the private servers of its domain (and GLOBAL's). */
export function mintMcpAuthToken(domain: string, sessionId: string): string {
  const payload = Buffer.from(`${domain}|${sessionId}`).toString("base64url");
  return `${PREFIX}${payload}.${sign(payload)}`;
}

/** The domain a valid token was minted for, else null. */
export function tokenDomain(token: string | undefined): string | null {
  if (!token?.startsWith(PREFIX)) return null;
  const [payload, sig, extra] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Buffer.from(payload, "base64url").toString("utf-8").split("|")[0] || null;
}

/** The URL a session uses for `owner`'s private server `name`. */
export function mcpAuthProxyUrl(owner: string, name: string): string {
  return `http://127.0.0.1:${getCompanionPort()}/mcp-auth/${owner}/${name}`;
}

// ── Proxy ───────────────────────────────────────────────────────────────────

function rpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function where(owner: string, name: string): string {
  return `Companion → Domains → ${owner === GLOBAL_DOMAIN ? "GLOBAL" : owner} → MCP servers → ${name}`;
}

/** The credential header for the server, or an error Response. */
async function credential(owner: string, name: string, force: boolean, fetchImpl: FetchLike): Promise<[string, string] | Response | null> {
  const auth = readOwnerAuth(owner).servers[name];
  if (!auth || auth.kind === "open") return null;
  if (auth.kind === "apiKey") {
    if (!auth.header || !auth.value) return rpcError(403, `${name} needs an API key: set it in ${where(owner, name)}`);
    return [auth.header, auth.value];
  }
  try {
    return ["Authorization", `Bearer ${await accessToken(owner, auth.issuer ?? "", { force }, fetchImpl)}`];
  } catch (err) {
    const why = err instanceof McpAuthError && err.code === "not-signed-in" ? err.message : `sign-in failed: ${(err as Error).message}`;
    return rpcError(403, `${name}: ${why}. Sign in from ${where(owner, name)}`);
  }
}

export interface McpAuthProxyDeps {
  fetch?: FetchLike;
}

/** Null when the path is not this proxy's (the caller goes on with its other routes). */
export async function handleMcpAuthProxy(req: Request, remoteAddr: string, deps: McpAuthProxyDeps = {}): Promise<Response | null> {
  const url = new URL(req.url);
  if (url.pathname === CALLBACK_PATH) return handleCallback(req, remoteAddr, deps);
  const m = PATH_RE.exec(url.pathname);
  if (!m) return null;
  const [, owner, name] = m;
  if (!isLoopbackAddress(remoteAddr)) return rpcError(403, "Reachable from this machine only");
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "")?.[1];
  const domain = tokenDomain(bearer);
  if (!domain) return rpcError(401, "A valid session token is required: reload the session");
  if (owner !== domain && owner !== GLOBAL_DOMAIN) return rpcError(403, `This session's domain cannot use ${owner}'s servers`);
  const upstream = readDomainMcp(owner).servers[name]?.url;
  if (!upstream) return rpcError(404, `No HTTP server "${name}" in ${owner === GLOBAL_DOMAIN ? "GLOBAL" : owner}'s mcp.json`);

  const fetchImpl = deps.fetch ?? fetch;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const send = async (force: boolean): Promise<Response> => {
    const cred = await credential(owner, name, force, fetchImpl);
    if (cred instanceof Response) return cred;
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (!HOP_BY_HOP.has(key) && key !== "authorization" && key !== "cookie") headers.set(k, v);
    });
    if (cred) headers.set(cred[0], cred[1]);
    try {
      return await fetchImpl(`${upstream}${url.search}`, { method: req.method, headers, body, signal: req.signal });
    } catch (err) {
      return rpcError(502, `${name} did not answer: ${(err as Error).message}`);
    }
  };

  let res = await send(false);
  if (res.status === 401 && readOwnerAuth(owner).servers[name]?.kind === "oauth") {
    await res.body?.cancel();
    res = await send(true);
  }
  if (res.status === 401) {
    await res.body?.cancel();
    return rpcError(403, `${name} refused Companion's credentials: sign in again (or check the API key) in ${where(owner, name)}`);
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (!HOP_BY_HOP.has(key) && key !== "content-encoding" && key !== "www-authenticate") out.set(k, v);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

// ── Callback ────────────────────────────────────────────────────────────────

function page(title: string, text: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">`
    + `<h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(text)}</p></body>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleCallback(req: Request, remoteAddr: string, deps: McpAuthProxyDeps): Promise<Response> {
  if (!isLoopbackAddress(remoteAddr)) {
    return page("Use the Domains page", "Copy this page's address and paste it in Companion's Domains page to finish the sign-in.", 403);
  }
  try {
    const done = await finishSignIn(req.url, deps.fetch ?? fetch);
    const who = done.account ? ` as ${done.account}` : "";
    return page("Signed in", `Signed in${who} for ${done.servers.join(", ")}. You can close this tab and go back to Companion.`);
  } catch (err) {
    return page("Sign-in not completed", err instanceof Error ? err.message : String(err), 400);
  }
}
