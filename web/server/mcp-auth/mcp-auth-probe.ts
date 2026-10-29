import type { McpAuthKind } from "./mcp-auth-store.js";

/**
 * What access an HTTP MCP server needs, asked without credentials:
 *
 *  - an `initialize` request: 401/403 means private;
 *  - its OAuth protected resource metadata (RFC 9728), from the
 *    `resource_metadata` of a 401's WWW-Authenticate or the well-known URL.
 *    A server can answer `initialize` (even `tools/list`) without a token
 *    and still protect its data: Google Workspace's MCP servers do. Metadata
 *    naming an authorization server means OAuth whatever `initialize` said;
 *  - a 401 without that metadata: the older MCP spec put the authorization
 *    server at the server's own origin; if that has no OAuth metadata either,
 *    the server wants a key (API key or bearer token).
 */

export interface ProbeResult {
  kind: McpAuthKind;
  /** OAuth: the authorization server (issuer) to sign in with. */
  issuer?: string;
  /** OAuth: the scopes the server asks for (WWW-Authenticate scope, else the metadata's scopes_supported). */
  scopes?: string[];
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "companion-probe", version: "1" } },
});

/** A parameter of a WWW-Authenticate header (`key="value"` or `key=value`). */
export function authParam(header: string | null, key: string): string | undefined {
  if (!header) return undefined;
  const m = new RegExp(`(?:^|[\\s,])${key}="([^"]*)"|(?:^|[\\s,])${key}=([^\\s,]+)`, "i").exec(header);
  return m ? (m[1] ?? m[2]) : undefined;
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The RFC 9728 metadata URLs of `serverUrl`: path-specific first, then the origin's. */
export function resourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const urls = [`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`];
  return [...new Set(urls)];
}

function scopeList(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string");
  return undefined;
}

export async function probeMcpServer(serverUrl: string, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  let status: number;
  let wwwAuth: string | null;
  try {
    const res = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: INITIALIZE,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    wwwAuth = res.headers.get("www-authenticate");
    await res.body?.cancel();
  } catch (err) {
    throw new Error(`The server did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }

  const headerMeta = authParam(wwwAuth, "resource_metadata");
  for (const url of [...(headerMeta ? [headerMeta] : []), ...resourceMetadataUrls(serverUrl)]) {
    const meta = await getJson(url, fetchImpl);
    const servers = meta?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      return {
        kind: "oauth",
        issuer: servers[0],
        scopes: scopeList(authParam(wwwAuth, "scope")) ?? scopeList(meta?.scopes_supported),
      };
    }
  }

  if (status === 401) {
    const origin = new URL(serverUrl).origin;
    if (await getJson(`${origin}/.well-known/oauth-authorization-server`, fetchImpl)) {
      return { kind: "oauth", issuer: origin, scopes: scopeList(authParam(wwwAuth, "scope")) };
    }
    return { kind: "apiKey" };
  }
  if (status === 403) return { kind: "apiKey" };
  return { kind: "open" };
}
