import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The keys and `brn_` tokens of embedded brains, Companion's side. The child
 * verifies tokens with its own code (the brains core inside the bundle), so
 * this test checks the two agree on the real bundle: a token minted here
 * opens its MCP with the derived key, and a token of another brain does not.
 * Temp COMPANION_HOME.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { embeddedKeys, ensureEmbeddedSecret, isValidBrainToken, mintBrainToken } from "./brain-token.js";
import { brainDir, createEmbeddedBrain } from "./brain-store.js";
import { BUN, startBundle } from "./__tests__/bundle-brain.js";
import { makeWiki } from "./__tests__/wiki-fixture.js";

let tmp: string;

function brain(slug: string): void {
  const wiki = join(tmp, `wiki-${slug}`);
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, "SCHEMA.md"), "# s\n");
  writeFileSync(join(wiki, "index.md"), "# i\n");
  const r = createEmbeddedBrain({ name: slug, wikiDir: wiki });
  if (!r.ok) throw new Error(r.error);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-token-"));
  h.home = join(tmp, "companion");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("brain tokens", () => {
  it("creating an embedded brain writes a private 32-byte secret; keys derive from it", () => {
    brain("work");
    const secret = readFileSync(join(brainDir("work"), "secret"), "utf-8").trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(brainDir("work"), "secret")).mode & 0o777).toBe(0o600);
    const keys = embeddedKeys("work")!;
    expect(keys.tokenKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.curatorKey).not.toBe(keys.tokenKey);
    expect(keys.tokenKey).not.toContain(secret);
    ensureEmbeddedSecret("work"); // keeps the existing one
    expect(readFileSync(join(brainDir("work"), "secret"), "utf-8").trim()).toBe(secret);
  });

  it.skipIf(!BUN)("a minted token opens the bundle's MCP with the derived key, and only for its brain", async () => {
    brain("work");
    brain("home");
    const t = mintBrainToken("work", "dev", "0f9c-session")!;
    expect(t).toMatch(/^brn_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const wiki = makeWiki();
    const child = await startBundle(wiki, { BRAIN_TOKEN_KEY: embeddedKeys("work")!.tokenKey });
    try {
      const initialize = (token: string) =>
        fetch(`${child.base}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
        });
      expect((await initialize(t)).status).toBe(200);
      expect((await initialize(mintBrainToken("home", "dev", "0f9c-session")!)).status).toBe(401);
    } finally {
      await child.stop();
      rmSync(wiki, { recursive: true, force: true });
    }
  });

  it("checks tokens on Companion's side the same way", () => {
    brain("work");
    brain("home");
    const t = mintBrainToken("work", "dev", "0f9c-session")!;
    expect(Buffer.from(t.slice(4).split(".")[0], "base64url").toString()).toBe("dev|0f9c-session");
    expect(isValidBrainToken("work", t)).toBe(true);
    expect(isValidBrainToken("home", t)).toBe(false);
    expect(isValidBrainToken("work", `${t}x`)).toBe(false);
    expect(isValidBrainToken("work", `${t}.extra`)).toBe(false);
    expect(isValidBrainToken("work", "brn_.")).toBe(false);
    expect(isValidBrainToken("work", "Bearer x")).toBe(false);
    expect(isValidBrainToken("work", undefined)).toBe(false);
  });

  it("rotating the secret revokes every token; no secret, no token", () => {
    brain("work");
    const t = mintBrainToken("work", "dev", "s1")!;
    rmSync(join(brainDir("work"), "secret"));
    expect(mintBrainToken("work", "dev", "s1")).toBeNull();
    expect(embeddedKeys("work")).toBeNull();
    expect(isValidBrainToken("work", t)).toBe(false);
    ensureEmbeddedSecret("work");
    expect(isValidBrainToken("work", t)).toBe(false);
    expect(isValidBrainToken("work", mintBrainToken("work", "dev", "s1"))).toBe(true);
    writeFileSync(join(brainDir("work"), "secret"), "not hex\n");
    expect(embeddedKeys("work")).toBeNull();
  });
});
