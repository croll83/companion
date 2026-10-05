import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Agent "fork" runs: how the launcher starts a session from a COPY of
 * another session's conversation, for both backends, and that it stops
 * forking once the new session has a conversation of its own (relaunches
 * then resume the fork, never the source).
 */

const h = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/companion-launcher-fork-${process.pid}-${Date.now()}`,
  uuid: 0,
}));
vi.mock("./paths.js", () => ({ COMPANION_HOME: h.home, legacyStatePath: () => null }));
vi.mock("./linear-connections.js", () => ({ getConnection: () => null }));
vi.mock("node:crypto", () => ({ randomUUID: () => `sess-${++h.uuid}` }));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: (name: string) => `/opt/fake/${name}`,
  getEnrichedPath: () => "/usr/bin",
}));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "" }),
}));
vi.mock("./claude-session-history.js", () => ({ claudeTranscriptExists: () => true }));
vi.mock("./env-manager.js", () => ({
  resolveEnvProfiles: () => ({ profiles: [], variables: {}, missingExplicit: false }),
}));
vi.mock("./codex-home.js", () => ({
  getLegacyCodexHome: () => `${h.home}/no-legacy-codex`,
  resolveCompanionCodexSessionHome: (id: string) => `${h.home}/codex/${id}`,
  authRefreshedAt: () => 0,
}));

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import { companionBus } from "./event-bus.js";
import type { CodexAdapter } from "./codex-adapter.js";

function mockProc() {
  return {
    pid: 99_999_999, // beyond pid_max: never a real process
    kill: vi.fn(),
    exited: new Promise<number>(() => {}),
    stdin: new WritableStream<Uint8Array>(),
    stdout: new ReadableStream<Uint8Array>({ start() {} }),
    stderr: new ReadableStream<Uint8Array>({ start() {} }),
  };
}

const mockSpawn = vi.fn();
vi.stubGlobal("Bun", { spawn: mockSpawn, listen: vi.fn(() => ({ stop: vi.fn() })) });

let sessionDir: string;
let adapters: CodexAdapter[];
const onAdapter = ({ adapter }: { adapter: CodexAdapter }) => { adapters.push(adapter); };

/** argv (after the binary) of the n-th spawn. */
function spawnArgs(n: number): string[] {
  return (mockSpawn.mock.calls[n][0] as string[]).slice(1);
}

/** The thread a Codex adapter was told to fork (private option). */
function forkThreadOf(adapter: CodexAdapter): string | undefined {
  return (adapter as unknown as { options: { forkFromThreadId?: string } }).options.forkFromThreadId;
}

function newLauncher(): CliLauncher {
  const launcher = new CliLauncher(3456);
  launcher.setStore(new SessionStore(sessionDir));
  return launcher;
}

beforeEach(() => {
  mkdirSync(h.home, { recursive: true });
  sessionDir = mkdtempSync(join(tmpdir(), "launcher-fork-sessions-"));
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => mockProc());
  adapters = [];
  companionBus.on("backend:codex-adapter-created", onAdapter);
  process.env.COMPANION_CODEX_TRANSPORT = "stdio";
  process.env.COMPANION_RELAUNCH_GRACE_MS = "10";
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
});

afterEach(() => {
  companionBus.off("backend:codex-adapter-created", onAdapter);
  vi.restoreAllMocks();
  delete process.env.COMPANION_CODEX_TRANSPORT;
  delete process.env.COMPANION_RELAUNCH_GRACE_MS;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("Claude fork arguments", () => {
  // The first spawn copies the source transcript: --resume <source> plus
  // --fork-session, so the CLI writes a NEW transcript and leaves the source alone.
  it("resumes the source with --fork-session until the fork has its own id", async () => {
    const launcher = newLauncher();
    const info = launcher.launch({
      cwd: "/work/repo",
      forkSource: { sessionId: "src", cliSessionId: "cli-src" },
    });

    const first = spawnArgs(0);
    expect(first).toContain("--fork-session");
    expect(first[first.indexOf("--resume") + 1]).toBe("cli-src");
    expect(info.forkSource).toEqual({ sessionId: "src", cliSessionId: "cli-src" });

    // Died before reporting its own id: a relaunch forks the source again
    // (there is nothing else to resume).
    await launcher.relaunch(info.sessionId);
    const second = spawnArgs(1);
    expect(second).toContain("--fork-session");
    expect(second[second.indexOf("--resume") + 1]).toBe("cli-src");

    // The fork reported its own transcript: from now on resume THAT, plainly.
    launcher.setCLISessionId(info.sessionId, "cli-fork");
    await launcher.relaunch(info.sessionId);
    const third = spawnArgs(2);
    expect(third).not.toContain("--fork-session");
    expect(third.filter((a) => a === "--resume")).toHaveLength(1);
    expect(third[third.indexOf("--resume") + 1]).toBe("cli-fork");
  });

  // The fork reference survives a server restart (it is in launcher.json).
  it("persists the fork source with the session", () => {
    const launcher = newLauncher();
    launcher.launch({ forkSource: { sessionId: "src", cliSessionId: "cli-src" } });
    const persisted = readFileSync(join(sessionDir, "launcher.json"), "utf-8");
    expect(persisted).toContain('"forkSource":{"sessionId":"src","cliSessionId":"cli-src"}');
  });

  // Sessions not created as forks are unchanged.
  it("adds no fork arguments to an ordinary session", () => {
    newLauncher().launch({ cwd: "/work/repo" });
    expect(spawnArgs(0)).not.toContain("--fork-session");
    expect(spawnArgs(0)).not.toContain("--resume");
  });
});

describe("Codex fork", () => {
  function writeSourceRollout(): string {
    const dir = join(h.home, "codex", "src", "sessions", "2026", "09", "08");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-2026-09-08T20-03-54-thread-src.jsonl");
    writeFileSync(file, '{"source":"untouched"}\n');
    return file;
  }

  // The new app-server has its own CODEX_HOME, so the source rollout is
  // copied there (same sessions/ path) and the adapter forks the thread by id.
  it("copies the source rollout into the new home and forks the thread", () => {
    const rolloutPath = writeSourceRollout();
    const info = newLauncher().launch({
      cwd: "/work/repo",
      backendType: "codex",
      forkSource: { sessionId: "src", cliSessionId: "thread-src", rolloutPath },
    });

    const copied = join(h.home, "codex", info.sessionId, "sessions", "2026", "09", "08", "rollout-2026-09-08T20-03-54-thread-src.jsonl");
    expect(readFileSync(copied, "utf-8")).toBe('{"source":"untouched"}\n');
    expect(readFileSync(rolloutPath, "utf-8")).toBe('{"source":"untouched"}\n');
    expect(adapters).toHaveLength(1);
    expect(forkThreadOf(adapters[0])).toBe("thread-src");
  });

  // Once Codex reported the forked thread id, relaunches resume the fork.
  it("stops forking once the session has its own thread", async () => {
    const launcher = newLauncher();
    const info = launcher.launch({
      backendType: "codex",
      forkSource: { sessionId: "src", cliSessionId: "thread-src", rolloutPath: writeSourceRollout() },
    });
    launcher.setCLISessionId(info.sessionId, "thread-fork");

    await launcher.relaunch(info.sessionId);

    expect(adapters).toHaveLength(2);
    expect(forkThreadOf(adapters[1])).toBeUndefined();
    expect((adapters[1] as unknown as { options: { threadId?: string } }).options.threadId).toBe("thread-fork");
  });

  // A rollout that vanished is not fatal here: thread/fork then fails with
  // Codex's own error, which fails the run (see agent-executor).
  it("still asks for the fork when the source rollout cannot be copied", () => {
    const info = newLauncher().launch({
      backendType: "codex",
      forkSource: { sessionId: "src", cliSessionId: "thread-src", rolloutPath: join(h.home, "missing", "sessions", "x.jsonl") },
    });
    expect(existsSync(join(h.home, "codex", info.sessionId, "sessions", "x.jsonl"))).toBe(false);
    expect(forkThreadOf(adapters[0])).toBe("thread-src");
  });
});
