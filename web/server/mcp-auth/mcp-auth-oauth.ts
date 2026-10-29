import { createHash, randomBytes } from "node:crypto";
import { getCompanionPort } from "../brain/brain-endpoints.js";
import { readOwnerAuth, serversOfGrant, updateOwnerAuth, type OAuthGrant, type OwnerAuth } from "./mcp-auth-store.js";

/**
 * OAuth sign-in to private MCP servers, done by Companion itself (not by a
 * CLI), so one login serves every Claude and Codex session of the owner:
 *
 *  - discovery: the issuer's metadata (RFC 8414, else OpenID Connect);
 *  - client: registered by Companion when the issuer allows it (RFC 7591),
 *    else the client ID (and secret) the user gives on the Domains page;
 *  - authorization code with PKCE (S256) and `state`, redirected to
 *    `http://localhost:<port>/api/mcp-auth/callback`. With the browser on
 *    another device that page does not load: the user pastes its address;
 *  - tokens kept in the owner's file, refreshed before they expire (and on
 *    a 401, mcp-auth-proxy.ts).
 *
 * Provider presets cover what the protocol does not say: Google issues a
 * refresh token only with `access_type=offline` and `prompt=consent`, and its
 * Workspace MCP servers advertise far broader scopes than they need.
 */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 120_000;
const PENDING_TTL_MS = 15 * 60_000;

export class McpAuthError extends Error {
  constructor(message: string, readonly code: "needs-client" | "not-oauth" | "not-signed-in" | "bad-callback" | "provider") {
    super(message);
  }
}

// ── Provider presets ────────────────────────────────────────────────────────

const GOOGLE = "https://www.googleapis.com/auth/";
const GOOGLE_DRIVE = [`${GOOGLE}drive.readonly`, `${GOOGLE}drive.file`];
/** Scopes Google documents for each of its Workspace MCP servers (developers.google.com/workspace/guides/configure-mcp-servers). */
const GOOGLE_MCP_SCOPES: Record<string, string[]> = {
  "drivemcp.googleapis.com": GOOGLE_DRIVE,
  "gmailmcp.googleapis.com": [`${GOOGLE}gmail.readonly`, `${GOOGLE}gmail.compose`],
  "calendarmcp.googleapis.com": [
    `${GOOGLE}calendar.calendarlist.readonly`,
    `${GOOGLE}calendar.events.freebusy`,
    `${GOOGLE}calendar.events.readonly`,
  ],
  "docsmcp.googleapis.com": [...GOOGLE_DRIVE, `${GOOGLE}documents.readonly`, `${GOOGLE}documents`],
  "sheetsmcp.googleapis.com": [...GOOGLE_DRIVE, `${GOOGLE}spreadsheets.readonly`, `${GOOGLE}spreadsheets`],
  "slidesmcp.googleapis.com": [...GOOGLE_DRIVE, `${GOOGLE}presentations.readonly`, `${GOOGLE}presentations`],
};

export function isGoogleIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

/** Grant-level settings of a provider: extra authorization parameters and scopes always asked. */
export function issuerPreset(issuer: string): Pick<OAuthGrant, "extraAuthParams" | "baseScopes"> {
  if (isGoogleIssuer(issuer)) return { extraAuthParams: { access_type: "offline", prompt: "consent" }, baseScopes: ["openid", "email"] };
  return {};
}

/** The scopes a server needs: a provider's documented list when known, else what the server asked for. */
export function serverScopes(serverUrl: string, probed: string[] | undefined): string[] | undefined {
  try {
    const preset = GOOGLE_MCP_SCOPES[new URL(serverUrl).hostname];
    if (preset) return preset;
  } catch { /* not a URL: keep the probed scopes */ }
  return probed;
}

// ── Discovery and client ────────────────────────────────────────────────────

export function callbackRedirectUri(): string {
  return `http://localhost:${getCompanionPort()}/api/mcp-auth/callback`;
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch { /* not JSON */ }
  return { status: res.status, body };
}

