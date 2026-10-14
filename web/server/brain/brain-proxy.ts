import { randomBytes } from "node:crypto";
import { getBrain } from "./brain-store.js";
import { embeddedKeys, isValidBrainToken } from "./brain-token.js";
import { childBaseUrl, getCompanionPort } from "./brain-endpoints.js";
import { brainSupervisor, type BrainSupervisor } from "./brain-supervisor.js";

/**
 * `ALL /brains/<slug>/mcp` on Companion's own port: the stable MCP URL of an
 * embedded brain, forwarded to its child on an ephemeral port. Handled in
 * server/index.ts BEFORE Hono and its auth middleware, because the callers
 * are CLI sessions, not the browser; instead:
 *
 *  - only loopback connections are accepted (sessions run on this machine);
 *  - the request must carry `Authorization: Bearer brn_...` signed for THIS
 *    brain (minted per session at spawn, brain-token.ts); the child checks it
 *    again and takes the session's identity from it;
 *  - while the child is starting or restarting, a request waits up to 10 s
 *    for it, then gets 503 (Companion's startup never waits on a brain);
 *  - the answer is streamed back as it comes (JSON or SSE).
 *
 * `GET|POST /brains/<slug>/curator/<pass>/api/v1/...`: the curator API for a
 * consolidation run (brain-consolidation.ts). The run's agent gets this URL
 * in its environment (BRAIN_API_URL); `pass` is random, valid for one brain
 * and only while the run lasts, so the brain's real curator key never leaves
 * Companion and a URL left in a transcript is dead after the run. Same
 * loopback rule; Companion adds the X-Brain-Key header.
 */

const PATH_RE = /^\/brains\/([a-z0-9][a-z0-9-]*)\/mcp\/?$/;
const CURATOR_RE = /^\/brains\/([a-z0-9][a-z0-9-]*)\/curator\/([A-Za-z0-9_-]{20,128})(\/api\/v1(?:\/.*)?)$/;

/** Curator passes of the consolidation runs in progress: pass → brain slug. */
const curatorPasses = new Map<string, string>();

/** A new curator pass for one run of `slug`; revoke it when the run ends. */
export function issueCuratorPass(slug: string): string {
  const pass = randomBytes(24).toString("base64url");
  curatorPasses.set(pass, slug);
  return pass;
}

export function revokeCuratorPass(pass: string | undefined): void {
  if (pass) curatorPasses.delete(pass);
}

/** The curator API base URL a run's agent uses (`$BRAIN_API_URL/inbox/notes`, ...). */
export function curatorPassUrl(slug: string, pass: string): string {
  return `http://127.0.0.1:${getCompanionPort()}/brains/${slug}/curator/${pass}/api/v1`;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

/** The curator API through a run's pass: loopback, a live pass for this brain, the child running. */
async function handleCuratorPass(req: Request, url: URL, m: RegExpExecArray, remoteAddr: string, deps: BrainProxyDeps): Promise<Response> {
  const [, slug, pass, apiPath] = m;
  if (!isLoopbackAddress(remoteAddr)) return jsonError(403, "Brains are reachable from this machine only");
  if (curatorPasses.get(pass) !== slug) return jsonError(401, "This curator URL is not valid (it only works while its consolidation run lasts)");
  if (req.method !== "GET" && req.method !== "POST") return jsonError(405, "Only GET and POST");
  const supervisor = deps.supervisor ?? brainSupervisor;
  const running = await supervisor.waitRunning(slug, deps.waitMs ?? 10_000);
  const base = childBaseUrl(slug);
  const keys = embeddedKeys(slug);
  if (!running || !base || !keys) return jsonError(503, "The brain is not running");
  const headers: Record<string, string> = { "X-Brain-Key": keys.curatorKey, Accept: "application/json" };
  const type = req.headers.get("content-type");
  if (type) headers["Content-Type"] = type;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}${apiPath}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? await req.arrayBuffer() : undefined,
      signal: req.signal,
    });
  } catch (err) {
    return jsonError(502, `The brain did not answer: ${(err as Error).message}`);
  }
  return new Response(await res.arrayBuffer(), { status: res.status, headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" } });
}
const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "proxy-connection", "te", "trailer"]);

export interface BrainProxyDeps {
  supervisor?: Pick<BrainSupervisor, "waitRunning">;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  waitMs?: number;
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function isLoopbackAddress(addr: string): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(addr);
}

/** Null when the path is not a brain proxy path (the caller goes on with its other routes). */
export async function handleBrainProxy(req: Request, remoteAddr: string, deps: BrainProxyDeps = {}): Promise<Response | null> {
  const url = new URL(req.url);
  const curator = CURATOR_RE.exec(url.pathname);
  if (curator) return handleCuratorPass(req, url, curator, remoteAddr, deps);
  const m = PATH_RE.exec(url.pathname);
  if (!m) return null;
  const slug = m[1];
  if (!isLoopbackAddress(remoteAddr)) return rpcError(403, "Brains are reachable from this machine only");
  const brain = getBrain(slug);
  if (!brain || brain.kind !== "embedded") return rpcError(404, `No embedded brain "${slug}"`);
  const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "")?.[1];
  if (!isValidBrainToken(slug, auth)) return rpcError(401, "A valid brain token is required: restart the session to get one");

  const supervisor = deps.supervisor ?? brainSupervisor;
  const running = await supervisor.waitRunning(slug, deps.waitMs ?? 10_000);
  const base = childBaseUrl(slug);
  if (!running || !base) return rpcError(503, `The brain "${brain.name}" is not running: see its page in Companion (Brains)`, { "Retry-After": "10" });

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${base}/mcp${url.search}`, { method: req.method, headers, body, signal: req.signal });
  } catch (err) {
    return rpcError(502, `The brain did not answer: ${(err as Error).message}`);
  }
  const out = new Headers();
  res.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-encoding") out.set(k, v);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
