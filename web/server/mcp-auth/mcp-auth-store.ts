import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "../paths.js";
import { ensurePrivateDir, writePrivateFile } from "../private-file.js";

/**
 * How Companion reaches the private MCP servers of a domain's (or GLOBAL's)
 * mcp.json: one owner-only file per owner, `COMPANION_HOME/mcp-auth/<owner>.json`.
 *
 *  - `servers`: per server name, the access it needs (found by the probe,
 *    mcp-auth-probe.ts) and, for an API key, the header to send.
 *  - `grants`: per OAuth issuer, the client and the tokens. The servers of
 *    one owner signed in through the same issuer share one grant, so one
 *    sign-in (with the scopes of all of them) serves them all.
 *
 * Secrets (client secret, tokens, API keys) never leave this file except
 * toward the server they belong to (mcp-auth-proxy.ts); the Domains page gets
 * a view without them (mcp-auth-view.ts).
 */

export type McpAuthKind = "open" | "oauth" | "apiKey";

export interface ServerAuth {
  kind: McpAuthKind;
  /** The server URL when it was probed: a changed URL means probing again. */
  url: string;
  /** OAuth: the issuer of its grant. */
  issuer?: string;
  /** OAuth: the scopes this server needs (the grant asks for the union). */
  scopes?: string[];
  /** API key: the header carrying it and its full value (e.g. `Authorization`, `Bearer ...`). */
  header?: string;
  value?: string;
  checkedAt: number;
}

export interface OAuthGrant {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  /** Token endpoint client authentication methods the issuer advertises. */
  tokenAuthMethods?: string[];
  clientId?: string;
  clientSecret?: string;
  /** The client was registered by Companion (RFC 7591), not given by the user. */
  dynamicClient?: boolean;
  /** Redirect URI the client was registered with (a dynamic client is tied to it). */
  redirectUri?: string;
  /** Extra authorization request parameters (provider presets, e.g. Google's access_type). */
  extraAuthParams?: Record<string, string>;
  /** Scopes the grant always asks for besides the servers' (e.g. `openid email` to show the account). */
  baseScopes?: string[];
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms; absent when the issuer did not say. */
  expiresAt?: number;
  /** Scopes granted at the last sign-in. */
  grantedScopes?: string[];
  /** Who signed in, when the issuer tells (OIDC id_token). */
  account?: string;
  /** Last failure (refresh refused...), cleared by a sign-in. */
  error?: string;
}

export interface OwnerAuth {
  servers: Record<string, ServerAuth>;
  grants: Record<string, OAuthGrant>;
}

export function mcpAuthDir(): string {
  return join(COMPANION_HOME, "mcp-auth");
}

function ownerFile(owner: string): string {
  return join(mcpAuthDir(), `${owner}.json`);
}

const OWNER_RE = /^[a-z0-9][a-z0-9-]*$/;

export function readOwnerAuth(owner: string): OwnerAuth {
  if (!OWNER_RE.test(owner)) return { servers: {}, grants: {} };
  try {
    const raw = JSON.parse(readFileSync(ownerFile(owner), "utf-8")) as Partial<OwnerAuth>;
    return {
      servers: raw.servers && typeof raw.servers === "object" ? raw.servers : {},
      grants: raw.grants && typeof raw.grants === "object" ? raw.grants : {},
    };
  } catch {
    return { servers: {}, grants: {} };
  }
}

export function writeOwnerAuth(owner: string, data: OwnerAuth): void {
  if (!OWNER_RE.test(owner)) throw new Error(`Invalid owner "${owner}"`);
  ensurePrivateDir(mcpAuthDir(), { fileSuffix: ".json" });
  // Grants no server uses any more are dropped with their tokens.
  const used = new Set(Object.values(data.servers).map((s) => s.issuer).filter(Boolean));
  const grants = Object.fromEntries(Object.entries(data.grants).filter(([issuer]) => used.has(issuer)));
  writePrivateFile(ownerFile(owner), `${JSON.stringify({ servers: data.servers, grants }, null, 2)}\n`);
}

/** Read, change and write an owner's file in one step. */
export function updateOwnerAuth<T>(owner: string, change: (data: OwnerAuth) => T): T {
  const data = readOwnerAuth(owner);
  const out = change(data);
  writeOwnerAuth(owner, data);
  return out;
}

/** Forget a server (removed from mcp.json); its grant goes when no other server uses it. */
export function removeServerAuth(owner: string, name: string): void {
  if (!existsSync(ownerFile(owner))) return;
  updateOwnerAuth(owner, (d) => { delete d.servers[name]; });
}

/** Drop an owner's whole file (domain deleted). */
export function removeOwnerAuth(owner: string): void {
  if (OWNER_RE.test(owner)) rmSync(ownerFile(owner), { force: true });
}

/** The servers of an owner that share `issuer`'s grant. */
export function serversOfGrant(data: OwnerAuth, issuer: string): string[] {
  return Object.entries(data.servers).filter(([, s]) => s.kind === "oauth" && s.issuer === issuer).map(([n]) => n).sort();
}
