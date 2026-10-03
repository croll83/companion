// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CliLauncher } from "./cli-launcher.js";

/**
 * ChatGPT-plan OAuth rotates refresh tokens, so a per-session *copy* of
 * auth.json is revoked the moment any other Codex process refreshes. These
 * tests pin the sharing behaviour that prevents it.
 */
describe("codex auth.json sharing", () => {
  let root: string;
  let legacyHome: string;
  let codexHome: string;
  let launcher: CliLauncher;

  const link = (l: CliLauncher, a: string, b: string) =>
    (l as unknown as { linkAuthJson(a: string, b: string): void }).linkAuthJson(a, b);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-auth-"));
    legacyHome = join(root, "legacy");
    codexHome = join(root, "session");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    launcher = new CliLauncher(3456);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const writeAuth = (dir: string, token: string, lastRefresh: string) =>
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { refresh_token: token }, last_refresh: lastRefresh }));

  it("links the session auth.json to the global one instead of copying it", () => {
    writeAuth(legacyHome, "live", "2026-09-21T15:40:27Z");
    link(launcher, codexHome, legacyHome);

    const dest = join(codexHome, "auth.json");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(dest))).toBe(resolve(join(legacyHome, "auth.json")));
  });

  it("a rotation written through the link is visible to every session", () => {
    writeAuth(legacyHome, "old", "2026-09-21T15:40:27Z");
    const otherHome = join(root, "other");
    mkdirSync(otherHome);
    link(launcher, codexHome, legacyHome);
    link(launcher, otherHome, legacyHome);

    // Codex rewrites auth.json in place on refresh.
    writeAuth(legacyHome, "rotated", "2026-09-22T10:00:00Z");

    for (const home of [codexHome, otherHome]) {
      const seen = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
      expect(seen.tokens.refresh_token).toBe("rotated");
    }
  });

  it("replaces a stale copy left by an older Companion", () => {
    writeAuth(legacyHome, "live", "2026-09-21T15:40:27Z");
    writeAuth(codexHome, "revoked", "2026-09-08T17:52:29Z");

    link(launcher, codexHome, legacyHome);

    const dest = join(codexHome, "auth.json");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(dest, "utf8")).tokens.refresh_token).toBe("live");
    // The stale copy must not overwrite the good global credentials.
    expect(JSON.parse(readFileSync(join(legacyHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("live");
  });

  it("keeps the newer credentials when the session copy rotated last", () => {
    // A write that replaced the link would otherwise be thrown away.
    writeAuth(legacyHome, "older", "2026-09-08T17:52:29Z");
    writeAuth(codexHome, "newer", "2026-09-22T10:00:00Z");

    link(launcher, codexHome, legacyHome);

    expect(JSON.parse(readFileSync(join(legacyHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("newer");
    expect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("newer");
  });

  it("is idempotent and leaves an already-correct link alone", () => {
    writeAuth(legacyHome, "live", "2026-09-21T15:40:27Z");
    symlinkSync(join(legacyHome, "auth.json"), join(codexHome, "auth.json"));

    expect(() => link(launcher, codexHome, legacyHome)).not.toThrow();
    expect(JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("live");
  });

  it("does nothing when the user has never logged in globally", () => {
    expect(() => link(launcher, codexHome, legacyHome)).not.toThrow();
    expect(() => lstatSync(join(codexHome, "auth.json"))).toThrow();
  });
});
