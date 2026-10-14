import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The keys and `brn_` tokens of embedded brains, Companion's side. The child
 * verifies tokens with its own code (core/token.ts), so this test checks the
 * two agree: a token minted here must verify there with the derived key, and
 * a token of another brain or a tampered one must not. Temp COMPANION_HOME.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { embeddedKeys, ensureEmbeddedSecret, isValidBrainToken, mintBrainToken } from "./brain-token.js";
import { brainDir, createEmbeddedBrain } from "./brain-store.js";
import { verifyToken } from "./core/token.js";

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

  it("a minted token verifies in the core with the derived key, and only for its brain", () => {
    brain("work");
    brain("home");
    const t = mintBrainToken("work", "dev", "0f9c-session")!;
    expect(t).toMatch(/^brn_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyToken(embeddedKeys("work")!.tokenKey, t)).toEqual({ domain: "dev", sessionId: "0f9c-session" });
    expect(verifyToken(embeddedKeys("home")!.tokenKey, t)).toBeNull();
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
