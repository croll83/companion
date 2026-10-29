import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the Domains page sees of a server's access, and the actions behind
 * its buttons. The view must never carry a secret; a changed URL must read
 * as "unchecked" (stored access belongs to the old URL); probing must keep a
 * key already set and record the provider's endpoints, so the page knows at
 * once whether a client ID is needed.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { setCompanionPort } from "../brain/brain-endpoints.js";
import { checkServer, mcpAuthView, mcpServerOwner, setApiKey } from "./mcp-auth-manage.js";
import { mcpAuthDir, readOwnerAuth, writeOwnerAuth } from "./mcp-auth-store.js";

const ISS = "https://as.example";
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

function writeMcp(slug: string, servers: Record<string, unknown>) {
  const dir = join(h.home, "domains", `companion_domain_${slug}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), "mcp-auth-manage-"));
  process.env.COMPANION_DOMAINS_ROOT = join(h.home, "domains");
  setCompanionPort(3456);
  writeMcp("herd", { srv: { type: "http", url: "https://srv.example/mcp" }, hdr: { url: "https://h/mcp", headers: { Authorization: "Bearer x" } }, cmd: { command: "c" } });
  writeMcp("global", { srv: { url: "https://global/mcp" }, g: { url: "https://g/mcp" } });
});
afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
});

describe("mcpServerOwner", () => {
  it("prefers the domain's own declaration, then GLOBAL's", () => {
    expect(mcpServerOwner("herd", "srv")).toBe("herd");
    expect(mcpServerOwner("herd", "g")).toBe("global");
    expect(mcpServerOwner("global", "srv")).toBe("global");
    expect(mcpServerOwner("herd", "none")).toBeNull();
  });
});

describe("mcpAuthView", () => {
  const def = { url: "https://srv.example/mcp" };

  it("command servers have no view; unprobed ones are unchecked, or manual with headers", () => {
    expect(mcpAuthView("herd", "cmd", { command: "c" })).toBeUndefined();
    expect(mcpAuthView("herd", "srv", def)).toEqual({ owner: "herd", state: "unchecked" });
    expect(mcpAuthView("herd", "hdr", { url: "https://h/mcp", headers: { A: "b" } })).toEqual({ owner: "herd", state: "manual" });
  });

  it("a changed URL reads as unchecked again", () => {
    writeOwnerAuth("herd", { servers: { srv: { kind: "open", url: "https://old/mcp", checkedAt: 1 } }, grants: {} });
    expect(mcpAuthView("herd", "srv", def)?.state).toBe("unchecked");
  });

  it("shows open, API key and OAuth states without secrets", () => {
    writeOwnerAuth("herd", {
      servers: {
        o: { kind: "open", url: "u1", checkedAt: 1 },
        k: { kind: "apiKey", url: "u2", header: "X-Key", value: "SECRET-KEY", checkedAt: 1 },
        k2: { kind: "apiKey", url: "u3", checkedAt: 1 },
        a: { kind: "oauth", url: "u4", issuer: ISS, scopes: ["s"], checkedAt: 1 },
        b: { kind: "oauth", url: "u5", issuer: ISS, checkedAt: 1 },
      },
      grants: { [ISS]: { issuer: ISS, authorizationEndpoint: "x", tokenEndpoint: "y", clientId: "cid", clientSecret: "SECRET-CS", accessToken: "SECRET-AT", refreshToken: "SECRET-RT", account: "me@x" } },
    });
    expect(mcpAuthView("herd", "o", { url: "u1" })).toEqual({ owner: "herd", state: "open" });
    expect(mcpAuthView("herd", "k", { url: "u2" })).toEqual({ owner: "herd", state: "key-set", header: "X-Key" });
    expect(mcpAuthView("herd", "k2", { url: "u3" })?.state).toBe("needs-key");
    const a = mcpAuthView("herd", "a", { url: "u4" })!;
    expect(a).toMatchObject({ state: "signed-in", account: "me@x", clientId: "cid", hasClientSecret: true, sharedWith: ["b"], scopes: ["s"], redirectUri: "http://localhost:3456/api/mcp-auth/callback" });
    expect(JSON.stringify([a, mcpAuthView("herd", "k", { url: "u2" })])).not.toMatch(/SECRET/);
  });

  it("needs a client when the provider cannot register one, else a sign-in", () => {
    writeOwnerAuth("herd", {
      servers: { a: { kind: "oauth", url: "u", issuer: ISS, checkedAt: 1 } },
      grants: { [ISS]: { issuer: ISS, authorizationEndpoint: "x", tokenEndpoint: "y" } },
    });
    expect(mcpAuthView("herd", "a", { url: "u" })?.state).toBe("needs-client");
    writeOwnerAuth("herd", {
      servers: { a: { kind: "oauth", url: "u", issuer: ISS, checkedAt: 1 } },
      grants: { [ISS]: { issuer: ISS, authorizationEndpoint: "x", tokenEndpoint: "y", registrationEndpoint: "r", error: "revoked" } },
    });
    expect(mcpAuthView("herd", "a", { url: "u" })).toMatchObject({ state: "needs-sign-in", error: "revoked" });
  });
});

describe("checkServer", () => {
  it("records an OAuth server with its provider's endpoints and preset scopes", async () => {
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({}, 200);
      if (url === "https://srv.example/.well-known/oauth-protected-resource/mcp") return json({ authorization_servers: [ISS], scopes_supported: ["all"] });
      if (url === `${ISS}/.well-known/oauth-authorization-server`) return json({ authorization_endpoint: `${ISS}/a`, token_endpoint: `${ISS}/t`, registration_endpoint: `${ISS}/r` });
      return json({}, 404);
    };
    const auth = await checkServer("herd", "srv", fetchFn);
    expect(auth).toMatchObject({ kind: "oauth", url: "https://srv.example/mcp", issuer: ISS, scopes: ["all"] });
    expect(readOwnerAuth("herd").grants[ISS]).toMatchObject({ authorizationEndpoint: `${ISS}/a`, registrationEndpoint: `${ISS}/r` });
  });

  it("keeps a key already set when the server still wants one", async () => {
    setApiKey("herd", "srv", "", "tok");
    await checkServer("herd", "srv", async () => json({}, 401));
    expect(readOwnerAuth("herd").servers.srv).toMatchObject({ kind: "apiKey", header: "Authorization", value: "Bearer tok" });
    await checkServer("herd", "srv", async (_u, init) => (init?.method === "POST" ? json({}) : json({}, 404)));
    expect(readOwnerAuth("herd").servers.srv).toMatchObject({ kind: "open" });
    expect(readOwnerAuth("herd").servers.srv.value).toBeUndefined();
  });

  it("refuses servers that are not HTTP servers of the owner", async () => {
    await expect(checkServer("herd", "cmd")).rejects.toThrow(/No HTTP server "cmd" in herd/);
    await expect(checkServer("global", "zzz")).rejects.toThrow(/in GLOBAL's mcp.json/);
  });
});

describe("setApiKey", () => {
  it("prefixes a bare Authorization token with Bearer, keeps other headers as given, and is owner-only", () => {
    setApiKey("herd", "srv", "Authorization", "Bearer already");
    expect(readOwnerAuth("herd").servers.srv.value).toBe("Bearer already");
    setApiKey("herd", "srv", "X-Api-Key", "raw");
    expect(readOwnerAuth("herd").servers.srv).toMatchObject({ header: "X-Api-Key", value: "raw" });
    setApiKey("herd", "srv", "X-Api-Key", "");
    expect(readOwnerAuth("herd").servers.srv.value).toBeUndefined();
    expect(readFileSync(join(mcpAuthDir(), "herd.json"), "utf-8")).not.toContain("raw");
  });

  it("rejects bad header names and unknown servers", () => {
    expect(() => setApiKey("herd", "srv", "Bad Header", "x")).toThrow(/Header name/);
    expect(() => setApiKey("herd", "cmd", "", "x")).toThrow(/No HTTP server/);
  });
});
