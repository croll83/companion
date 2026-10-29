import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The proxy sessions use for private MCP servers. It runs before Companion's
 * auth, so its checks are the security boundary: loopback only, an `mca_`
 * token signed by Companion, and a session reaches only its own domain's
 * servers and GLOBAL's. It must add the real credentials (never pass the
 * session's token on), retry a 401 once with a refreshed token, and never
 * hand a CLI a WWW-Authenticate that would start a login of its own.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { setCompanionPort } from "../brain/brain-endpoints.js";
import { handleMcpAuthProxy, mcpAuthProxyUrl, mintMcpAuthToken, tokenDomain } from "./mcp-auth-proxy.js";
import { readOwnerAuth, writeOwnerAuth } from "./mcp-auth-store.js";
import { resetPendingSignIns, startSignIn } from "./mcp-auth-oauth.js";

const ISS = "https://as.example";
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

function writeMcp(slug: string, servers: Record<string, unknown>) {
  const dir = join(h.home, "domains", `companion_domain_${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

function call(path: string, token: string | null, init: RequestInit = {}, addr = "127.0.0.1") {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("cookie", "secret=1");
  const req = new Request(`http://127.0.0.1:3456${path}`, { method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', ...init, headers });
  return handleMcpAuthProxy(req, addr, { fetch: upstream.fn });
}

const upstream = {
  calls: [] as { url: string; headers: Headers; body: string }[],
  answers: [] as (() => Response)[],
  fn: async (url: string, init?: RequestInit) => {
    upstream.calls.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "" });
    const next = upstream.answers.shift();
    return next ? next() : new Response('{"result":{}}', { status: 200, headers: { "content-type": "application/json", "content-length": "13" } });
  },
};

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), "mcp-auth-proxy-"));
  process.env.COMPANION_DOMAINS_ROOT = join(h.home, "domains");
  setCompanionPort(3456);
  upstream.calls = [];
  upstream.answers = [];
  resetPendingSignIns();
  writeMcp("herd", { key: { type: "http", url: "https://key.example/mcp" }, oa: { type: "http", url: "https://oa.example/mcp" }, cmd: { command: "x" } });
  writeMcp("global", { shared: { type: "http", url: "https://shared.example/mcp" } });
  writeOwnerAuth("herd", {
    servers: {
      key: { kind: "apiKey", url: "https://key.example/mcp", header: "X-Api-Key", value: "k-123", checkedAt: 1 },
      oa: { kind: "oauth", url: "https://oa.example/mcp", issuer: ISS, checkedAt: 1 },
    },
    grants: { [ISS]: { issuer: ISS, authorizationEndpoint: `${ISS}/a`, tokenEndpoint: `${ISS}/token`, clientId: "c", accessToken: "at-1", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } },
  });
});
afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
});

describe("session tokens", () => {
  it("name the session's domain, and a tampered token is refused", () => {
    const t = mintMcpAuthToken("herd", "s1");
    expect(tokenDomain(t)).toBe("herd");
    expect(tokenDomain(`${t}x`)).toBeNull();
    expect(tokenDomain(t.replace("mca_", "brn_"))).toBeNull();
    expect(tokenDomain(`${t}.extra`)).toBeNull();
    expect(tokenDomain(undefined)).toBeNull();
    // The key persists: a token stays valid after it is read again from disk.
    expect(tokenDomain(mintMcpAuthToken("herd", "s1"))).toBe("herd");
  });

  it("the proxy URL is on Companion's port", () => {
    expect(mcpAuthProxyUrl("herd", "key")).toBe("http://127.0.0.1:3456/mcp-auth/herd/key");
  });
});

