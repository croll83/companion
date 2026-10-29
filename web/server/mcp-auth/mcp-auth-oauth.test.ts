import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Companion's own OAuth client for private MCP servers, against a fake
 * provider. What matters: the sign-in URL carries PKCE, state, the scopes of
 * every server sharing the grant and the provider's extra parameters (Google
 * gives a refresh token only with access_type=offline + prompt=consent);
 * the code exchange proves the verifier; tokens are refreshed before they
 * expire, once at a time, and a dead refresh token signs the grant out.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { setCompanionPort } from "../brain/brain-endpoints.js";
import {
  McpAuthError,
  accessToken,
  authServerMetadataUrls,
  callbackRedirectUri,
  discoverIssuer,
  finishSignIn,
  grantScopes,
  isGoogleIssuer,
  isSignedIn,
  issuerPreset,
  resetPendingSignIns,
  serverScopes,
  setGrantClient,
  signOut,
  startSignIn,
} from "./mcp-auth-oauth.js";
import { readOwnerAuth, updateOwnerAuth, writeOwnerAuth } from "./mcp-auth-store.js";

const ISS = "https://as.example";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Seen { url: string; method: string; body: string; headers: Headers }

function provider(over: Record<string, (s: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  const routes: Record<string, (s: Seen) => Response> = {
    [`GET ${ISS}/.well-known/oauth-authorization-server`]: () =>
      json({ issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, registration_endpoint: `${ISS}/register`, revocation_endpoint: `${ISS}/revoke` }),
    [`POST ${ISS}/register`]: () => json({ client_id: "dyn-client" }, 201),
    [`POST ${ISS}/token`]: () => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "a b" }),
    [`POST ${ISS}/revoke`]: () => new Response("", { status: 200 }),
    ...over,
  };
  const fn = async (url: string, init?: RequestInit) => {
    const s: Seen = { url, method: init?.method ?? "GET", body: String(init?.body ?? ""), headers: new Headers(init?.headers) };
    seen.push(s);
    const route = routes[`${s.method} ${url}`];
    return route ? route(s) : new Response("nf", { status: 404 });
  };
  return { fn, seen };
}

function oneServer(scopes = ["read"]) {
  writeOwnerAuth("herd", { servers: { srv: { kind: "oauth", url: "https://srv.example/mcp", issuer: ISS, scopes, checkedAt: 1 } }, grants: {} });
}

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), "mcp-auth-oauth-"));
  setCompanionPort(3456);
  resetPendingSignIns();
});
afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
});

describe("presets and helpers", () => {
  it("knows Google's quirks and documented Workspace scopes", () => {
    expect(isGoogleIssuer("https://accounts.google.com/")).toBe(true);
    expect(isGoogleIssuer("https://as.example")).toBe(false);
    expect(isGoogleIssuer("not a url")).toBe(false);
    expect(issuerPreset("https://accounts.google.com/")).toEqual({ extraAuthParams: { access_type: "offline", prompt: "consent" }, baseScopes: ["openid", "email"] });
    expect(issuerPreset(ISS)).toEqual({});
    // Google advertises full drive and mail scopes; its docs list narrower ones.
    expect(serverScopes("https://drivemcp.googleapis.com/mcp/v1", ["https://www.googleapis.com/auth/drive"])).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]);
    expect(serverScopes("https://srv.example/mcp", ["x"])).toEqual(["x"]);
    expect(serverScopes("nope", ["x"])).toEqual(["x"]);
  });

  it("builds the redirect URI on Companion's port and the issuer metadata URLs", () => {
    expect(callbackRedirectUri()).toBe("http://localhost:3456/api/mcp-auth/callback");
    expect(authServerMetadataUrls("https://accounts.google.com/")).toEqual([
      "https://accounts.google.com/.well-known/oauth-authorization-server",
      "https://accounts.google.com/.well-known/openid-configuration",
    ]);
    expect(authServerMetadataUrls("https://x.io/tenant")).toEqual([
      "https://x.io/.well-known/oauth-authorization-server/tenant",
      "https://x.io/tenant/.well-known/openid-configuration",
      "https://x.io/.well-known/openid-configuration/tenant",
    ]);
  });

  it("counts a grant signed in while it has a refresh token or an unexpired access token", () => {
    expect(isSignedIn(undefined)).toBe(false);
    const g = { issuer: ISS, authorizationEndpoint: "", tokenEndpoint: "" };
    expect(isSignedIn({ ...g, accessToken: "a" })).toBe(true);
    expect(isSignedIn({ ...g, accessToken: "a", expiresAt: Date.now() - 1 })).toBe(false);
    expect(isSignedIn({ ...g, accessToken: "a", expiresAt: Date.now() - 1, refreshToken: "r" })).toBe(true);
  });
});

