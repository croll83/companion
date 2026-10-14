// The brain's HTTP surface as one web-standard fetch handler (served by
// Bun.serve in main.ts; tests call it directly):
//
//   POST /mcp      MCP streamable HTTP, STATELESS: a fresh McpServer and
//                  transport per request, JSON answers. With BRAIN_TOKEN_KEY
//                  set it needs `Authorization: Bearer brn_...` (token.ts).
//                  GET and DELETE answer 405: there are no MCP sessions.
//   GET  /healthz  status, versions, wiki and inbox counts (open)
//   GET  /skill, /skill.md   the public skill (open, ETag)
//   /api/v1/*      curator API (api.ts), X-Brain-Key when configured
//
// DNS-rebinding protection: the Host header must name the bind address (any
// loopback name when bound to loopback) or one of BRAIN_ALLOWED_HOSTS.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isLoopback } from "./config.js";
import { createApi } from "./api.js";
import { skillResponse } from "./skill.js";
import { bearerOf, verifyToken } from "./token.js";
import { BRAIN_PROTOCOL, VERSION } from "./version.js";
import type { Brain, BrainAuthExtra } from "./brain.js";

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function rpcError(status: number, code: number, message: string): Response {
  return json(status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** The host name of a Host header value, without port and brackets, lower-cased. */
export function hostName(header: string | null): string {
  const h = (header ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") < 0 ? undefined : h.indexOf("]"));
  const colon = h.lastIndexOf(":");
  return colon > 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

/** The Host names a server bound to `host` accepts. */
export function allowedHostNames(host: string, extra: string[]): Set<string> {
  const names = new Set([host.toLowerCase(), ...extra.map((h) => h.toLowerCase())]);
  if (isLoopback(host)) for (const n of ["127.0.0.1", "localhost", "::1"]) names.add(n);
  return names;
}

export function createFetchHandler(brain: Brain): (req: Request) => Promise<Response> {
  const api = createApi(brain);
  const hosts = allowedHostNames(brain.cfg.host, brain.cfg.allowedHosts);

  async function mcp(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null }), {
        status: 405,
        headers: { Allow: "POST", "Content-Type": "application/json" },
      });
    }
    let extra: BrainAuthExtra | undefined;
    if (brain.cfg.tokenKey) {
      const claims = verifyToken(brain.cfg.tokenKey, bearerOf(req.headers.get("authorization")));
      if (!claims) {
        brain.audit.log({ event: "mcp_denied", detail: "missing or invalid brn_ token", ok: false });
        return rpcError(401, -32001, "A valid brain token is required (Authorization: Bearer brn_...)");
      }
      extra = { claims };
    }
    const server = brain.newMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const authInfo = extra ? { token: "brn", clientId: `${extra.claims.domain}/${extra.claims.sessionId}`, scopes: [], extra: { ...extra } } : undefined;
      return await transport.handleRequest(req, authInfo ? { authInfo } : undefined);
    } finally {
      // JSON mode: the answer is complete once handleRequest resolves.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!hosts.has(hostName(req.headers.get("host") ?? url.host))) return json(403, { error: "Host not allowed" });
    try {
      if (url.pathname === "/mcp") return await mcp(req);
      if (url.pathname === "/healthz" && req.method === "GET") {
        const w = brain.wiki();
        return json(200, {
          status: "ok",
          name: brain.cfg.name,
          version: VERSION,
          protocol: BRAIN_PROTOCOL,
          wiki_commit: w.commit,
          content_hash: w.contentHash,
          pages: w.pages.size,
          raw: w.raw.size,
          loaded_at: w.loadedAt,
          redact_secrets: brain.cfg.redactSecrets,
          auth: { mcp: !!brain.cfg.tokenKey, api: !!brain.cfg.curatorKey },
          inbox: brain.inbox.counts(),
        });
      }
      if (url.pathname === "/skill" && req.method === "GET") return skillResponse(req, brain.skill(), "json");
      if (url.pathname === "/skill.md" && req.method === "GET") return skillResponse(req, brain.skill(), "md");
      const fromApi = await api(req, url);
      if (fromApi) return fromApi;
      return json(404, { error: "not found" });
    } catch (e) {
      brain.audit.log({ event: "http_error", detail: `${req.method} ${url.pathname}: ${(e as Error).message}`, ok: false });
      return json(500, { error: "internal error" });
    }
  };
}
