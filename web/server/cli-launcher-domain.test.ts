import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Domains through the real CliLauncher: what a domain session gets at every
 * spawn and relaunch (Claude flags/env/settings, Codex CODEX_HOME), and —
 * just as important — that legacy sessions (from before domains) spawn
 * EXACTLY as before. Everything lives in a temp dir.
 */

const h = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/companion-launcher-domain-${process.pid}-${Date.now()}`,
  settings: { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "" } as Record<string, unknown>,
  uuid: 0,
}));
vi.mock("./paths.js", () => ({ COMPANION_HOME: h.home, legacyStatePath: () => null }));
vi.mock("./linear-connections.js", () => ({ getConnection: () => null }));
vi.mock("node:crypto", () => ({ randomUUID: () => `sess-${++h.uuid}` }));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: (name: string) => `/opt/fake/${name}`,
  getEnrichedPath: () => "/usr/bin",
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => h.settings }));
vi.mock("./claude-session-history.js", () => ({ claudeTranscriptExists: () => true }));
vi.mock("./codex-home.js", () => ({
  getLegacyCodexHome: () => `${h.home}/legacy-codex`,
  resolveCompanionCodexSessionHome: (id: string) => `${h.home}/codex/${id}`,
  authRefreshedAt: () => 0,
}));

import { CliLauncher, usesDomain } from "./cli-launcher.js";
import { companionBus } from "./event-bus.js";
import { SessionStore } from "./session-store.js";
import { createDomain, domainDir, ensureGlobalDomain, updateDomain, GLOBAL_DOMAIN } from "./domain-store.js";
import { domainRuntimeDir } from "./domain-runtime.js";

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

const configDir = () => join(h.home, "sessions", "mcp-config");
const spawnArgs = (n: number): string[] => mockSpawn.mock.calls[n][0];
const spawnEnv = (n: number): Record<string, string | undefined> => mockSpawn.mock.calls[n][1].env;

function wiredLauncher(): CliLauncher {
  const launcher = new CliLauncher(3456);
  launcher.setCompanionMcp({ tokenFor: (id) => `tok-${id}`, claudeConfigDir: configDir(), command: "/opt/bun", script: "/opt/companion-mcp.ts" });
  return launcher;
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  mkdirSync(h.home, { recursive: true });
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => mockProc());
  h.settings = { cliBridgeMode: "loopback", claudeCodeOAuthToken: "", openaiApiKey: "" };
  process.env.COMPANION_CODEX_TRANSPORT = "stdio";
  process.env.COMPANION_RELAUNCH_GRACE_MS = "10";
  process.env.COMPANION_DOMAINS_ROOT = join(h.home, "home");
  process.env.CLAUDE_CONFIG_DIR = join(h.home, "claude");
  // Set when the tests run from a shell of a domain session: spawns inherit
  // the environment, and only domain sessions may carry this variable.
  delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
  ensureGlobalDomain();
  createDomain({ name: "Herd" });
});

afterEach(() => {
  vi.restoreAllMocks();
  companionBus.clear();
  process.env = { ...SAVED_ENV };
  rmSync(h.home, { recursive: true, force: true });
});

describe("legacy sessions spawn exactly as before", () => {
  // The whole argument list of a legacy Claude spawn, frozen: no domain flag
  // may ever leak into the ~30 sessions that predate domains.
  it("Claude: same args and env as before domains", () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", model: "claude-opus-5-5", ultracode: true, permissionMode: "default" });
    expect(info).toMatchObject({ domain: GLOBAL_DOMAIN, legacyMemory: true });
    expect(usesDomain(info)).toBe(false);
    expect(spawnArgs(0)).toEqual([
      "/opt/fake/claude",
      "--sdk-url", "ws://127.0.0.1:3456/ws/cli/sess-1",
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model", "claude-opus-5-5",
      "--settings", '{"ultracode":true}',
      "--permission-mode", "default",
      "--mcp-config", join(configDir(), "sess-1.json"),
      "--disallowedTools", "ScheduleWakeup,CronCreate,CronDelete,CronList",
      "-p", "",
    ]);
    expect(spawnEnv(0).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBeUndefined();
    expect(existsSync(domainRuntimeDir(info.sessionId))).toBe(false);
  });

  // Relaunch (reconnect, model change...) must not add anything either.
  it("Claude: a relaunch keeps the legacy args", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work" });
    launcher.setCLISessionId(info.sessionId, "cli-1");
    await launcher.relaunch(info.sessionId);
    const args = spawnArgs(1);
    expect(args).not.toContain("--plugin-dir");
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--settings");
    expect(args).toContain("--resume");
  });

  // Codex: the AGENTS.md link to ~/.codex/AGENTS.md and the companion server only.
  it("Codex: AGENTS.md stays a link and config.toml gets only the companion server", () => {
    mkdirSync(join(h.home, "legacy-codex"), { recursive: true });
    writeFileSync(join(h.home, "legacy-codex", "AGENTS.md"), "user rules");
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex" });
    const home = join(h.home, "codex", info.sessionId);
    expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(true);
    const toml = readFileSync(join(home, "config.toml"), "utf-8");
    expect(toml.match(/^\[mcp_servers\.[^\]]+\]$/gm)).toEqual(["[mcp_servers.companion]"]);
    expect(existsSync(join(home, ".companion-domain.json"))).toBe(false);
  });

  // "Change folder" pins the memory of the folder the session was in.
  it("Claude: a pinned memory folder is passed as autoMemoryDirectory", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", model: "claude-opus-5-5", ultracode: true });
    launcher.setCwd(info.sessionId, "/elsewhere", { pinnedMemoryDir: "/mem/work" });
    await launcher.relaunch(info.sessionId);
    const args = spawnArgs(1);
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ ultracode: true, autoMemoryDirectory: "/mem/work" });
    expect(args).not.toContain("--plugin-dir");
    expect(launcher.getSession(info.sessionId)).toMatchObject({ cwd: "/elsewhere", pinnedMemoryDir: "/mem/work" });
  });

  // launcher.json from before domains: every session is marked legacy once.
  it("marks sessions restored from before domains as legacy GLOBAL", () => {
    const store = new SessionStore(join(h.home, "sessions"));
    store.saveLauncher([
      { sessionId: "old-1", state: "exited", cwd: "/a", createdAt: 1 },
      { sessionId: "new-1", state: "exited", cwd: "/b", createdAt: 2, domain: "herd" },
    ]);
    const launcher = new CliLauncher(3456);
    launcher.setStore(store);
    launcher.restoreFromDisk();
    expect(launcher.getSession("old-1")).toMatchObject({ domain: GLOBAL_DOMAIN, legacyMemory: true });
    expect(launcher.getSession("new-1")?.legacyMemory).toBeUndefined();
    expect(launcher.setDomain("old-1", "herd")).toBe(false);
  });
});

describe("domain sessions (Claude)", () => {
  it("adds the domain flags after the companion MCP config, with one merged --settings", () => {
    writeFileSync(join(domainDir("herd"), "mcp.json"), JSON.stringify({ mcpServers: { ping: { command: "node" } } }));
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", domain: "herd", model: "claude-opus-5-5", ultracode: true });
    expect(usesDomain(info)).toBe(true);
    const args = spawnArgs(0);
    const runtime = domainRuntimeDir(info.sessionId);
    const companionAt = args.indexOf("--mcp-config");
    expect(args[companionAt + 1]).toBe(join(configDir(), `${info.sessionId}.json`));
    // Both MCP configs load: the companion one, then the domain's.
    expect(args.slice(companionAt + 2)).toEqual([
      "--disallowedTools", "ScheduleWakeup,CronCreate,CronDelete,CronList",
      "--plugin-dir", domainDir(GLOBAL_DOMAIN),
      "--plugin-dir", domainDir("herd"),
      "--add-dir", domainDir(GLOBAL_DOMAIN),
      "--add-dir", domainDir("herd"),
      "--mcp-config", join(runtime, "mcp.json"),
      "--append-system-prompt-file", join(runtime, "global-memory.md"),
      "-p", "",
    ]);
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
      ultracode: true,
      autoMemoryDirectory: join(domainDir("herd"), "memory"),
    });
    expect(spawnEnv(0).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
    expect(info.chromeActive).toBeUndefined();
  });

  // Edits to the domain apply at the next relaunch, which also resumes.
  it("rebuilds the domain context at every relaunch, and follows a domain change", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", domain: GLOBAL_DOMAIN });
    expect(spawnArgs(0)).not.toContain("--append-system-prompt-file");
    launcher.setCLISessionId(info.sessionId, "cli-1");
    updateDomain("herd", { chrome: true });
    expect(launcher.setDomain(info.sessionId, "herd")).toBe(true);
    await launcher.relaunch(info.sessionId);
    const args = spawnArgs(1);
    expect(args).toContain(domainDir("herd"));
    expect(args).toContain("--chrome");
    expect(args).toContain("--resume");
    expect(launcher.getSession(info.sessionId)?.chromeActive).toBe(true);
    // The pinned memory of legacy sessions never applies to domain sessions.
    launcher.setCwd(info.sessionId, "/x", { pinnedMemoryDir: "/mem" });
    await launcher.relaunch(info.sessionId);
    const again = spawnArgs(2);
    expect(JSON.parse(again[again.indexOf("--settings") + 1]).autoMemoryDirectory).toBe(join(domainDir("herd"), "memory"));
  });

  it("removes the generated files with the session", () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", domain: "herd" });
    expect(existsSync(domainRuntimeDir(info.sessionId))).toBe(true);
    launcher.removeSession(info.sessionId);
    expect(existsSync(domainRuntimeDir(info.sessionId))).toBe(false);
  });
});

describe("domain sessions (Codex)", () => {
  it("writes AGENTS.md, the companion and domain servers, and links the domain skills", () => {
    mkdirSync(join(h.home, "legacy-codex"), { recursive: true });
    writeFileSync(join(h.home, "legacy-codex", "AGENTS.md"), "user rules");
    writeFileSync(join(h.home, "legacy-codex", "config.toml"), 'model = "gpt"\n');
    writeFileSync(join(domainDir("herd"), "mcp.json"), JSON.stringify({ mcpServers: { ping: { command: "node", args: ["p.js"] } } }));
    mkdirSync(join(domainDir("herd"), "skills", "herd-hello"), { recursive: true });
    writeFileSync(join(domainDir("herd"), "skills", "herd-hello", "SKILL.md"), "---\nname: herd-hello\n---\n");

    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex", domain: "herd" });
    const home = join(h.home, "codex", info.sessionId);
    const agents = readFileSync(join(home, "AGENTS.md"), "utf-8");
    expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(agents).toContain("user rules");
    expect(agents).toContain(`${join(domainDir("herd"), "memory")}/MEMORY.md`);
    const toml = readFileSync(join(home, "config.toml"), "utf-8");
    expect(toml.startsWith('model = "gpt"')).toBe(true);
    expect(toml.match(/^\[mcp_servers\.[^\]]+\]$/gm)).toEqual(["[mcp_servers.companion]", "[mcp_servers.ping]"]);
    expect(readlinkSync(join(home, "skills", "herd-hello"))).toBe(join(domainDir("herd"), "skills", "herd-hello"));
  });

  // Switching a server off removes it at the next relaunch, and repeated
  // spawns never rewrite an unchanged file into a different order.
  it("removes a switched-off server at relaunch", async () => {
    writeFileSync(join(domainDir("herd"), "mcp.json"), JSON.stringify({ mcpServers: { ping: { command: "node" } } }));
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex", domain: "herd" });
    const path = join(h.home, "codex", info.sessionId, "config.toml");
    const first = readFileSync(path, "utf-8");
    await launcher.relaunch(info.sessionId);
    expect(readFileSync(path, "utf-8")).toBe(first);
    updateDomain("herd", { mcpDisabled: ["ping"] });
    await launcher.relaunch(info.sessionId);
    expect(readFileSync(path, "utf-8")).not.toContain("[mcp_servers.ping]");
    expect(readFileSync(path, "utf-8")).toContain("[mcp_servers.companion]");
  });

  // Without the companion server wired, domain servers are still written.
  it("writes domain servers when the companion MCP is not wired", () => {
    writeFileSync(join(domainDir("herd"), "mcp.json"), JSON.stringify({ mcpServers: { ping: { command: "node" } } }));
    const launcher = new CliLauncher(3456);
    const info = launcher.launch({ cwd: "/work", backendType: "codex", domain: "herd" });
    const toml = readFileSync(join(h.home, "codex", info.sessionId, "config.toml"), "utf-8");
    expect(toml.match(/^\[mcp_servers\.[^\]]+\]$/gm)).toEqual(["[mcp_servers.ping]"]);
  });
});

// Migration is how a legacy session joins a domain: from the next relaunch it
// spawns like a domain session, on the same conversation and folder.
describe("migrating legacy sessions", () => {
  it("Claude: after migration the relaunch resumes the conversation with the domain's context", async () => {
    const store = new SessionStore(join(h.home, "sessions"));
    store.saveLauncher([
      { sessionId: "old-1", state: "exited", cwd: "/a", createdAt: 1, cliSessionId: "cli-old", pinnedMemoryDir: "/mem/a" },
    ]);
    const launcher = wiredLauncher();
    launcher.setStore(store);
    launcher.restoreFromDisk();

    expect(launcher.migrateToDomain("old-1", "herd")).toBe(true);
    expect(launcher.getSession("old-1")).toMatchObject({ domain: "herd", cwd: "/a" });
    expect(launcher.getSession("old-1")?.legacyMemory).toBeUndefined();
    // Persisted, so a server restart does not turn it back into a legacy session.
    expect(store.loadLauncher<{ sessionId: string; domain?: string; legacyMemory?: boolean }[]>()?.[0]).toMatchObject({ domain: "herd" });
    expect(store.loadLauncher<{ legacyMemory?: boolean }[]>()?.[0].legacyMemory).toBeUndefined();

    await launcher.relaunch("old-1");
    const args = spawnArgs(0);
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "cli-old"]);
    expect(args).toContain(domainDir("herd"));
    // The domain memory replaces the old folder memory (pinned or not).
    expect(JSON.parse(args[args.indexOf("--settings") + 1]).autoMemoryDirectory).toBe(join(domainDir("herd"), "memory"));
    expect(spawnEnv(0).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
  });

  it("Codex: the link to the user's AGENTS.md is replaced, never written through", async () => {
    mkdirSync(join(h.home, "legacy-codex"), { recursive: true });
    writeFileSync(join(h.home, "legacy-codex", "AGENTS.md"), "user rules");
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex" });
    const agentsMd = join(h.home, "codex", info.sessionId, "AGENTS.md");
    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);

    expect(launcher.migrateToDomain(info.sessionId, "herd")).toBe(true);
    await launcher.relaunch(info.sessionId);
    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(false);
    expect(readFileSync(agentsMd, "utf-8")).toContain(`${join(domainDir("herd"), "memory")}/MEMORY.md`);
    expect(readFileSync(join(h.home, "legacy-codex", "AGENTS.md"), "utf-8")).toBe("user rules");
  });

  it("only migrates legacy sessions", () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", domain: "herd" });
    expect(launcher.migrateToDomain(info.sessionId, GLOBAL_DOMAIN)).toBe(false);
    expect(launcher.getSession(info.sessionId)?.domain).toBe("herd");
    expect(launcher.migrateToDomain("missing", "herd")).toBe(false);
  });
});

describe("domain brain (both CLIs)", () => {
  // A bearer brain through the real launcher: Claude gets the header in its
  // per-session MCP config, Codex the token in the process env and only the
  // variable name in config.toml (CODEX_HOME is not private).
  it("passes the brain's token to Claude's config and Codex's env, never to config.toml", async () => {
    const { createRemoteBrain, brainPluginDir } = await import("./brain/brain-store.js");
    createRemoteBrain({ name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "tok-launch" });
    updateDomain("herd", { brain: "team" });
    const launcher = wiredLauncher();

    const claude = launcher.launch({ cwd: "/work", domain: "herd" });
    const args = spawnArgs(0);
    expect(args).toContain(brainPluginDir("team"));
    const mcp = JSON.parse(readFileSync(join(domainRuntimeDir(claude.sessionId), "mcp.json"), "utf-8"));
    expect(mcp.mcpServers["team-brain"].headers).toEqual({ Authorization: "Bearer tok-launch" });
    expect(spawnEnv(0).COMPANION_BRAIN_TEAM_TOKEN).toBeUndefined();

    const codex = launcher.launch({ cwd: "/work", backendType: "codex", domain: "herd" });
    expect(spawnEnv(1).COMPANION_BRAIN_TEAM_TOKEN).toBe("tok-launch");
    const toml = readFileSync(join(h.home, "codex", codex.sessionId, "config.toml"), "utf-8");
    expect(toml).toContain('bearer_token_env_var = "COMPANION_BRAIN_TEAM_TOKEN"');
    expect(toml).not.toContain("tok-launch");
    // Codex passes its env to the shell commands it runs (verified: an echo
    // printed the token): the brain (and MCP proxy token) variables are excluded from them.
    const codexArgs = spawnArgs(1);
    const i = codexArgs.indexOf('shell_environment_policy.exclude=["COMPANION_BRAIN_*", "COMPANION_MCP_AUTH_*"]');
    expect(i).toBeGreaterThan(0);
    expect(codexArgs[i - 1]).toBe("-c");
    // Without a token there is nothing to hide: no override.
    updateDomain("herd", { brain: null });
    launcher.launch({ cwd: "/work", backendType: "codex", domain: "herd" });
    expect(spawnArgs(2).join(" ")).not.toContain("shell_environment_policy");
  });

  // Legacy sessions (from before domains) never get a brain, even GLOBAL's.
  it("gives legacy sessions nothing", async () => {
    const { createRemoteBrain } = await import("./brain/brain-store.js");
    createRemoteBrain({ name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "tok-launch" });
    updateDomain(GLOBAL_DOMAIN, { brain: "team" });
    const launcher = wiredLauncher();
    launcher.launch({ cwd: "/work" });
    expect(spawnArgs(0).join(" ")).not.toContain("brains");
    launcher.launch({ cwd: "/work", backendType: "codex" });
    expect(spawnEnv(1).COMPANION_BRAIN_TEAM_TOKEN).toBeUndefined();
  });
});