describe("discoverIssuer", () => {
  it("falls back to OpenID Connect metadata and reads the endpoints", async () => {
    const { fn } = provider({
      [`GET ${ISS}/.well-known/oauth-authorization-server`]: () => json({}, 404),
      [`GET ${ISS}/.well-known/openid-configuration`]: () =>
        json({ authorization_endpoint: `${ISS}/auth`, token_endpoint: `${ISS}/tok`, token_endpoint_auth_methods_supported: ["client_secret_basic", 3] }),
    });
    expect(await discoverIssuer(ISS, fn)).toEqual({
      authorizationEndpoint: `${ISS}/auth`,
      tokenEndpoint: `${ISS}/tok`,
      revocationEndpoint: undefined,
      registrationEndpoint: undefined,
      tokenAuthMethods: ["client_secret_basic"],
    });
  });

  it("fails when no metadata form answers", async () => {
    const fn = async () => { throw new Error("down"); };
    await expect(discoverIssuer(ISS, fn)).rejects.toThrow(/No OAuth metadata found/);
  });
});

describe("sign-in", () => {
  it("registers Companion as a client when the issuer allows it, then builds a PKCE URL", async () => {
    oneServer();
    const { fn, seen } = provider();
    const { authUrl, redirectUri } = await startSignIn("herd", "srv", fn);
    expect(redirectUri).toBe("http://localhost:3456/api/mcp-auth/callback");
    const reg = seen.find((s) => s.url === `${ISS}/register`)!;
    expect(JSON.parse(reg.body)).toMatchObject({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
    const u = new URL(authUrl);
    expect(u.origin + u.pathname).toBe(`${ISS}/authorize`);
    expect(u.searchParams.get("client_id")).toBe("dyn-client");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("read");
    // One server on the grant: its URL is named as the resource (RFC 8707).
    expect(u.searchParams.get("resource")).toBe("https://srv.example/mcp");
    expect(readOwnerAuth("herd").grants[ISS]).toMatchObject({ clientId: "dyn-client", dynamicClient: true, redirectUri });
  });

  it("asks for a client ID when the issuer cannot register one", async () => {
    oneServer();
    const { fn } = provider({
      [`GET ${ISS}/.well-known/oauth-authorization-server`]: () => json({ authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token` }),
    });
    const err = await startSignIn("herd", "srv", fn).catch((e) => e);
    expect(err).toBeInstanceOf(McpAuthError);
    expect(err.code).toBe("needs-client");
  });

  it("refuses servers that do not use OAuth", async () => {
    writeOwnerAuth("herd", { servers: { k: { kind: "apiKey", url: "https://k", checkedAt: 1 } }, grants: {} });
    await expect(startSignIn("herd", "k")).rejects.toMatchObject({ code: "not-oauth" });
    await expect(startSignIn("herd", "missing")).rejects.toMatchObject({ code: "not-oauth" });
  });

  // Google: a client the user registered, one sign-in for several servers.
  it("with a manual client, asks once for the scopes of every server and the provider's extras", async () => {
    const G = "https://accounts.google.com/";
    writeOwnerAuth("acme", {
      servers: {
        drive: { kind: "oauth", url: "https://drivemcp.googleapis.com/mcp/v1", issuer: G, scopes: ["d1", "shared"], checkedAt: 1 },
        gmail: { kind: "oauth", url: "https://gmailmcp.googleapis.com/mcp/v1", issuer: G, scopes: ["g1", "shared"], checkedAt: 1 },
      },
      grants: {},
    });
    setGrantClient("acme", G, "cid.apps", "sec");
    updateOwnerAuth("acme", (d) => { Object.assign(d.grants[G], { authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint: "https://oauth2.googleapis.com/token" }); });
    const { authUrl } = await startSignIn("acme", "gmail", async () => { throw new Error("no network needed"); });
    const u = new URL(authUrl);
    expect(u.searchParams.get("client_id")).toBe("cid.apps");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")!.split(" ").sort()).toEqual(["d1", "email", "g1", "openid", "shared"]);
    expect(u.searchParams.get("resource")).toBeNull();
    expect(grantScopes(readOwnerAuth("acme"), G).length).toBe(5);
  });

  it("finishes from the redirected address, proving the PKCE verifier, and keeps the account", async () => {
    oneServer();
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@acme.example" })).toString("base64url")}.y`;
    const { fn, seen } = provider({ [`POST ${ISS}/token`]: () => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "read", id_token: idToken }) });
    const { authUrl } = await startSignIn("herd", "srv", fn);
    const u = new URL(authUrl);
    const done = await finishSignIn(`http://localhost:3456/api/mcp-auth/callback?code=abc&state=${u.searchParams.get("state")}`, fn);
    expect(done).toEqual({ owner: "herd", issuer: ISS, servers: ["srv"], account: "me@acme.example" });
    const body = new URLSearchParams(seen.find((s) => s.url === `${ISS}/token`)!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("dyn-client");
    // The challenge sent earlier is the SHA-256 of the verifier sent now.
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
    expect(readOwnerAuth("herd").grants[ISS]).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1", grantedScopes: ["read"], account: "me@acme.example" });
    // The state is single use.
    await expect(finishSignIn(`http://localhost/cb?code=abc&state=${u.searchParams.get("state")}`, fn)).rejects.toMatchObject({ code: "bad-callback" });
  });

  it("rejects bad pastes, unknown states, provider errors and missing codes", async () => {
    oneServer();
    const { fn } = provider();
    await expect(finishSignIn("not a url", fn)).rejects.toMatchObject({ code: "bad-callback" });
    await expect(finishSignIn("http://localhost/cb?code=a&state=unknown", fn)).rejects.toMatchObject({ code: "bad-callback" });
    const s1 = new URL((await startSignIn("herd", "srv", fn)).authUrl).searchParams.get("state");
    await expect(finishSignIn(`http://localhost/cb?error=access_denied&state=${s1}`, fn)).rejects.toThrow(/refused the sign-in: access_denied/);
    const s2 = new URL((await startSignIn("herd", "srv", fn)).authUrl).searchParams.get("state");
    await expect(finishSignIn(`http://localhost/cb?state=${s2}`, fn)).rejects.toThrow(/no authorization code/);
  });

  it("reports a refused code exchange with the provider's reason", async () => {
    oneServer();
    const { fn } = provider({ [`POST ${ISS}/token`]: () => json({ error: "invalid_client", error_description: "bad secret" }, 401) });
    const state = new URL((await startSignIn("herd", "srv", fn)).authUrl).searchParams.get("state");
    await expect(finishSignIn(`http://localhost/cb?code=c&state=${state}`, fn)).rejects.toThrow("The token endpoint refused (invalid_client: bad secret)");
  });

  it("sends the secret with HTTP Basic when the issuer only takes that", async () => {
    oneServer();
    const { fn, seen } = provider({
      [`GET ${ISS}/.well-known/oauth-authorization-server`]: () =>
        json({ authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
    });
    setGrantClient("herd", ISS, "cid", "s3cret");
    const state = new URL((await startSignIn("herd", "srv", fn)).authUrl).searchParams.get("state");
    await finishSignIn(`http://localhost/cb?code=c&state=${state}`, fn);
    const tok = seen.find((s) => s.url === `${ISS}/token`)!;
    expect(tok.headers.get("authorization")).toBe(`Basic ${Buffer.from("cid:s3cret").toString("base64")}`);
    expect(new URLSearchParams(tok.body).get("client_secret")).toBeNull();
  });
});

describe("setGrantClient", () => {
  it("a new client forgets the old tokens; an empty secret keeps the stored one", () => {
    oneServer();
    setGrantClient("herd", ISS, "c1", "s1");
    updateOwnerAuth("herd", (d) => { d.grants[ISS].accessToken = "old"; });
    setGrantClient("herd", ISS, "c1", undefined);
    expect(readOwnerAuth("herd").grants[ISS]).toMatchObject({ clientId: "c1", clientSecret: "s1", accessToken: "old" });
    setGrantClient("herd", ISS, "c2", undefined);
    expect(readOwnerAuth("herd").grants[ISS]).toMatchObject({ clientId: "c2" });
    expect(readOwnerAuth("herd").grants[ISS].accessToken).toBeUndefined();
    expect(readOwnerAuth("herd").grants[ISS].clientSecret).toBeUndefined();
  });
});

describe("accessToken", () => {
  function signedIn(over: Record<string, unknown> = {}) {
    oneServer();
    updateOwnerAuth("herd", (d) => {
      d.grants[ISS] = { issuer: ISS, authorizationEndpoint: `${ISS}/authorize`, tokenEndpoint: `${ISS}/token`, clientId: "c", accessToken: "at-0", refreshToken: "rt-0", expiresAt: Date.now() + 3_600_000, ...over };
    });
  }

  it("returns the stored token while fresh, and refreshes when forced", async () => {
    signedIn();
    const { fn, seen } = provider({ [`POST ${ISS}/token`]: () => json({ access_token: "at-2", expires_in: 60 }) });
    expect(await accessToken("herd", ISS, {}, fn)).toBe("at-0");
    expect(seen).toHaveLength(0);
    expect(await accessToken("herd", ISS, { force: true }, fn)).toBe("at-2");
    expect(new URLSearchParams(seen[0].body).get("refresh_token")).toBe("rt-0");
    // The provider sent no new refresh token: the old one stays.
    expect(readOwnerAuth("herd").grants[ISS].refreshToken).toBe("rt-0");
  });

  it("refreshes a token about to expire, once for concurrent callers", async () => {
    signedIn({ expiresAt: Date.now() + 30_000 });
    const { fn, seen } = provider({ [`POST ${ISS}/token`]: () => json({ access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 }) });
    const [a, b] = await Promise.all([accessToken("herd", ISS, {}, fn), accessToken("herd", ISS, {}, fn)]);
    expect([a, b]).toEqual(["at-3", "at-3"]);
    expect(seen.filter((s) => s.url === `${ISS}/token`)).toHaveLength(1);
    expect(readOwnerAuth("herd").grants[ISS].refreshToken).toBe("rt-3");
  });

  it("signs out when the refresh token is refused", async () => {
    signedIn({ expiresAt: Date.now() - 1 });
    const { fn } = provider({ [`POST ${ISS}/token`]: () => json({ error: "invalid_grant" }, 400) });
    await expect(accessToken("herd", ISS, {}, fn)).rejects.toMatchObject({ code: "not-signed-in" });
    const g = readOwnerAuth("herd").grants[ISS];
    expect(g.accessToken).toBeUndefined();
    expect(g.error).toMatch(/sign in again/);
  });

  it("passes other refresh failures through without signing out", async () => {
    signedIn({ expiresAt: Date.now() - 1 });
    const { fn } = provider({ [`POST ${ISS}/token`]: () => json({ error: "temporarily_unavailable" }, 503) });
    await expect(accessToken("herd", ISS, {}, fn)).rejects.toThrow(/temporarily_unavailable/);
    expect(readOwnerAuth("herd").grants[ISS].refreshToken).toBe("rt-0");
  });

  it("without a refresh token: the token while valid, then a sign-in", async () => {
    signedIn({ refreshToken: undefined });
    expect(await accessToken("herd", ISS, { force: true })).toBe("at-0");
    updateOwnerAuth("herd", (d) => { d.grants[ISS].expiresAt = Date.now() - 1; });
    await expect(accessToken("herd", ISS)).rejects.toMatchObject({ code: "not-signed-in" });
    await expect(accessToken("herd", "https://unknown")).rejects.toMatchObject({ code: "not-signed-in" });
  });
});

describe("signOut", () => {
  it("revokes at the provider and forgets the tokens", async () => {
    oneServer();
    updateOwnerAuth("herd", (d) => {
      d.grants[ISS] = { issuer: ISS, authorizationEndpoint: "a", tokenEndpoint: `${ISS}/token`, revocationEndpoint: `${ISS}/revoke`, clientId: "c", accessToken: "at", refreshToken: "rt", account: "me" };
    });
    const { fn, seen } = provider();
    await signOut("herd", ISS, fn);
    expect(new URLSearchParams(seen.find((s) => s.url === `${ISS}/revoke`)!.body).get("token")).toBe("rt");
    const g = readOwnerAuth("herd").grants[ISS];
    expect(g.accessToken).toBeUndefined();
    expect(g.account).toBeUndefined();
    expect(g.clientId).toBe("c");
    await signOut("herd", "https://none", fn);
  });
});