/** The issuer's metadata URLs, RFC 8414 first, then the OpenID Connect forms. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return [...new Set([
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
    `${u.origin}/.well-known/openid-configuration${path}`,
  ])];
}

/** Endpoints of `issuer`, from its metadata. */
export async function discoverIssuer(issuer: string, fetchImpl: FetchLike = fetch): Promise<Pick<OAuthGrant, "authorizationEndpoint" | "tokenEndpoint" | "revocationEndpoint" | "registrationEndpoint" | "tokenAuthMethods">> {
  for (const url of authServerMetadataUrls(issuer)) {
    let meta: Record<string, unknown> | null = null;
    try {
      const r = await fetchJson(fetchImpl, url, { headers: { Accept: "application/json" } });
      if (r.status === 200) meta = r.body;
    } catch { /* try the next form */ }
    if (!meta || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") continue;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const methods = meta.token_endpoint_auth_methods_supported;
    return {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      revocationEndpoint: str(meta.revocation_endpoint),
      registrationEndpoint: str(meta.registration_endpoint),
      tokenAuthMethods: Array.isArray(methods) ? methods.filter((m): m is string => typeof m === "string") : undefined,
    };
  }
  throw new McpAuthError(`No OAuth metadata found for ${issuer}`, "provider");
}

/** The owner's grant for `issuer`, its endpoints discovered on first use (saved with the preset). */
async function grantFor(owner: string, issuer: string, fetchImpl: FetchLike): Promise<OAuthGrant> {
  const existing = readOwnerAuth(owner).grants[issuer];
  if (existing?.authorizationEndpoint && existing.tokenEndpoint) return existing;
  const endpoints = await discoverIssuer(issuer, fetchImpl);
  return updateOwnerAuth(owner, (d) => {
    d.grants[issuer] = { ...issuerPreset(issuer), ...d.grants[issuer], ...endpoints, issuer };
    return d.grants[issuer];
  });
}

/** Register Companion as a client of the issuer (RFC 7591), for `redirectUri`. */
async function registerClient(owner: string, grant: OAuthGrant, redirectUri: string, fetchImpl: FetchLike): Promise<OAuthGrant> {
  const r = await fetchJson(fetchImpl, grant.registrationEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Companion",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const clientId = r.body?.client_id;
  if (r.status >= 300 || typeof clientId !== "string") {
    throw new McpAuthError(`The issuer refused to register Companion (HTTP ${r.status})`, "provider");
  }
  const secret = r.body?.client_secret;
  return updateOwnerAuth(owner, (d) => {
    const g = { ...d.grants[grant.issuer], clientId, clientSecret: typeof secret === "string" ? secret : undefined, dynamicClient: true, redirectUri };
    d.grants[grant.issuer] = g;
    return g;
  });
}

/** Set (or clear, with an empty id) the client the user registered with the provider. */
export function setGrantClient(owner: string, issuer: string, clientId: string, clientSecret: string | undefined): void {
  updateOwnerAuth(owner, (d) => {
    const g: OAuthGrant = d.grants[issuer] ?? { issuer, authorizationEndpoint: "", tokenEndpoint: "", ...issuerPreset(issuer) };
    // A new client invalidates the tokens of the old one.
    const changed = g.clientId !== clientId;
    d.grants[issuer] = {
      ...g,
      clientId: clientId || undefined,
      // An empty secret keeps the stored one (the page never sees it).
      clientSecret: clientSecret === undefined ? (changed ? undefined : g.clientSecret) : clientSecret || undefined,
      dynamicClient: false,
      ...(changed ? { accessToken: undefined, refreshToken: undefined, expiresAt: undefined, account: undefined } : {}),
    };
  });
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

interface PendingLogin {
  owner: string;
  issuer: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

const pending = new Map<string, PendingLogin>();

function prunePending(now = Date.now()): void {
  for (const [state, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
}

/** The scopes the grant asks for: its base scopes plus every server's. */
export function grantScopes(data: OwnerAuth, issuer: string): string[] {
  const out = new Set(data.grants[issuer]?.baseScopes ?? []);
  for (const name of serversOfGrant(data, issuer)) for (const s of data.servers[name].scopes ?? []) out.add(s);
  return [...out];
}

/** Start signing `serverName` (and every server sharing its grant) in: the URL to open. */
export async function startSignIn(owner: string, serverName: string, fetchImpl: FetchLike = fetch): Promise<{ authUrl: string; redirectUri: string }> {
  const server = readOwnerAuth(owner).servers[serverName];
  if (server?.kind !== "oauth" || !server.issuer) throw new McpAuthError(`${serverName} does not use OAuth`, "not-oauth");
  let grant = await grantFor(owner, server.issuer, fetchImpl);
  const redirectUri = callbackRedirectUri();
  if (!grant.clientId || (grant.dynamicClient && grant.redirectUri !== redirectUri)) {
    if (!grant.registrationEndpoint) {
      throw new McpAuthError("This provider needs a client ID: register an OAuth client with it and enter its ID (and secret)", "needs-client");
    }
    grant = await registerClient(owner, grant, redirectUri, fetchImpl);
  }
  prunePending();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  pending.set(state, { owner, issuer: grant.issuer, verifier, redirectUri, createdAt: Date.now() });

  const data = readOwnerAuth(owner);
  const servers = serversOfGrant(data, grant.issuer);
  const url = new URL(grant.authorizationEndpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: grant.clientId!,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...grant.extraAuthParams,
  };
  const scopes = grantScopes(data, grant.issuer);
  if (scopes.length > 0) params.scope = scopes.join(" ");
  // RFC 8707: name the resource when the grant serves one server only.
  if (servers.length === 1) params.resource = data.servers[servers[0]].url;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { authUrl: url.toString(), redirectUri };
}

function idTokenAccount(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    const who = claims.email ?? claims.preferred_username ?? claims.sub;
    return typeof who === "string" ? who : undefined;
  } catch {
    return undefined;
  }
}

/** POST to the token endpoint with the client's authentication. */
async function tokenRequest(grant: OAuthGrant, fields: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams({ ...fields, client_id: grant.clientId ?? "" });
  if (grant.clientSecret) {
    const methods = grant.tokenAuthMethods;
    if (methods && !methods.includes("client_secret_post") && methods.includes("client_secret_basic")) {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(grant.clientId ?? "")}:${encodeURIComponent(grant.clientSecret)}`).toString("base64")}`;
    } else {
      body.set("client_secret", grant.clientSecret);
    }
  }
  const r = await fetchJson(fetchImpl, grant.tokenEndpoint, { method: "POST", headers, body: body.toString() });
  if (r.status !== 200 || typeof r.body?.access_token !== "string") {
    const reason = typeof r.body?.error === "string" ? r.body.error : `HTTP ${r.status}`;
    const detail = typeof r.body?.error_description === "string" ? `: ${r.body.error_description}` : "";
    throw new McpAuthError(`The token endpoint refused (${reason}${detail})`, "provider");
  }
  return r.body;
}

function expiry(body: Record<string, unknown>): number | undefined {
  const s = Number(body.expires_in);
  return Number.isFinite(s) && s > 0 ? Date.now() + s * 1000 : undefined;
}

/**
 * Finish a sign-in from the address the sign-in page redirected to (the
 * callback route, or pasted by the user). Returns who signed in where.
 */
export async function finishSignIn(redirectedTo: string, fetchImpl: FetchLike = fetch): Promise<{ owner: string; issuer: string; servers: string[]; account?: string }> {
  let q: URLSearchParams;
  try {
    q = new URL(redirectedTo.trim()).searchParams;
  } catch {
    throw new McpAuthError("Paste the full address the sign-in page ended on (http://localhost:…/api/mcp-auth/callback?…)", "bad-callback");
  }
  const state = q.get("state") ?? "";
  prunePending();
  const login = pending.get(state);
  if (!login) throw new McpAuthError("This sign-in is unknown or expired: start it again", "bad-callback");
  pending.delete(state);
  const error = q.get("error");
  if (error) throw new McpAuthError(`The provider refused the sign-in: ${q.get("error_description") ?? error}`, "provider");
  const code = q.get("code");
  if (!code) throw new McpAuthError("The address has no authorization code", "bad-callback");

  const grant = readOwnerAuth(login.owner).grants[login.issuer];
  if (!grant) throw new McpAuthError("The sign-in's provider was removed meanwhile", "bad-callback");
  const tok = await tokenRequest(grant, {
    grant_type: "authorization_code",
    code,
    redirect_uri: login.redirectUri,
    code_verifier: login.verifier,
  }, fetchImpl);
  return updateOwnerAuth(login.owner, (d) => {
    const g = d.grants[login.issuer];
    const account = idTokenAccount(tok.id_token);
    d.grants[login.issuer] = {
      ...g,
      accessToken: tok.access_token as string,
      refreshToken: typeof tok.refresh_token === "string" ? tok.refresh_token : g.refreshToken,
      expiresAt: expiry(tok),
      grantedScopes: typeof tok.scope === "string" ? tok.scope.split(/\s+/).filter(Boolean) : undefined,
      account,
      error: undefined,
    };
    return { owner: login.owner, issuer: login.issuer, servers: serversOfGrant(d, login.issuer), account };
  });
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export function isSignedIn(g: OAuthGrant | undefined): boolean {
  if (!g?.accessToken) return false;
  return !!g.refreshToken || !g.expiresAt || g.expiresAt > Date.now();
}

const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for `issuer`'s grant: the stored one, or a refreshed
 * one when it expires within two minutes (or `force`, after a 401). One
 * refresh at a time per grant. A refused refresh signs the grant out.
 */
export async function accessToken(owner: string, issuer: string, opts: { force?: boolean } = {}, fetchImpl: FetchLike = fetch): Promise<string> {
  const g = readOwnerAuth(owner).grants[issuer];
  if (!g?.accessToken) throw new McpAuthError("Not signed in", "not-signed-in");
  const fresh = !g.expiresAt || g.expiresAt - EXPIRY_MARGIN_MS > Date.now();
  if (fresh && !opts.force) return g.accessToken;
  if (!g.refreshToken) {
    if (fresh) return g.accessToken;
    throw new McpAuthError("The sign-in expired and the provider gave no refresh token: sign in again", "not-signed-in");
  }
  const key = `${owner}\n${issuer}`;
  const running = refreshing.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const tok = await tokenRequest(g, { grant_type: "refresh_token", refresh_token: g.refreshToken! }, fetchImpl);
      return updateOwnerAuth(owner, (d) => {
        d.grants[issuer] = {
          ...d.grants[issuer],
          accessToken: tok.access_token as string,
          refreshToken: typeof tok.refresh_token === "string" ? tok.refresh_token : d.grants[issuer].refreshToken,
          expiresAt: expiry(tok),
          error: undefined,
        };
        return tok.access_token as string;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // invalid_grant: the refresh token is dead (revoked, expired): sign in again.
      if (message.includes("invalid_grant")) {
        updateOwnerAuth(owner, (d) => {
          d.grants[issuer] = { ...d.grants[issuer], accessToken: undefined, refreshToken: undefined, expiresAt: undefined, error: "The sign-in was revoked or expired: sign in again" };
        });
        throw new McpAuthError("The sign-in was revoked or expired: sign in again", "not-signed-in");
      }
      throw err;
    } finally {
      refreshing.delete(key);
    }
  })();
  refreshing.set(key, job);
  return job;
}

/** Forget the grant's tokens, revoking them at the provider when it offers that (best effort). */
export async function signOut(owner: string, issuer: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const g = readOwnerAuth(owner).grants[issuer];
  if (!g) return;
  const token = g.refreshToken ?? g.accessToken;
  if (token && g.revocationEndpoint) {
    try {
      await tokenRequest({ ...g, tokenEndpoint: g.revocationEndpoint }, { token }, fetchImpl);
    } catch { /* revocation answers vary (200 with no token): local sign-out is what counts */ }
  }
  updateOwnerAuth(owner, (d) => {
    d.grants[issuer] = { ...d.grants[issuer], accessToken: undefined, refreshToken: undefined, expiresAt: undefined, account: undefined, grantedScopes: undefined, error: undefined };
  });
}

/** For tests: forget the sign-ins in progress. */
export function resetPendingSignIns(): void {
  pending.clear();
}
