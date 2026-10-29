import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A LOCAL session through the real CliLauncher + SessionStore: what the
 * spawned Claude Code receives (the provider's proxy URL and token,
 * `--model sonnet`, `--effort` only with one of the provider's levels,
 * WebSearch disallowed, every Anthropic credential removed even
 * when Companion's env, an env profile or the Settings token carries one),
 * and that provider, model and level survive a server restart and come
 * back on relaunch/--resume.
 */

const h = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/companion-launcher-local-${process.pid}-${Date.now()}`,
  settings: { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "", localLlmEnabled: true } as Record<string, string | boolean>,
  uuid: 0,
}));
vi.mock("./paths.js", () => ({ COMPANION_HOME: h.home }));
vi.mock("node:crypto", async (orig) => ({ ...(await orig<typeof import("node:crypto")>()), randomUUID: () => `sess-${++h.uuid}` }));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: (name: string) => `/opt/fake/${name}`,
  getEnrichedPath: () => "/usr/bin",
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => h.settings }));
vi.mock("./claude-session-history.js", () => ({ claudeTranscriptExists: () => true }));
vi.mock("./linear-connections.js", () => ({ getConnection: () => null }));
vi.mock("./codex-home.js", () => ({
  getLegacyCodexHome: () => `${h.home}/no-legacy-codex`,
  resolveCompanionCodexSessionHome: (id: string) => `${h.home}/codex/${id}`,
  authRefreshedAt: () => 0,
}));

import { SessionStore } from "./session-store.js";
import { CliLauncher } from "./cli-launcher.js";
import * as envManager from "./env-manager.js";
import { companionBus } from "./event-bus.js";
import { createLocalProvider, deleteLocalProvider } from "./local-providers.js";

function mockProc() {
  return {
    pid: 99_999_999,
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
const savedApiKey = process.env.ANTHROPIC_API_KEY;

const spawnArgs = (n: number): string[] => mockSpawn.mock.calls[n][0];
const spawnEnv = (n: number): Record<string, string | undefined> => mockSpawn.mock.calls[n][1].env;
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

beforeEach(() => {
  mkdirSync(h.home, { recursive: true });
  sessionDir = mkdtempSync(join(tmpdir(), "launcher-local-sessions-"));
  store = new SessionStore(sessionDir);
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => mockProc());
  h.settings = { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "", localLlmEnabled: true };
  process.env.COMPANION_RELAUNCH_GRACE_MS = "10";
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  const r = createLocalProvider({ name: "Lab", baseUrl: "http://proxy.example:8787", models: ["my-model", "qwen3-coder"], token: "proxy-secret-token" });
  if (!r.ok) throw new Error(r.error);
});

afterEach(() => {
  vi.restoreAllMocks();
  companionBus.clear();
  delete process.env.COMPANION_RELAUNCH_GRACE_MS;
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("CliLauncher — local sessions", () => {
  it("spawns Claude Code on the proxy with the model alias and no Anthropic credential", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-from-companion-env";
    h.settings.claudeCodeOAuthToken = "sk-ant-oat-from-settings";
    envManager.createEnv("Everywhere", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-from-profile", KEEP: "1" }, { scope: "global" });

    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({ cwd: "/tmp", local: { provider: "lab", model: "qwen3-coder" }, effort: "xhigh", ultracode: true });

    expect(info).toMatchObject({ backendType: "claude", model: "qwen3-coder", effort: "xhigh", local: { provider: "lab", model: "qwen3-coder" } });
    expect(info.ultracode).toBeUndefined();
    const args = spawnArgs(0);
    expect(flag(args, "--model")).toBe("sonnet");
    // The level travels as Claude Code's own effort, which the proxy maps.
    expect(flag(args, "--effort")).toBe("xhigh");
    expect(args).toContain("--disallowedTools");
    expect(args[args.lastIndexOf("--disallowedTools") + 1]).toBe("WebSearch");
    expect(args.join(" ")).not.toContain("ultracode");

    const env = spawnEnv(0);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://proxy.example:8787",
      ANTHROPIC_AUTH_TOKEN: "proxy-secret-token",
      ANTHROPIC_CUSTOM_HEADERS: `X-Companion-Session: ${info.sessionId}`,
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-coder",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "131072",
      KEEP: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("sk-ant-");
  });

  // launcher.json keeps provider, model and level: a restart + relaunch resumes the same conversation on the same provider.
  it("keeps provider, model and level across a server restart and relaunch", async () => {
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({ cwd: "/tmp", local: { provider: "lab" } });
    expect(info).toMatchObject({ model: "my-model", effort: "high" });
    launcher.setCLISessionId(info.sessionId, "cli-transcript-1");
    launcher.setEffort(info.sessionId, "low");

    const next = new CliLauncher(3456);
    next.setStore(new SessionStore(sessionDir));
    next.restoreFromDisk();
    expect(next.getSession(info.sessionId)).toMatchObject({ local: { provider: "lab", model: "my-model" }, effort: "low" });
    await next.relaunch(info.sessionId);
    const args = spawnArgs(1);
    expect(flag(args, "--resume")).toBe("cli-transcript-1");
    expect(flag(args, "--model")).toBe("sonnet");
    expect(flag(args, "--effort")).toBe("low");
    expect(spawnEnv(1).ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("my-model");
    expect(spawnEnv(1).ANTHROPIC_BASE_URL).toBe("http://proxy.example:8787");
  });

  it("does not start a session whose provider was deleted", async () => {
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    const info = launcher.launch({ cwd: "/tmp", local: { provider: "lab" } });
    deleteLocalProvider("lab");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await launcher.relaunch(info.sessionId);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(launcher.getSession(info.sessionId)).toMatchObject({ state: "exited", exitCode: 1 });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
  });

  it("refuses unknown providers, unknown models and Codex", () => {
    const launcher = new CliLauncher(3456);
    expect(() => launcher.launch({ local: { provider: "nope" } })).toThrow(/Unknown local provider/);
    expect(() => launcher.launch({ local: { provider: "lab", model: "claude-opus-5-5" } })).toThrow(/not a model/);
    expect(() => launcher.launch({ backendType: "codex", local: { provider: "lab" } })).toThrow(/Claude Code sessions only/);
  });

  // An Anthropic session spawns exactly as before: no proxy, the real model, --effort.
  it("leaves Anthropic sessions untouched", () => {
    const launcher = new CliLauncher(3456);
    launcher.launch({ cwd: "/tmp", model: "claude-opus-5-5", effort: "high" });
    const args = spawnArgs(0);
    expect(flag(args, "--model")).toBe("claude-opus-5-5");
    expect(flag(args, "--effort")).toBe("high");
    expect(spawnEnv(0).ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
