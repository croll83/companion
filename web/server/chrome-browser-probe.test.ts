import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  extractBrowsersFromOutput,
  probeCommand,
  probeConnectedBrowsers,
  listConnectedBrowsers,
  defaultDeps,
  realSpawn,
  _clearChromeBrowserCache,
  type ProbeDeps,
  type ProbeOutput,
} from "./chrome-browser-probe.js";

/**
 * Listing the connected Claude in Chrome browsers via a one-shot `claude -p`
 * query. The spawn is injected so these tests never start a real CLI; they
 * cover the output parsing, error paths, and the brief cache.
 */

const sample = JSON.stringify([
  { deviceId: "d-linux", name: "Chrome", osPlatform: "Linux", isLocal: true, inUse: true },
  { deviceId: "d-mac", name: "Safari", osPlatform: "macOS", isLocal: false, inUse: false },
]);

function out(over: Partial<ProbeOutput> = {}): ProbeOutput {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...over };
}

function deps(spawn: ProbeDeps["spawn"], over: Partial<ProbeDeps> = {}): ProbeDeps {
  return { binary: "/usr/bin/claude", env: {}, cwd: "/tmp/probe", cleanup: vi.fn(), spawn, ...over };
}

describe("extractBrowsersFromOutput", () => {
  it("reads the array from the JSON envelope's result text", () => {
    // `claude -p --output-format json` wraps the final text in { result }.
    const envelope = JSON.stringify({ type: "result", result: sample });
    expect(extractBrowsersFromOutput(envelope)).toHaveLength(2);
  });

  it("reads a raw array, and one wrapped in prose or code fences", () => {
    expect(extractBrowsersFromOutput(sample)).toHaveLength(2);
    const fenced = JSON.stringify({ result: "Here you go:\n```json\n" + sample + "\n```" });
    expect(extractBrowsersFromOutput(fenced)).toHaveLength(2);
  });

  it("returns [] for an explicit empty list but null when no array is present", () => {
    expect(extractBrowsersFromOutput(JSON.stringify({ result: "[]" }))).toEqual([]);
    expect(extractBrowsersFromOutput(JSON.stringify({ result: "no browsers connected" }))).toBeNull();
    expect(extractBrowsersFromOutput("")).toBeNull();
    expect(extractBrowsersFromOutput(JSON.stringify({ result: "[oops" }))).toBeNull();
  });
});

describe("probeCommand", () => {
  it("runs one read-only chrome tool with no permission prompts", () => {
    const cmd = probeCommand("/usr/bin/claude");
    expect(cmd[0]).toBe("/usr/bin/claude");
    expect(cmd).toContain("--chrome");
    expect(cmd).toContain("mcp__claude-in-chrome__list_connected_browsers");
    expect(cmd.join(" ")).toContain("--permission-mode bypassPermissions");
  });
});

describe("probeConnectedBrowsers", () => {
  it("returns the parsed browsers and always cleans up", async () => {
    const cleanup = vi.fn();
    const spawn = vi.fn(async () => out({ stdout: JSON.stringify({ result: sample }) }));
    const res = await probeConnectedBrowsers(deps(spawn, { cleanup }));
    expect(res.browsers).toHaveLength(2);
    expect(res.error).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports a missing CLI without spawning", async () => {
    const spawn = vi.fn();
    const res = await probeConnectedBrowsers(deps(spawn, { binary: null }));
    expect(spawn).not.toHaveBeenCalled();
    expect(res.error).toMatch(/not found/);
  });

  it("reports a timeout, an unparseable output, and a thrown spawn", async () => {
    expect((await probeConnectedBrowsers(deps(async () => out({ timedOut: true })))).error).toMatch(/Timed out/);

    const garbled = await probeConnectedBrowsers(deps(async () => out({ stdout: "???", stderr: "boom", exitCode: 1 })));
    expect(garbled.browsers).toEqual([]);
    expect(garbled.error).toMatch(/boom/);

    const threw = await probeConnectedBrowsers(deps(async () => { throw new Error("spawn failed"); }));
    expect(threw.error).toBe("spawn failed");
  });
});

describe("defaultDeps", () => {
  it("builds a temp cwd, a sanitized env, and a cleanup that removes it", () => {
    const d = defaultDeps();
    expect(d.cwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(d.cwd)).toBe(true);
    expect(d.env.PATH).toBeTruthy();
    expect(d.env.CLAUDECODE).toBeUndefined();
    d.cleanup();
    expect(existsSync(d.cwd)).toBe(false);
  });
});

// realSpawn is a thin Bun.spawn wrapper (the probe's only impure part) and is
// exercised in the live verification, not here: `Bun` is not defined under the
// node-based vitest runner. Referencing it keeps the import meaningful.
describe("realSpawn", () => {
  it("is the spawn used by the default deps", () => {
    expect(defaultDeps().spawn).toBe(realSpawn);
  });
});

describe("listConnectedBrowsers", () => {
  beforeEach(() => _clearChromeBrowserCache());

  it("caches the result and bypasses the cache with force", async () => {
    const spawn = vi.fn(async () => out({ stdout: sample }));
    const first = await listConnectedBrowsers({ deps: deps(spawn) });
    expect(first.browsers).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(1);
    // Second call within the TTL does not spawn again.
    await listConnectedBrowsers({ deps: deps(spawn) });
    expect(spawn).toHaveBeenCalledTimes(1);
    // force re-runs the probe.
    await listConnectedBrowsers({ force: true, deps: deps(spawn) });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
