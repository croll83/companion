import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A domain's brain in each spawn, Claude and Codex side by side (parity):
 * same server name `<slug>-brain` and URL, added LAST to the MCP config of
 * both CLIs; Claude gets `--plugin-dir <brain>/plugin` and the token as a
 * literal header in its 0600 config, Codex a linked skill, a line in
 * AGENTS.md, `bearer_token_env_var` and the token in the process env only.
 * A plugin serving the same URL is forced off (Claude) / skipped (Codex).
 * Temp dirs only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { createDomain, domainDir, ensureGlobalDomain, updateDomain, GLOBAL_DOMAIN } from "./domain-store.js";
import { buildClaudeDomainSpawn, domainRuntimeDir, prepareCodexDomainHome } from "./domain-runtime.js";
import { createRemoteBrain, brainPluginDir, brainSkillDir } from "./brain/brain-store.js";

let tmp: string;
const savedEnv = { root: process.env.COMPANION_DOMAINS_ROOT, claude: process.env.CLAUDE_CONFIG_DIR };

function writeMcp(slug: string, servers: Record<string, unknown>) {
  writeFileSync(join(domainDir(slug), "mcp.json"), JSON.stringify({ mcpServers: servers }));
}

function installPlugin(id: string, url: string, skill: string) {
  const root = join(tmp, "plugins", id);
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "skills", skill), { recursive: true });
  writeFileSync(join(root, "skills", skill, "SKILL.md"), `---\nname: ${skill}\ndescription: x\n---\n`);
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: id.split("@")[0] }));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ [skill]: { type: "http", url } }));
  mkdirSync(join(tmp, "claude", "plugins"), { recursive: true });
  writeFileSync(join(tmp, "claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { [id]: [{ scope: "user", installPath: root }] } }));
  writeFileSync(join(tmp, "claude", "settings.json"), JSON.stringify({ enabledPlugins: { [id]: true } }));
}

function claudeServers(sessionId: string): Record<string, { url?: string; headers?: Record<string, string> }> {
  return JSON.parse(readFileSync(join(domainRuntimeDir(sessionId), "mcp.json"), "utf-8")).mcpServers;
}

function codexHome(): string {
  const home = join(tmp, "codex");
  mkdirSync(home, { recursive: true });
  return home;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "domain-runtime-brain-")));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  ensureGlobalDomain();
  createDomain({ name: "Herd" });
  createRemoteBrain({ name: "Jarvis", about: "Infra wiki", baseUrl: "http://100.116.99.9:7421" });
  createRemoteBrain({ name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "tok-xyz" });
});

