import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The owner files holding private MCP servers' access and OAuth grants.
 * They hold secrets, so they must be owner-only; a grant no server uses any
 * more must disappear with its tokens; a corrupt or foreign file must read
 * as empty instead of breaking the Domains page.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import {
  mcpAuthDir,
  readOwnerAuth,
  removeOwnerAuth,
  removeServerAuth,
  serversOfGrant,
  updateOwnerAuth,
  writeOwnerAuth,
  type OwnerAuth,
} from "./mcp-auth-store.js";

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), "mcp-auth-store-"));
});
afterEach(() => {
  rmSync(h.home, { recursive: true, force: true });
});

const ISS = "https://auth.example";

function sample(): OwnerAuth {
  return {
    servers: {
      a: { kind: "oauth", url: "https://a/mcp", issuer: ISS, scopes: ["x"], checkedAt: 1 },
      b: { kind: "oauth", url: "https://b/mcp", issuer: ISS, checkedAt: 1 },
      k: { kind: "apiKey", url: "https://k/mcp", header: "Authorization", value: "Bearer s", checkedAt: 1 },
    },
    grants: { [ISS]: { issuer: ISS, authorizationEndpoint: "https://auth/a", tokenEndpoint: "https://auth/t", accessToken: "at" } },
  };
}

describe("mcp-auth-store", () => {
  it("writes owner-only files and reads them back", () => {
    writeOwnerAuth("herd", sample());
    const file = join(mcpAuthDir(), "herd.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(mcpAuthDir()).mode & 0o777).toBe(0o700);
    expect(readOwnerAuth("herd")).toEqual(sample());
  });

  it("reads a missing, corrupt or badly named owner as empty", () => {
    expect(readOwnerAuth("nobody")).toEqual({ servers: {}, grants: {} });
    mkdirSync(mcpAuthDir(), { recursive: true });
    writeFileSync(join(mcpAuthDir(), "bad.json"), "{nope");
    expect(readOwnerAuth("bad")).toEqual({ servers: {}, grants: {} });
    expect(readOwnerAuth("../etc")).toEqual({ servers: {}, grants: {} });
    expect(() => writeOwnerAuth("../etc", sample())).toThrow(/Invalid owner/);
  });

  // A grant outlives its servers only while one of them still uses it.
  it("drops a grant (and its tokens) when no server uses it", () => {
    writeOwnerAuth("herd", sample());
    removeServerAuth("herd", "a");
    expect(readOwnerAuth("herd").grants[ISS]).toBeDefined();
    removeServerAuth("herd", "b");
    const after = readOwnerAuth("herd");
    expect(after.grants).toEqual({});
    expect(readFileSync(join(mcpAuthDir(), "herd.json"), "utf-8")).not.toContain("\"at\"");
    expect(Object.keys(after.servers)).toEqual(["k"]);
  });

  it("updates in one step and lists the servers sharing a grant", () => {
    writeOwnerAuth("herd", sample());
    const n = updateOwnerAuth("herd", (d) => {
      d.servers.c = { kind: "oauth", url: "https://c/mcp", issuer: ISS, checkedAt: 2 };
      return Object.keys(d.servers).length;
    });
    expect(n).toBe(4);
    expect(serversOfGrant(readOwnerAuth("herd"), ISS)).toEqual(["a", "b", "c"]);
    expect(serversOfGrant(readOwnerAuth("herd"), "https://other")).toEqual([]);
  });

  it("removing from an owner without a file or the whole owner is harmless", () => {
    removeServerAuth("ghost", "x");
    expect(existsSync(join(mcpAuthDir(), "ghost.json"))).toBe(false);
    writeOwnerAuth("herd", sample());
    removeOwnerAuth("herd");
    removeOwnerAuth("../x");
    expect(existsSync(join(mcpAuthDir(), "herd.json"))).toBe(false);
  });
});