describe("handleMcpAuthProxy", () => {
  it("leaves other paths to the caller", async () => {
    expect(await handleMcpAuthProxy(new Request("http://127.0.0.1/api/x"), "127.0.0.1")).toBeNull();
  });

  it("refuses non-loopback callers, missing tokens and other domains' servers", async () => {
    const herd = mintMcpAuthToken("herd", "s1");
    expect((await call("/mcp-auth/herd/key", herd, {}, "203.0.113.5"))!.status).toBe(403);
    expect((await call("/mcp-auth/herd/key", null))!.status).toBe(401);
    expect((await call("/mcp-auth/herd/key", mintMcpAuthToken("other", "s2")))!.status).toBe(403);
    expect((await call("/mcp-auth/herd/nope", herd))!.status).toBe(404);
    expect((await call("/mcp-auth/herd/cmd", herd))!.status).toBe(404);
    expect(upstream.calls).toHaveLength(0);
  });

  it("adds the API key, drops the session token and cookies, and strips hop-by-hop headers", async () => {
    const res = (await call("/mcp-auth/herd/key?x=1", mintMcpAuthToken("herd", "s1"), { headers: { "mcp-session-id": "abc" } }))!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"result":{}}');
    expect(res.headers.get("content-length")).toBeNull();
    const sent = upstream.calls[0];
    expect(sent.url).toBe("https://key.example/mcp?x=1");
    expect(sent.headers.get("x-api-key")).toBe("k-123");
    expect(sent.headers.get("authorization")).toBeNull();
    expect(sent.headers.get("cookie")).toBeNull();
    expect(sent.headers.get("mcp-session-id")).toBe("abc");
    expect(sent.body).toContain("tools/list");
  });

  it("asks for the key when none is set", async () => {
    writeOwnerAuth("herd", { servers: { key: { kind: "apiKey", url: "https://key.example/mcp", checkedAt: 1 } }, grants: {} });
    const res = (await call("/mcp-auth/herd/key", mintMcpAuthToken("herd", "s1")))!;
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/needs an API key/);
  });

  it("sends the OAuth token and retries a 401 once with a refreshed one", async () => {
    upstream.answers.push(() => new Response("expired", { status: 401, headers: { "www-authenticate": "Bearer" } }));
    upstream.answers.push(() => new Response('{"ok":1}', { status: 200 }));
    // The refresh goes through the same fetch: answer it after the 401.
    const realFn = upstream.fn;
    upstream.fn = async (url, init) => {
      if (url === `${ISS}/token`) return new Response(JSON.stringify({ access_token: "at-2", expires_in: 3600 }), { status: 200 });
      return realFn(url, init);
    };
    try {
      const res = (await call("/mcp-auth/herd/oa", mintMcpAuthToken("herd", "s1")))!;
      expect(res.status).toBe(200);
      expect(upstream.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer at-1", "Bearer at-2"]);
      expect(readOwnerAuth("herd").grants[ISS].accessToken).toBe("at-2");
    } finally {
      upstream.fn = realFn;
    }
  });

  it("turns a lasting 401 into an error without WWW-Authenticate", async () => {
    writeOwnerAuth("herd", { ...readOwnerAuth("herd"), servers: { key: { kind: "apiKey", url: "https://key.example/mcp", header: "X-Api-Key", value: "bad", checkedAt: 1 } } });
    upstream.answers.push(() => new Response("no", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"' } }));
    const res = (await call("/mcp-auth/herd/key", mintMcpAuthToken("herd", "s1")))!;
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(JSON.stringify(await res.json())).toMatch(/refused Companion's credentials/);
  });

  it("tells the session to sign in when the grant has no token", async () => {
    const data = readOwnerAuth("herd");
    data.grants[ISS] = { ...data.grants[ISS], accessToken: undefined, refreshToken: undefined };
    writeOwnerAuth("herd", data);
    const res = (await call("/mcp-auth/herd/oa", mintMcpAuthToken("herd", "s1")))!;
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/Not signed in\. Sign in from Companion → Domains → herd → MCP servers → oa/);
  });

  it("lets every domain use GLOBAL's servers, open ones without credentials", async () => {
    const res = (await call("/mcp-auth/global/shared", mintMcpAuthToken("herd", "s1")))!;
    expect(res.status).toBe(200);
    expect(upstream.calls[0].headers.get("authorization")).toBeNull();
  });

  it("answers 502 when the server cannot be reached", async () => {
    upstream.answers.push(() => { throw new Error("ECONNREFUSED"); });
    const res = (await call("/mcp-auth/herd/key", mintMcpAuthToken("herd", "s1")))!;
    expect(res.status).toBe(502);
  });
});

describe("OAuth callback", () => {
  it("finishes a sign-in from this machine and shows a page", async () => {
    writeOwnerAuth("herd", { servers: { oa: { kind: "oauth", url: "https://oa.example/mcp", issuer: ISS, checkedAt: 1 } }, grants: { [ISS]: { issuer: ISS, authorizationEndpoint: `${ISS}/a`, tokenEndpoint: `${ISS}/token`, clientId: "c" } } });
    const { authUrl } = await startSignIn("herd", "oa");
    const state = new URL(authUrl).searchParams.get("state");
    upstream.answers.push(() => new Response(JSON.stringify({ access_token: "fresh", refresh_token: "r" }), { status: 200 }));
    const res = (await handleMcpAuthProxy(new Request(`http://localhost:3456/api/mcp-auth/callback?code=c&state=${state}`), "::1", { fetch: upstream.fn }))!;
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Signed in for oa/);
    expect(readOwnerAuth("herd").grants[ISS].accessToken).toBe("fresh");
  });

  it("explains a failed sign-in, and points other devices to the Domains page", async () => {
    const bad = (await handleMcpAuthProxy(new Request("http://localhost:3456/api/mcp-auth/callback?code=c&state=zzz"), "127.0.0.1"))!;
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/unknown or expired/);
    const remote = (await handleMcpAuthProxy(new Request("http://localhost:3456/api/mcp-auth/callback?code=c&state=zzz"), "203.0.113.9"))!;
    expect(remote.status).toBe(403);
    expect(await remote.text()).toMatch(/paste it in Companion/);
  });
});