afterEach(() => {
  for (const [k, v] of [["COMPANION_DOMAINS_ROOT", savedEnv.root], ["CLAUDE_CONFIG_DIR", savedEnv.claude]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("no brain", () => {
  // Off by default: a brain that exists but is assigned nowhere changes nothing.
  it("adds nothing to either CLI", () => {
    const claude = buildClaudeDomainSpawn("s1", "herd");
    expect(claude.args.filter((a) => a.includes("brains"))).toEqual([]);
    expect(claude.args).not.toContain("--mcp-config");
    const prepared = prepareCodexDomainHome(codexHome(), "herd", { userAgentsMdPath: join(tmp, "none") });
    expect(prepared.mcp.names).toEqual([]);
    expect(prepared.env).toEqual({});
    expect(readFileSync(join(tmp, "codex", "AGENTS.md"), "utf-8")).not.toContain("# Brain");
  });
});

describe("Claude", () => {
  it("adds the brain's server last and its plugin dir", () => {
    writeMcp(GLOBAL_DOMAIN, { gh: { command: "gh" } });
    writeMcp("herd", { ping: { type: "http", url: "http://ping" }, "jarvis-brain": { command: "stale-local-copy" } });
    updateDomain("herd", { brain: "jarvis" });
    const spawn = buildClaudeDomainSpawn("s1", "herd");
    const servers = claudeServers("s1");
    // Last, and it replaces a namesake from mcp.json.
    expect(Object.keys(servers)).toEqual(["gh", "ping", "jarvis-brain"]);
    expect(servers["jarvis-brain"]).toEqual({ type: "http", url: "http://100.116.99.9:7421/mcp" });
    const dirs = spawn.args.flatMap((a, i) => (a === "--plugin-dir" ? [spawn.args[i + 1]] : []));
    expect(dirs).toEqual([domainDir(GLOBAL_DOMAIN), domainDir("herd"), brainPluginDir("jarvis")]);
    expect(existsSync(join(brainSkillDir("jarvis"), "SKILL.md"))).toBe(true);
  });

  // The token is a literal header in the per-session config (0600).
  it("writes the bearer token as a header in the private MCP config", () => {
    updateDomain("global", { brain: "team" });
    buildClaudeDomainSpawn("s2", "herd");
    expect(claudeServers("s2")["team-brain"]).toEqual({ type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer tok-xyz" } });
  });

  // The brain wins over a plugin serving the same URL: no tool twice.
  it("forces a colliding plugin off", () => {
    installPlugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp", "jarvis-brain");
    updateDomain("herd", { brain: "jarvis", plugins: { "jarvis-brain@jarvis-lab": true } });
    expect(buildClaudeDomainSpawn("s3", "herd").settings.enabledPlugins).toEqual({ "jarvis-brain@jarvis-lab": false });
    // Without the brain, the domain's choice stands.
    updateDomain("herd", { brain: null });
    expect(buildClaudeDomainSpawn("s3", "herd").settings.enabledPlugins).toEqual({ "jarvis-brain@jarvis-lab": true });
  });
});

describe("Codex", () => {
  it("adds the server last, links the skill and names the brain in AGENTS.md", () => {
    writeMcp("herd", { ping: { type: "http", url: "http://ping" } });
    updateDomain("herd", { brain: "jarvis" });
    const home = codexHome();
    const prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "none") });
    expect(prepared.mcp.names).toEqual(["ping", "jarvis-brain"]);
    expect(prepared.mcp.tables.at(-1)).toEqual([
      "# Managed by Companion: MCP server of domain herd (brain jarvis). Rewritten at every launch.",
      "[mcp_servers.jarvis-brain]",
      'url = "http://100.116.99.9:7421/mcp"',
    ]);
    expect(readlinkSync(join(home, "skills", "jarvis-brain"))).toBe(brainSkillDir("jarvis"));
    expect(readFileSync(join(home, "AGENTS.md"), "utf-8")).toContain(
      "This domain's knowledge base is the brain Jarvis: use its `jarvis-brain` MCP tools; see the jarvis-brain skill.",
    );
    expect(prepared.env).toEqual({});
  });

  // CODEX_HOME is not private (0775): config.toml names a variable, the
  // token goes in the process env only.
  it("puts the token in the env, never in config.toml", () => {
    updateDomain("herd", { brain: "team" });
    const prepared = prepareCodexDomainHome(codexHome(), "herd", { userAgentsMdPath: join(tmp, "none") });
    const table = prepared.mcp.tables.find((t) => t.includes("[mcp_servers.team-brain]"))!;
    expect(table).toContain('bearer_token_env_var = "COMPANION_BRAIN_TEAM_TOKEN"');
    expect(JSON.stringify(prepared.mcp.tables)).not.toContain("tok-xyz");
    expect(prepared.env).toEqual({ COMPANION_BRAIN_TEAM_TOKEN: "tok-xyz" });
  });

  // The brain wins: the colliding plugin's server and skill are skipped,
  // and the brain's own skill takes the name.
  it("skips a colliding plugin's server and skill", () => {
    installPlugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp", "jarvis-brain");
    updateDomain("herd", { brain: "jarvis" });
    const home = codexHome();
    const prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "none") });
    expect(prepared.mcp.names).toEqual(["jarvis-brain"]);
    expect(prepared.mcp.tables.join("\n")).not.toContain("plugin jarvis-brain@jarvis-lab");
    expect(readlinkSync(join(home, "skills", "jarvis-brain"))).toBe(brainSkillDir("jarvis"));
    // Without the brain the plugin is back.
    updateDomain("herd", { brain: null });
    prepared.commit();
    const again = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "none") });
    expect(again.mcp.tables.join("\n")).toContain("plugin jarvis-brain@jarvis-lab");
    expect(readlinkSync(join(home, "skills", "jarvis-brain"))).toBe(join(tmp, "plugins", "jarvis-brain@jarvis-lab", "skills", "jarvis-brain"));
  });
});

describe("parity", () => {
  // Same name, same URL, same position (last) for both CLIs.
  it("gives both CLIs the same brain server", () => {
    writeMcp("herd", { a: { type: "http", url: "http://a" }, z: { type: "http", url: "http://z" } });
    updateDomain("herd", { brain: "team" });
    buildClaudeDomainSpawn("p1", "herd");
    const claude = claudeServers("p1");
    const codex = prepareCodexDomainHome(codexHome(), "herd", { userAgentsMdPath: join(tmp, "none") }).mcp;
    expect(Object.keys(claude)).toEqual(codex.names);
    expect(claude["team-brain"].url).toBe("https://team.example/mcp");
    expect(codex.tables.at(-1)).toContain('url = "https://team.example/mcp"');
  });
});
