import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How the built-in `companion` MCP server reaches every spawned CLI, through
 * the real CliLauncher: Claude gets `--mcp-config <private file>`, Codex gets
 * `[mcp_servers.companion]` upserted into its per-session config.toml, the
 * Settings switch turns both off, and Companion's own secrets
 * (COMPANION_AUTH_TOKEN, a parent session's MCP variables) never reach a CLI.
 */

const h = vi.hoisted(() => ({
  home: `${process.env.TMPDIR || "/tmp"}/companion-launcher-mcp-${process.pid}-${Date.now()}`,
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

import { CliLauncher } from "./cli-launcher.js";
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

const configDir = () => join(h.home, "sessions", "mcp-config");
const spawnArgs = (n: number): string[] => mockSpawn.mock.calls[n][0];
const spawnEnv = (n: number): Record<string, string | undefined> => mockSpawn.mock.calls[n][1].env;

function wiredLauncher(tokenFor = (id: string) => `cmcp_${id}.tok`): CliLauncher {
  const launcher = new CliLauncher(3456);
  launcher.setCompanionMcp({ tokenFor, claudeConfigDir: configDir(), command: "/opt/bun", script: "/opt/companion-mcp.ts" });
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
  // Companion's own secrets, and the MCP variables of a session Companion
  // itself might have been started from (a dev server run inside a session).
  process.env.COMPANION_AUTH_TOKEN = "companion-auth-secret";
  process.env.COMPANION_MCP_TOKEN = "parent-session-token";
  process.env.COMPANION_SESSION_ID = "parent-session";
  process.env.COMPANION_API_URL = "http://127.0.0.1:9999/api";
  vi.spyOn(process, "kill").mockImplementation((() => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
  companionBus.clear();
  process.env = { ...SAVED_ENV };
  rmSync(h.home, { recursive: true, force: true });
});

describe("companion MCP for Claude sessions", () => {
  it("passes --mcp-config with a private file naming the companion server", () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work" });

    const args = spawnArgs(0);
    const at = args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(0);
    const path = args[at + 1];
    expect(path).toBe(join(configDir(), `${info.sessionId}.json`));
    // User MCP servers must keep working.
    expect(args).not.toContain("--strict-mcp-config");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      mcpServers: {
        companion: {
          type: "stdio",
          command: "/opt/bun",
          args: ["/opt/companion-mcp.ts"],
          env: {
            COMPANION_SESSION_ID: info.sessionId,
            COMPANION_API_URL: "http://127.0.0.1:3456/api",
            COMPANION_MCP_TOKEN: `cmcp_${info.sessionId}.tok`,
          },
        },
      },
    });
    // The token is in the file, never on the command line.
    expect(args.join(" ")).not.toContain(".tok");
  });

  // Companion's auth token and a parent session's MCP variables are not
  // inherited; an env profile / request env may still set them on purpose.
  it("does not leak Companion's own secrets into the CLI env", () => {
    const launcher = wiredLauncher();
    launcher.launch({ cwd: "/work" });
    const env = spawnEnv(0);
    expect(env.COMPANION_AUTH_TOKEN).toBeUndefined();
    expect(env.COMPANION_MCP_TOKEN).toBeUndefined();
    expect(env.COMPANION_SESSION_ID).toBeUndefined();
    expect(env.COMPANION_API_URL).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");

    launcher.launch({ cwd: "/work", env: { COMPANION_AUTH_TOKEN: "explicit" } });
    expect(spawnEnv(1).COMPANION_AUTH_TOKEN).toBe("explicit");
  });

  // Every relaunch rewrites the file, so a new token (or setting) applies.
  it("rewrites the config at relaunch and removes it with the session", async () => {
    let n = 0;
    const launcher = wiredLauncher((id) => `cmcp_${id}.v${++n}`);
    const info = launcher.launch({ cwd: "/work" });
    const path = join(configDir(), `${info.sessionId}.json`);
    expect(readFileSync(path, "utf-8")).toContain(".v1");

    await launcher.relaunch(info.sessionId);
    expect(spawnArgs(1)).toContain("--mcp-config");
    expect(readFileSync(path, "utf-8")).toContain(".v2");

    launcher.removeSession(info.sessionId);
    expect(existsSync(path)).toBe(false);
  });

  it("removes the configs of pruned sessions", () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work" });
    const path = join(configDir(), `${info.sessionId}.json`);
    launcher.getSession(info.sessionId)!.state = "exited";
    expect(launcher.pruneExited()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  // Settings → "Companion MCP tools for sessions" off: no flag, and a file
  // left by an earlier launch is removed.
  it("injects nothing when the setting is off", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work" });
    const path = join(configDir(), `${info.sessionId}.json`);
    expect(existsSync(path)).toBe(true);

    h.settings.companionMcpEnabled = false;
    await launcher.relaunch(info.sessionId);
    expect(spawnArgs(1)).not.toContain("--mcp-config");
    expect(existsSync(path)).toBe(false);
  });

  // Review finding: with the companion tools listed, a real Claude CLI still
  // picked its built-in ScheduleWakeup, whose wake-up lives only in the CLI
  // process (lost on idle-kill/restart, invisible in Companion). With the
  // MCP server injected those built-ins are denied, at every relaunch; with
  // the setting off they stay available.
  it("disallows Claude's built-in scheduling tools only while the MCP server is injected", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work" });
    const flagValue = (n: number) => {
      const args = spawnArgs(n);
      const at = args.indexOf("--disallowedTools");
      return at < 0 ? undefined : args[at + 1];
    };
    expect(flagValue(0)).toBe("ScheduleWakeup,CronCreate,CronDelete,CronList");

    await launcher.relaunch(info.sessionId);
    expect(flagValue(1)).toBe("ScheduleWakeup,CronCreate,CronDelete,CronList");

    h.settings.companionMcpEnabled = false;
    await launcher.relaunch(info.sessionId);
    expect(spawnArgs(2)).not.toContain("--mcp-config");
    expect(flagValue(2)).toBeUndefined();
  });

  // Review finding: `--tools` limits only built-in tools, and agents run with
  // bypassPermissions, so a "read-only" agent (allowedTools) that got the
  // companion MCP could create and run an unrestricted agent. Such sessions
  // get no MCP server at all, at launch and at relaunch.
  it("does not inject the MCP server into a tool-restricted session", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", tools: ["Read", "WebFetch"], permissionMode: "bypassPermissions" });
    const args = spawnArgs(0);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,WebFetch");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--disallowedTools");
    expect(existsSync(join(configDir(), `${info.sessionId}.json`))).toBe(false);

    await launcher.relaunch(info.sessionId);
    expect(spawnArgs(1)).toContain("--tools");
    expect(spawnArgs(1)).not.toContain("--mcp-config");
  });

  // Not wired (embedders, older tests): behaviour is unchanged.
  it("injects nothing when the launcher is not wired", () => {
    const launcher = new CliLauncher(3456);
    launcher.launch({ cwd: "/work" });
    expect(spawnArgs(0)).not.toContain("--mcp-config");
    expect(spawnEnv(0).COMPANION_AUTH_TOKEN).toBeUndefined();
  });

  // A config that cannot be written must not stop the session from starting.
  it("starts without the MCP server when the config cannot be written", () => {
    writeFileSync(join(h.home, "not-a-dir"), "");
    const launcher = new CliLauncher(3456);
    launcher.setCompanionMcp({ tokenFor: () => "t", claudeConfigDir: join(h.home, "not-a-dir", "sub") });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    launcher.launch({ cwd: "/work" });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(spawnArgs(0)).not.toContain("--mcp-config");
  });
});

