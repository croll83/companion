import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPluginOn, listInstalledPlugins, pluginsOn } from "./claude-plugins.js";

/**
 * Which marketplace plugins domains can turn on, and what each brings (skills,
 * MCP servers) for Codex, read from a fake Claude config dir
 * (CLAUDE_CONFIG_DIR): installed_plugins.json, the plugin folders and the
 * user's settings.json. Also the on/off order: domain, then GLOBAL, then the
 * user's settings, the same order Claude sessions are spawned with.
 */

let tmp: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

function claudeDir() {
  return join(tmp, "claude");
}

/** A plugin folder in the cache, with a manifest, skills and an MCP file. */
function makePlugin(name: string, opts: { manifest?: Record<string, unknown>; skills?: string[]; mcp?: unknown } = {}): string {
  const root = join(claudeDir(), "plugins", "cache", "lab", name, "1.0.0");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: `${name} plugin`, ...opts.manifest }));
  for (const s of opts.skills ?? []) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  if (opts.mcp !== undefined) writeFileSync(join(root, ".mcp.json"), JSON.stringify(opts.mcp));
  return root;
}

function writeRegistry(plugins: Record<string, unknown[]>) {
  mkdirSync(join(claudeDir(), "plugins"), { recursive: true });
  writeFileSync(join(claudeDir(), "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function writeSettings(enabledPlugins: Record<string, boolean>) {
  writeFileSync(join(claudeDir(), "settings.json"), JSON.stringify({ enabledPlugins }));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "claude-plugins-")));
  process.env.CLAUDE_CONFIG_DIR = claudeDir();
  mkdirSync(claudeDir(), { recursive: true });
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("listInstalledPlugins", () => {
  it("returns nothing without a plugin registry", () => {
    expect(listInstalledPlugins()).toEqual([]);
  });

  // The shape of the real hercle-brain plugin: a flat .mcp.json (servers at
  // the top level) and one skill.
  it("reads a user install: manifest, skills, a flat .mcp.json and the user's settings", () => {
    const root = makePlugin("brain", { skills: ["brain"], mcp: { brain: { type: "http", url: "http://127.0.0.1:7420/mcp" } } });
    writeRegistry({ "brain@lab": [{ scope: "user", installPath: root, version: "0.9" }] });
    writeSettings({ "brain@lab": false });
    expect(listInstalledPlugins()).toEqual([{
      id: "brain@lab",
      name: "brain",
      marketplace: "lab",
      version: "1.0.0",
      description: "brain plugin",
      installPath: root,
      skills: ["brain"],
      mcpServers: { brain: { type: "http", url: "http://127.0.0.1:7420/mcp" } },
      enabledByUser: false,
    }]);
  });

  // Only user installs can serve a domain: a domain spans folders, while a
  // local/project install belongs to one folder.
  it("leaves out installs bound to one folder, and installs whose folder is gone", () => {
    const root = makePlugin("local-only");
    writeRegistry({
      "local-only@lab": [{ scope: "local", projectPath: "/some/repo", installPath: root }],
      "gone@lab": [{ scope: "user", installPath: join(tmp, "nowhere") }],
      "broken@lab": "not a list" as unknown as unknown[],
    });
    expect(listInstalledPlugins()).toEqual([]);
  });

  // Codex runs the servers itself, so ${CLAUDE_PLUGIN_ROOT} must be replaced
  // by the real folder (Claude does it for its own sessions).
  it("resolves ${CLAUDE_PLUGIN_ROOT} and reads mcpServers wrapped or declared in plugin.json", () => {
    const wrapped = makePlugin("wrapped", {
      mcp: { mcpServers: { tool: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool", args: ["--root", "${CLAUDE_PLUGIN_ROOT}", 3], env: { HOME_DIR: "${CLAUDE_PLUGIN_ROOT}/h", N: 1 }, flag: true } } },
    });
    const inline = makePlugin("inline", { manifest: { mcpServers: { api: { url: "https://x/mcp" }, nothing: {} } } });
    const byPath = makePlugin("by-path", { manifest: { mcpServers: "./servers.json" } });
    writeFileSync(join(byPath, "servers.json"), JSON.stringify({ mcpServers: { srv: { command: "srv" } } }));
    const absolute = makePlugin("absolute", { manifest: { mcpServers: join(byPath, "servers.json") } });
    writeRegistry({
      "wrapped@lab": [{ scope: "user", installPath: wrapped }],
      "inline@lab": [{ scope: "user", installPath: inline }],
      "by-path@lab": [{ scope: "user", installPath: byPath }],
      "absolute@lab": [{ scope: "user", installPath: absolute }],
    });
    const byId = Object.fromEntries(listInstalledPlugins().map((p) => [p.id, p]));
    expect(byId["wrapped@lab"].mcpServers.tool).toEqual({
      command: `${wrapped}/bin/tool`,
      args: ["--root", wrapped, 3],
      env: { HOME_DIR: `${wrapped}/h`, N: 1 },
      flag: true,
    });
    // A server with neither url nor command is not a server.
    expect(byId["inline@lab"].mcpServers).toEqual({ api: { url: "https://x/mcp" } });
    expect(byId["by-path@lab"].mcpServers).toEqual({ srv: { command: "srv" } });
    expect(byId["absolute@lab"].mcpServers).toEqual({ srv: { command: "srv" } });
    // No settings.json: nothing is on by the user's choice.
    expect(byId["wrapped@lab"].enabledByUser).toBe(false);
  });

  it("tolerates a plugin without manifest, skills or servers, and an id without marketplace", () => {
    const root = join(tmp, "bare");
    mkdirSync(root, { recursive: true });
    writeRegistry({ bare: [{ scope: "user", installPath: root, version: "2.0" }] });
    writeSettings({ bare: true });
    expect(listInstalledPlugins()).toEqual([{
      id: "bare", name: "bare", marketplace: "", version: "2.0", installPath: root, skills: [], mcpServers: {}, enabledByUser: true,
    }]);
  });

  it("sorts plugins by id", () => {
    writeRegistry({
      "zeta@lab": [{ scope: "user", installPath: makePlugin("zeta") }],
      "alpha@lab": [{ scope: "user", installPath: makePlugin("alpha") }],
    });
    expect(listInstalledPlugins().map((p) => p.id)).toEqual(["alpha@lab", "zeta@lab"]);
  });
});

describe("isPluginOn / pluginsOn", () => {
  const plugin = { id: "brain@lab", enabledByUser: false };

  // Same precedence as the enabledPlugins merge in buildClaudeDomainSpawn.
  it("uses the domain's choice, else GLOBAL's, else the user's settings", () => {
    expect(isPluginOn(plugin, undefined, {})).toBe(false);
    expect(isPluginOn({ ...plugin, enabledByUser: true }, undefined, {})).toBe(true);
    expect(isPluginOn(plugin, undefined, { plugins: { "brain@lab": true } })).toBe(true);
    expect(isPluginOn(plugin, { plugins: {} }, { plugins: { "brain@lab": true } })).toBe(true);
    expect(isPluginOn(plugin, { plugins: { "brain@lab": false } }, { plugins: { "brain@lab": true } })).toBe(false);
    expect(isPluginOn(plugin, { plugins: { "brain@lab": true } }, {})).toBe(true);
  });

  it("filters the installed plugins a domain has on", () => {
    const a = { ...plugin, id: "a@lab", name: "a", marketplace: "lab", installPath: "/a", skills: [], mcpServers: {} };
    const b = { ...a, id: "b@lab", enabledByUser: true };
    expect(pluginsOn({ plugins: { "a@lab": true } }, {}, [a, b]).map((p) => p.id)).toEqual(["a@lab", "b@lab"]);
    expect(pluginsOn({ plugins: { "b@lab": false } }, {}, [a, b])).toEqual([]);
    // Default list: what is installed (nothing here).
    expect(pluginsOn(undefined, {})).toEqual([]);
  });
});
