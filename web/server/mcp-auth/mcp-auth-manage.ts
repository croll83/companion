import { GLOBAL_DOMAIN, readDomainMcp, type McpServerDef } from "../domain-store.js";
import { callbackRedirectUri, discoverIssuer, isSignedIn, issuerPreset, serverScopes } from "./mcp-auth-oauth.js";
import { probeMcpServer } from "./mcp-auth-probe.js";
import { readOwnerAuth, serversOfGrant, updateOwnerAuth, type ServerAuth } from "./mcp-auth-store.js";

/**
 * What the Domains page shows and does about a server's access: the view
 * (never a secret), probing, the API key and the owner of a server name.
 */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface McpAuthView {
  /** Whose credentials: the domain that declares the server, or "global". */
  owner: string;
  state:
    | "unchecked" // never probed, or its URL changed since
    | "open" // no credentials needed
    | "manual" // headers written in mcp.json by hand: Companion stays out
    | "needs-client" // OAuth, the provider needs a client ID from the user
    | "needs-sign-in"
    | "signed-in"
    | "needs-key"
    | "key-set";
  issuer?: string;
  account?: string;
  clientId?: string;
  hasClientSecret?: boolean;
  /** Companion registered the client itself. */
  dynamicClient?: boolean;
  scopes?: string[];
  /** Other servers of the owner signed in by the same sign-in. */
  sharedWith?: string[];
  /** The redirect URI to register with the provider. */
  redirectUri?: string;
  /** API key: the header it goes in. */
  header?: string;
  error?: string;
}

/** The owner of a server as a domain sees it: the domain's mcp.json wins over GLOBAL's. */
export function mcpServerOwner(slug: string, name: string): string | null {
  if (slug !== GLOBAL_DOMAIN && readDomainMcp(slug).servers[name]) return slug;
  return readDomainMcp(GLOBAL_DOMAIN).servers[name] ? GLOBAL_DOMAIN : null;
}

function hasHeaders(def: McpServerDef): boolean {
  return Object.keys(def.headers ?? {}).length > 0;
}

/** The server's stored access, when it still describes the current URL. */
export function currentServerAuth(owner: string, name: string, def: McpServerDef): ServerAuth | undefined {
  const auth = readOwnerAuth(owner).servers[name];
  return auth && auth.url === def.url ? auth : undefined;
}

export function mcpAuthView(owner: string, name: string, def: McpServerDef): McpAuthView | undefined {
  if (!def.url) return undefined;
  const auth = currentServerAuth(owner, name, def);
  if (!auth) return { owner, state: hasHeaders(def) ? "manual" : "unchecked" };
  if (auth.kind === "open") return { owner, state: "open" };
  if (auth.kind === "apiKey") return { owner, state: auth.value ? "key-set" : "needs-key", header: auth.header };
  const data = readOwnerAuth(owner);
  const g = auth.issuer ? data.grants[auth.issuer] : undefined;
  const state: McpAuthView["state"] = isSignedIn(g)
    ? "signed-in"
    : !g?.clientId && !g?.registrationEndpoint ? "needs-client" : "needs-sign-in";
  return {
    owner,
    state,
    issuer: auth.issuer,
    account: g?.account,
    clientId: g?.clientId,
    hasClientSecret: !!g?.clientSecret,
    dynamicClient: g?.dynamicClient,
    scopes: auth.scopes,
    sharedWith: auth.issuer ? serversOfGrant(data, auth.issuer).filter((n) => n !== name) : undefined,
    redirectUri: callbackRedirectUri(),
    error: g?.error,
  };
}

/**
 * Probe a server of `owner`'s mcp.json and store what it needs. For OAuth
 * the issuer's endpoints are discovered now, so the page knows at once
 * whether the provider needs a client ID. An API key already set is kept.
 */
export async function checkServer(owner: string, name: string, fetchImpl: FetchLike = fetch): Promise<ServerAuth> {
  const def = readDomainMcp(owner).servers[name];
  if (!def?.url) throw new Error(`No HTTP server "${name}" in ${owner === GLOBAL_DOMAIN ? "GLOBAL" : owner}'s mcp.json`);
  const probe = await probeMcpServer(def.url, fetchImpl);
  const endpoints = probe.kind === "oauth" && probe.issuer ? await discoverIssuer(probe.issuer, fetchImpl) : undefined;
  return updateOwnerAuth(owner, (d) => {
    const prev = d.servers[name];
    const keep = prev?.kind === "apiKey" && probe.kind === "apiKey" ? { header: prev.header, value: prev.value } : {};
    const auth: ServerAuth = {
      kind: probe.kind,
      url: def.url!,
      checkedAt: Date.now(),
      ...(probe.issuer ? { issuer: probe.issuer, scopes: serverScopes(def.url!, probe.scopes) } : {}),
      ...keep,
    };
    d.servers[name] = auth;
    if (probe.issuer && endpoints) {
      d.grants[probe.issuer] = { ...issuerPreset(probe.issuer), ...d.grants[probe.issuer], ...endpoints, issuer: probe.issuer };
    }
    return auth;
  });
}

/**
 * Set the API key of a server (marking it as needing one), or clear it with
 * an empty value. A bare value for `Authorization` becomes `Bearer <value>`.
 */
export function setApiKey(owner: string, name: string, header: string, value: string): void {
  const def = readDomainMcp(owner).servers[name];
  if (!def?.url) throw new Error(`No HTTP server "${name}"`);
  const h = header.trim() || "Authorization";
  if (!/^[A-Za-z0-9-]+$/.test(h)) throw new Error("Header name: letters, digits and \"-\"");
  let v = value.trim();
  if (v && h.toLowerCase() === "authorization" && !/^\S+\s+\S/.test(v)) v = `Bearer ${v}`;
  updateOwnerAuth(owner, (d) => {
    d.servers[name] = { kind: "apiKey", url: def.url!, header: h, ...(v ? { value: v } : {}), checkedAt: d.servers[name]?.checkedAt ?? Date.now() };
  });
}
