import { describe, expect, it } from "vitest";
import { authParam, probeMcpServer, resourceMetadataUrls } from "./mcp-auth-probe.js";

/**
 * Probing decides how Companion reaches a server added on the Domains page.
 * The case that motivated it: Google Workspace's MCP servers answer
 * `initialize` without a token yet protect their data, so only their OAuth
 * metadata reveals they are private. Each case below is one way a real
 * server answers; the network is a fake fetch.
 */

type Route = (init?: RequestInit) => Response;

function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    return route ? route(init) : new Response("not found", { status: 404 });
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const SERVER = "https://mcp.example.com/mcp/v1";

describe("authParam", () => {
  it("reads quoted and bare parameters of a WWW-Authenticate header", () => {
    const h = 'Bearer realm="x", resource_metadata="https://m/.well-known/x", scope=read';
    expect(authParam(h, "resource_metadata")).toBe("https://m/.well-known/x");
    expect(authParam(h, "scope")).toBe("read");
    expect(authParam(h, "error")).toBeUndefined();
    expect(authParam(null, "scope")).toBeUndefined();
  });
});

describe("resourceMetadataUrls", () => {
  it("lists the path-specific metadata URL first, then the origin's", () => {
    expect(resourceMetadataUrls(SERVER)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(resourceMetadataUrls("https://x.io/")).toEqual(["https://x.io/.well-known/oauth-protected-resource"]);
  });
});

describe("probeMcpServer", () => {
  it("open: initialize works and there is no OAuth metadata", async () => {
    const { fn } = fakeFetch({ [`POST ${SERVER}`]: () => json({ result: {} }) });
    expect(await probeMcpServer(SERVER, fn)).toEqual({ kind: "open" });
  });

  // Google's case: 200 on initialize, but the metadata names an authorization server.
  it("OAuth when initialize works but the server publishes protected resource metadata", async () => {
    const { fn } = fakeFetch({
      [`POST ${SERVER}`]: () => json({ result: {} }),
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1": () =>
        json({ resource: SERVER, authorization_servers: ["https://accounts.example/"], scopes_supported: ["a", "b"] }),
    });
    expect(await probeMcpServer(SERVER, fn)).toEqual({ kind: "oauth", issuer: "https://accounts.example/", scopes: ["a", "b"] });
  });

  it("OAuth from a 401 naming its metadata, with the scope the header asks for", async () => {
    const { fn, calls } = fakeFetch({
      [`POST ${SERVER}`]: () => json({}, 401, { "WWW-Authenticate": 'Bearer resource_metadata="https://meta.example/prm", scope="read write"' }),
      "GET https://meta.example/prm": () => json({ authorization_servers: ["https://as.example"], scopes_supported: "x y" }),
    });
    expect(await probeMcpServer(SERVER, fn)).toEqual({ kind: "oauth", issuer: "https://as.example", scopes: ["read", "write"] });
    expect(calls[1]).toBe("GET https://meta.example/prm");
  });

  it("OAuth at the server's origin for a 401 under the older MCP spec (no resource metadata)", async () => {
    const { fn } = fakeFetch({
      [`POST ${SERVER}`]: () => json({}, 401),
      "GET https://mcp.example.com/.well-known/oauth-authorization-server": () => json({ issuer: "https://mcp.example.com" }),
    });
    expect(await probeMcpServer(SERVER, fn)).toEqual({ kind: "oauth", issuer: "https://mcp.example.com", scopes: undefined });
  });

  it("API key for a 401 or 403 without any OAuth metadata", async () => {
    const r401 = fakeFetch({ [`POST ${SERVER}`]: () => json({}, 401) });
    expect(await probeMcpServer(SERVER, r401.fn)).toEqual({ kind: "apiKey" });
    const r403 = fakeFetch({ [`POST ${SERVER}`]: () => json({}, 403) });
    expect(await probeMcpServer(SERVER, r403.fn)).toEqual({ kind: "apiKey" });
  });

  it("ignores metadata without an authorization server, or that is not JSON", async () => {
    const { fn } = fakeFetch({
      [`POST ${SERVER}`]: () => json({}),
      "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp/v1": () => json({ resource: SERVER }),
      "GET https://mcp.example.com/.well-known/oauth-protected-resource": () => new Response("<html>", { status: 200 }),
    });
    expect(await probeMcpServer(SERVER, fn)).toEqual({ kind: "open" });
  });

  it("fails clearly when the server does not answer", async () => {
    const fn = async () => { throw new Error("ECONNREFUSED"); };
    await expect(probeMcpServer(SERVER, fn)).rejects.toThrow(/did not answer: ECONNREFUSED/);
  });
});