describe("companion MCP for Codex sessions", () => {
  const legacyConfig = 'model = "gpt-5.5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';

  // The seeded user config is kept and the companion server is added, with
  // the same variables as for Claude. Codex has no flag for this: the
  // per-session CODEX_HOME/config.toml is the way.
  it("upserts mcp_servers.companion into the session's config.toml", () => {
    mkdirSync(`${h.home}/legacy-codex`, { recursive: true });
    writeFileSync(`${h.home}/legacy-codex/config.toml`, legacyConfig);
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex" });

    const text = readFileSync(`${h.home}/codex/${info.sessionId}/config.toml`, "utf-8");
    expect(text.startsWith(legacyConfig.trimEnd())).toBe(true);
    expect(text).toContain("[mcp_servers.companion]");
    expect(text).toContain('command = "/opt/bun"');
    expect(text).toContain(`COMPANION_SESSION_ID = "${info.sessionId}"`);
    expect(text).toContain('COMPANION_API_URL = "http://127.0.0.1:3456/api"');
    expect(text).toContain(`COMPANION_MCP_TOKEN = "cmcp_${info.sessionId}.tok"`);
    // The user's global config is only read.
    expect(readFileSync(`${h.home}/legacy-codex/config.toml`, "utf-8")).toBe(legacyConfig);

    const env = spawnEnv(0);
    expect(env.CODEX_HOME).toBe(`${h.home}/codex/${info.sessionId}`);
    expect(env.COMPANION_AUTH_TOKEN).toBeUndefined();
    expect(env.COMPANION_SESSION_ID).toBeUndefined();
  });

  // Works without a ~/.codex to seed from, and the setting removes the entry
  // at the next launch while leaving the rest of the file alone.
  it("adds the entry without a legacy home and removes it when turned off", async () => {
    const launcher = wiredLauncher();
    const info = launcher.launch({ cwd: "/work", backendType: "codex" });
    const path = `${h.home}/codex/${info.sessionId}/config.toml`;
    expect(readFileSync(path, "utf-8")).toContain("[mcp_servers.companion]");
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n[profiles.mine]\nmodel = "x"\n`);

    h.settings.companionMcpEnabled = false;
    await launcher.relaunch(info.sessionId);
    const text = readFileSync(path, "utf-8");
    expect(text).not.toContain("companion");
    expect(text).toContain('[profiles.mine]\nmodel = "x"');
  });

  it("leaves config.toml alone when the launcher is not wired", () => {
    const launcher = new CliLauncher(3456);
    const info = launcher.launch({ cwd: "/work", backendType: "codex" });
    expect(existsSync(`${h.home}/codex/${info.sessionId}/config.toml`)).toBe(false);
  });
});
