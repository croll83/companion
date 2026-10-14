import { getBrain } from "./brain-store.js";
import { isValidBrainToken } from "./brain-token.js";
import { childBaseUrl } from "./brain-endpoints.js";
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
 */

const PATH_RE = /^\/brains\/([a-z0-9][a-z0-9-]*)\/mcp\/?$/;
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
