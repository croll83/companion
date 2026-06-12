import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the binary resolver so we control whether "claude" is "found".
vi.mock("./path-resolver.js", () => ({
  resolveBinary: vi.fn((name: string) => (name === "claude" ? "/usr/bin/claude" : null)),
}));

import { resolveBinary } from "./path-resolver.js";
import {
  parseClaudeVersion,
  checkClaudeCli,
  markClaudeCliRuntimeIncompatible,
  clearClaudeCliRuntimeIncompatible,
} from "./claude-cli-check.js";

const enc = (s: string) => new TextEncoder().encode(s);

// vitest runs under Node where the `Bun` global does not exist; the production
// code runs under Bun. Provide a minimal global stub so the module under test
// can call Bun.spawnSync.
/** Stub Bun.spawnSync: --version returns versionOut, --help returns helpOut. */
function stubSpawn(versionOut: string, helpOut: string) {
  const spawnSync = vi.fn((cmd: string[]) => {
    const out = cmd.includes("--version") ? versionOut : helpOut;
    return { stdout: enc(out), stderr: enc(""), exitCode: 0, success: true };
  });
  (globalThis as unknown as { Bun: { spawnSync: typeof spawnSync } }).Bun = { spawnSync };
  return spawnSync;
}

const FULL_HELP = "Options:\n --print\n --input-format <format>\n --output-format <format>\n --include-partial-messages\n";

beforeEach(() => {
  clearClaudeCliRuntimeIncompatible();
  (resolveBinary as unknown as ReturnType<typeof vi.fn>).mockReturnValue("/usr/bin/claude");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearClaudeCliRuntimeIncompatible();
});

describe("parseClaudeVersion", () => {
  it("extracts a semver from `claude --version` output", () => {
    expect(parseClaudeVersion("2.1.175 (Claude Code)")).toBe("2.1.175");
    expect(parseClaudeVersion("foo 1.0.0-beta.3 bar")).toBe("1.0.0-beta.3");
    expect(parseClaudeVersion("no version here")).toBeNull();
  });
});

describe("checkClaudeCli", () => {
  it("reports ok when all required flags are advertised", () => {
    stubSpawn("2.1.175 (Claude Code)", FULL_HELP);
    const r = checkClaudeCli({ force: true });
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.version).toBe("2.1.175");
    expect(r.missingFlags).toEqual([]);
  });

  it("flags a too-old CLI missing a required flag", () => {
    stubSpawn("1.0.0 (Claude Code)", "Options:\n --print\n --output-format <format>\n");
    const r = checkClaudeCli({ force: true });
    expect(r.ok).toBe(false);
    expect(r.missingFlags).toContain("--include-partial-messages");
    expect(r.missingFlags).toContain("--input-format");
    expect(r.suggestedCommand).toBe("claude update");
    expect(r.reason).toMatch(/v1\.0\.0/);
  });

  it("reports not-found when the binary is missing", () => {
    (resolveBinary as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const r = checkClaudeCli({ force: true });
    expect(r.found).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("does not cry wolf when --help can't be read", () => {
    stubSpawn("2.1.175 (Claude Code)", "");
    const r = checkClaudeCli({ force: true });
    expect(r.ok).toBe(true);
    expect(r.missingFlags).toEqual([]);
  });

  it("runtime incompatibility overrides an otherwise-ok cached probe", () => {
    stubSpawn("2.1.175 (Claude Code)", FULL_HELP);
    // Prime the cache with a passing probe first...
    expect(checkClaudeCli({ force: true }).ok).toBe(true);
    // ...then a runtime failure must override the (still-cached) ok result.
    markClaudeCliRuntimeIncompatible("2.1.175", "unknown option '--include-partial-messages'");
    const r = checkClaudeCli(); // no force -> reuse cache, don't self-heal
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/incompatible/i);
  });

  it("self-heals: a fresh passing probe clears a stale runtime flag", () => {
    stubSpawn("2.1.175 (Claude Code)", FULL_HELP);
    markClaudeCliRuntimeIncompatible("2.1.175", "unknown option");
    const r = checkClaudeCli({ force: true });
    expect(r.ok).toBe(true);
  });
});
