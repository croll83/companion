import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * End-to-end env resolution through the real CliLauncher + env-manager +
 * session-env + SessionStore: what the spawned CLI receives on launch, and
 * that a relaunch after a simulated server restart (fresh launcher restored
 * from launcher.json) re-resolves everything from disk.
 */

// COMPANION_HOME must point at a temp dir before env-manager is imported
// (it computes its envs dir at load). Never touch the real ~/.companion.
const h = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/companion-launcher-env-${process.pid}-${Date.now()}`,
  settings: { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "" } as Record<string, string>,
  uuid: 0,
}));
vi.mock("./paths.js", () => ({ COMPANION_HOME: h.home }));
vi.mock("node:crypto", () => ({ randomUUID: () => `sess-${++h.uuid}` }));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: (name: string) => `/opt/fake/${name}`,
  getEnrichedPath: () => "/usr/bin",
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => h.settings }));
vi.mock("./claude-session-history.js", () => ({ claudeTranscriptExists: () => true }));
vi.mock("./linear-connections.js", () => ({
  getConnection: (id: string) => (id === "conn-1" ? { id, apiKey: "lin-key" } : null),
}));
vi.mock("./codex-home.js", () => ({
  getLegacyCodexHome: () => `${h.home}/no-legacy-codex`,
  resolveCompanionCodexSessionHome: (id: string) => `${h.home}/codex/${id}`,
  authRefreshedAt: () => 0,
}));

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import * as envManager from "./env-manager.js";
import { companionBus } from "./event-bus.js";

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
let store: SessionStore;

/** Env passed to the n-th Bun.spawn call. */
function spawnEnv(n: number): Record<string, string | undefined> {
  return mockSpawn.mock.calls[n][1].env;
}

/** A fresh launcher reading the same session dir: a server restart. */
function restartedLauncher(): CliLauncher {
  const next = new CliLauncher(3456);
  next.setStore(new SessionStore(sessionDir));
  next.restoreFromDisk();
  return next;
}

beforeEach(() => {
  mkdirSync(h.home, { recursive: true });
  sessionDir = mkdtempSync(join(tmpdir(), "launcher-env-sessions-"));
  store = new SessionStore(sessionDir);
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => mockProc());
  h.settings = { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "" };
  process.env.COMPANION_CODEX_TRANSPORT = "stdio";
  process.env.COMPANION_RELAUNCH_GRACE_MS = "10";
  // A restored session's pid is signalled on relaunch; never signal anything real.
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  companionBus.clear();
  delete process.env.COMPANION_CODEX_TRANSPORT;
  delete process.env.COMPANION_RELAUNCH_GRACE_MS;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("CliLauncher env resolution", () => {
  // The full precedence chain as the CLI sees it, then the same env again
  // after a restart: global < project (shallow < deep) < explicit < request,
  // plus the settings token and the Linear key re-resolved from their sources.
  it("re-resolves profiles, explicit slug, request env and tokens on relaunch after a restart", async () => {
    envManager.createEnv("Everywhere", { SHARED: "global", G: "1" }, { scope: "global" });
    envManager.createEnv("Repo", { SHARED: "repo", R: "1" }, { scope: "project", folders: ["/work/repo"] });
    envManager.createEnv("Repo Sub", { SHARED: "sub" }, { scope: "project", folders: ["/work/repo/sub"] });
    envManager.createEnv("Jarvis", { J: "1", R: "jarvis" }); // legacy-style: unassigned
    h.settings.claudeCodeOAuthToken = "settings-oauth";

    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({
      cwd: "/work/repo/sub/pkg",
      envSlug: "jarvis",
      env: { REQ: "from-request", J: "request-wins" },
      linearConnectionId: "conn-1",
    });

    const first = spawnEnv(0);
    expect(first).toMatchObject({
      G: "1",
      SHARED: "sub",
      R: "jarvis",
      J: "request-wins",
      REQ: "from-request",
      CLAUDE_CODE_OAUTH_TOKEN: "settings-oauth",
      LINEAR_API_KEY: "lin-key",
    });
    expect(info.envProfiles).toEqual(["Everywhere", "Repo", "Repo Sub", "Jarvis"]);

    // launcher.json keeps references only, never the values.
    const persisted = readFileSync(join(sessionDir, "launcher.json"), "utf-8");
    expect(persisted).toContain('"envSlug":"jarvis"');
    expect(persisted).toContain('"linearConnectionId":"conn-1"');
    expect(persisted).not.toContain("from-request");
    expect(persisted).not.toContain("settings-oauth");
    expect(persisted).not.toContain("lin-key");

    // Restart: a brand-new launcher with no in-memory state. The settings
    // token rotated meanwhile; the relaunch must pick up the new one.
    h.settings.claudeCodeOAuthToken = "rotated-oauth";
    const restarted = restartedLauncher();
    expect(await restarted.relaunch(info.sessionId)).toEqual({ ok: true });

    expect(spawnEnv(1)).toMatchObject({
      G: "1",
      SHARED: "sub",
      R: "jarvis",
      J: "request-wins",
      REQ: "from-request",
      CLAUDE_CODE_OAUTH_TOKEN: "rotated-oauth",
      LINEAR_API_KEY: "lin-key",
    });
    expect(restarted.getSession(info.sessionId)?.envProfiles).toEqual(["Everywhere", "Repo", "Repo Sub", "Jarvis"]);
  });

  // Profiles are read at spawn time, so editing one reaches the session on
  // its next relaunch instead of being frozen at creation.
  it("applies profile edits on the next relaunch", async () => {
    envManager.createEnv("Repo", { TOKEN: "old" }, { scope: "project", folders: ["/work/repo"] });
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({ cwd: "/work/repo" });
    expect(spawnEnv(0).TOKEN).toBe("old");

    envManager.updateEnv("repo", { variables: { TOKEN: "new" } });
    await launcher.relaunch(info.sessionId);
    expect(spawnEnv(1).TOKEN).toBe("new");
  });

  // Marco's legacy profile has no scope: it must never leak into sessions
  // that did not pick it, but must still work when picked.
  it("never applies an unassigned profile unless it is chosen explicitly", () => {
    envManager.createEnv("Jarvis", { J: "1" });
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);

    const plain = launcher.launch({ cwd: "/anywhere" });
    expect(spawnEnv(0).J).toBeUndefined();
    expect(plain.envProfiles).toBeUndefined();

    launcher.launch({ cwd: "/anywhere", envSlug: "jarvis" });
    expect(spawnEnv(1).J).toBe("1");
  });

  // Worktrees live under ~/.companion/worktrees, outside the project folder;
  // the persisted repo root still matches the project's profiles.
  it("matches project profiles through the worktree's repo root", () => {
    envManager.createEnv("Repo", { R: "1" }, { scope: "project", folders: ["/work/repo"] });
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);

    launcher.launch({ cwd: `${h.home}/worktrees/repo/feat`, repoRoot: "/work/repo" });
    expect(spawnEnv(0).R).toBe("1");
  });

  // Codex gets the same resolution, with OPENAI_API_KEY from settings, on
  // launch and on relaunch.
  it("resolves the env for Codex sessions on launch and relaunch", async () => {
    envManager.createEnv("Everywhere", { G: "1" }, { scope: "global" });
    h.settings.openaiApiKey = "sk-settings";
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);

    const info = launcher.launch({ cwd: "/work", backendType: "codex", env: { REQ: "r" } });
    expect(spawnEnv(0)).toMatchObject({ G: "1", REQ: "r", OPENAI_API_KEY: "sk-settings" });
    expect(spawnEnv(0).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    await restartedLauncher().relaunch(info.sessionId);
    expect(spawnEnv(1)).toMatchObject({ G: "1", REQ: "r", OPENAI_API_KEY: "sk-settings" });
  });

  // The request env can hold secrets: owner-only sidecar, removed with the session.
  it("stores the request env owner-only and deletes it with the session", () => {
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({ cwd: "/work", env: { SECRET: "s" } });

    const dir = join(sessionDir, "request-env");
    const file = join(dir, `${info.sessionId}.json`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ SECRET: "s" });

    launcher.removeSession(info.sessionId);
    expect(() => statSync(file)).toThrow();
  });
});
