import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a domain injects into each spawn, for Claude (flags, env, settings,
 * generated files) and Codex (generated AGENTS.md, config.toml servers,
 * linked skills, skill toggles). All in temp dirs: COMPANION_HOME is mocked,
 * domains live under COMPANION_DOMAINS_ROOT, Claude's config under
 * CLAUDE_CONFIG_DIR.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { createDomain, domainDir, ensureGlobalDomain, updateDomain, GLOBAL_DOMAIN } from "./domain-store.js";
import {
  buildClaudeDomainSpawn,
  buildCodexAgentsMd,
  codexDomainMcp,
  codexMcpTable,
  codexSkillToggles,
  disabledSkillGroups,
  domainMcpView,
  domainRuntimeDir,
  effectiveMcpServers,
  linkCodexSkills,
  mcpTargetOf,
  mcpTypeOf,
  prepareCodexDomainHome,
  removeDomainRuntime,
  resolveDomain,
} from "./domain-runtime.js";
import { listSkillGroups } from "./skill-groups.js";
import { rewriteCodexMcpServers } from "./companion-mcp-config.js";

let tmp: string;
const savedEnv = { root: process.env.COMPANION_DOMAINS_ROOT, claude: process.env.CLAUDE_CONFIG_DIR };

function writeMcp(slug: string, servers: Record<string, unknown>) {
  writeFileSync(join(domainDir(slug), "mcp.json"), JSON.stringify({ mcpServers: servers }));
}
function addSkill(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "domain-runtime-")));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  ensureGlobalDomain();
  createDomain({ name: "Herd" });
});

afterEach(() => {
  for (const [k, v] of [["COMPANION_DOMAINS_ROOT", savedEnv.root], ["CLAUDE_CONFIG_DIR", savedEnv.claude]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveDomain", () => {
  it("resolves a domain and GLOBAL with their folders", () => {
    const r = resolveDomain("herd");
    expect(r.isGlobal).toBe(false);
    expect(r.dir).toBe(domainDir("herd"));
    expect(r.globalDir).toBe(domainDir(GLOBAL_DOMAIN));
    expect(r.memoryDir).toBe(join(domainDir("herd"), "memory"));
    expect(resolveDomain(undefined).isGlobal).toBe(true);
  });

  // A session whose domain vanished from the registry must still start.
  it("falls back to GLOBAL for an unknown domain", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDomain("gone").domain.slug).toBe(GLOBAL_DOMAIN);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // Folders deleted by hand are recreated at the next spawn.
  it("recreates a missing domain folder layout", () => {
    rmSync(domainDir("herd"), { recursive: true });
    resolveDomain("herd");
    expect(existsSync(join(domainDir("herd"), "memory", "MEMORY.md"))).toBe(true);
  });
});

describe("MCP servers", () => {
  beforeEach(() => {
    writeMcp(GLOBAL_DOMAIN, { gh: { command: "gh-mcp" }, noisy: { command: "n" }, shared: { command: "global-version" } });
    writeMcp("herd", { ping: { command: "node", args: ["ping.js"] }, shared: { command: "herd-version" } });
    updateDomain(GLOBAL_DOMAIN, { mcpDisabled: ["noisy"] });
    updateDomain("herd", { mcpDisabled: ["gh"] });
  });

  // GLOBAL's servers minus GLOBAL's switched-off ones, the domain's own on
  // top (same name: domain wins), minus the domain's switched-off ones.
  it("merges GLOBAL and domain servers with the toggles", () => {
    expect(effectiveMcpServers(resolveDomain("herd"))).toEqual({
      shared: { command: "herd-version" },
      ping: { command: "node", args: ["ping.js"] },
    });
    expect(effectiveMcpServers(resolveDomain(GLOBAL_DOMAIN))).toEqual({
      gh: { command: "gh-mcp" },
      shared: { command: "global-version" },
    });
  });

  it("lists every server with its source and state for the Domains page", () => {
    expect(domainMcpView(resolveDomain("herd"))).toEqual([
      { name: "gh", source: "global", enabled: false, type: "stdio", target: "gh-mcp" },
      { name: "noisy", source: "global", enabled: false, disabledGlobally: true, type: "stdio", target: "n" },
      { name: "ping", source: "domain", enabled: true, type: "stdio", target: "node ping.js" },
      { name: "shared", source: "domain", enabled: true, type: "stdio", target: "herd-version" },
    ]);
    expect(domainMcpView(resolveDomain(GLOBAL_DOMAIN)).find((s) => s.name === "noisy")).toEqual({
      name: "noisy", source: "global", enabled: false, type: "stdio", target: "n",
    });
  });

  it("converts servers to Codex config.toml tables", () => {
    expect(codexMcpTable("ping", { command: "node", args: ["a b"], env: { K: "v" }, cwd: "/w" }, "herd")).toEqual([
      "# Managed by Companion: MCP server of domain herd. Rewritten at every launch.",
      "[mcp_servers.ping]",
      'command = "node"',
      'args = ["a b"]',
      'env = { K = "v" }',
      'cwd = "/w"',
    ]);
    expect(codexMcpTable("web", { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }, "herd")).toEqual([
      "# Managed by Companion: MCP server of domain herd. Rewritten at every launch.",
      "[mcp_servers.web]",
      'url = "https://x/mcp"',
      'http_headers = { Authorization = "Bearer t" }',
    ]);
    expect(codexMcpTable("x", {}, "herd")).toBeNull();
  });

  // Codex finds servers again by their TOML key, so names that would not
  // survive the round trip are skipped (with a warning) rather than written.
  it("skips server names Codex config cannot round-trip", () => {
    writeMcp("herd", { "bad.name": { command: "x" }, ok: { command: "y" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mcp = codexDomainMcp(join(tmp, "codex"), resolveDomain("herd"));
    expect(mcp.names).toEqual(["shared", "ok"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("Claude spawn", () => {
  it("injects GLOBAL and domain plugin dirs, add-dirs, memory and the GLOBAL memory prompt", () => {
    writeFileSync(join(domainDir(GLOBAL_DOMAIN), "memory", "MEMORY.md"), "- [Marco](user-marco.md) — who Marco is\n");
    writeMcp("herd", { ping: { command: "node", args: ["ping.js"], env: { TOKEN: "s3cret" } } });
    const spawn = buildClaudeDomainSpawn("sess-1", "herd");
    const runtime = domainRuntimeDir("sess-1");
    expect(spawn.args).toEqual([
      "--plugin-dir", domainDir(GLOBAL_DOMAIN),
      "--plugin-dir", domainDir("herd"),
      "--add-dir", domainDir(GLOBAL_DOMAIN),
      "--add-dir", domainDir("herd"),
      "--mcp-config", join(runtime, "mcp.json"),
      "--append-system-prompt-file", join(runtime, "global-memory.md"),
    ]);
    expect(spawn.env).toEqual({ CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" });
    expect(spawn.settings).toEqual({ autoMemoryDirectory: join(domainDir("herd"), "memory") });
    expect(spawn.chrome).toBe(false);
    // Generated files: private (server env may hold tokens).
    expect(JSON.parse(readFileSync(join(runtime, "mcp.json"), "utf-8"))).toEqual({
      mcpServers: { ping: { command: "node", args: ["ping.js"], env: { TOKEN: "s3cret" } } },
    });
    expect(statSync(join(runtime, "mcp.json")).mode & 0o777).toBe(0o600);
    const prompt = readFileSync(join(runtime, "global-memory.md"), "utf-8");
    expect(prompt).toContain(join(domainDir(GLOBAL_DOMAIN), "memory"));
    expect(prompt).toContain("- [Marco](user-marco.md) — who Marco is");
  });

  // GLOBAL sessions: the auto-memory already is the GLOBAL memory, so no
  // extra prompt; stale generated files from a previous domain are removed.
  it("keeps a GLOBAL session to the GLOBAL folder only", () => {
    writeMcp("herd", { ping: { command: "node" } });
    buildClaudeDomainSpawn("sess-1", "herd");
    const spawn = buildClaudeDomainSpawn("sess-1", GLOBAL_DOMAIN);
    expect(spawn.args).toEqual([
      "--plugin-dir", domainDir(GLOBAL_DOMAIN),
      "--add-dir", domainDir(GLOBAL_DOMAIN),
    ]);
    expect(spawn.settings).toEqual({ autoMemoryDirectory: join(domainDir(GLOBAL_DOMAIN), "memory") });
    expect(existsSync(join(domainRuntimeDir("sess-1"), "mcp.json"))).toBe(false);
    expect(existsSync(join(domainRuntimeDir("sess-1"), "global-memory.md"))).toBe(false);
  });

  it("adds --chrome, enabledPlugins and skillOverrides from the domain", () => {
    addSkill(join(tmp, "claude", "skills"), "foundry-poc");
    updateDomain(GLOBAL_DOMAIN, { plugins: { "a@m": true, "b@m": true } });
    updateDomain("herd", { chrome: true, plugins: { "b@m": false }, skillGroups: { user: false } });
    const spawn = buildClaudeDomainSpawn("sess-1", "herd");
    expect(spawn.chrome).toBe(true);
    expect(spawn.args).toContain("--chrome");
    expect(spawn.settings).toEqual({
      autoMemoryDirectory: join(domainDir("herd"), "memory"),
      enabledPlugins: { "a@m": true, "b@m": false },
      skillOverrides: { "foundry-poc": "off" },
    });
  });

  it("removes a session's generated files", () => {
    buildClaudeDomainSpawn("sess-1", "herd");
    removeDomainRuntime("sess-1");
    expect(existsSync(domainRuntimeDir("sess-1"))).toBe(false);
  });
});

describe("skill groups", () => {
  it("resolves the groups that are off for a domain (domain, then GLOBAL)", () => {
    updateDomain(GLOBAL_DOMAIN, { skillGroups: { design: false } });
    updateDomain("herd", { skillGroups: { "claude-ai": false } });
    expect([...disabledSkillGroups(resolveDomain("herd"))].sort()).toEqual(["claude-ai", "design"]);
    expect([...disabledSkillGroups(resolveDomain(GLOBAL_DOMAIN))]).toEqual(["design"]);
  });

  // Codex turns off the repository design skills it finds by itself with
  // marked [[skills.config]] entries (verified on Codex 0.161).
  it("writes Codex [[skills.config]] entries for toggled groups only", () => {
    const groups = listSkillGroups();
    expect(codexSkillToggles(groups, new Set(["user", "claude-ai"]))).toEqual([]);
    const toggles = codexSkillToggles(groups, new Set(["design"]));
    expect(toggles).toHaveLength(18);
    expect(toggles[0]).toEqual([
      "# Managed by Companion: skill toggle (design). Rewritten at every launch.",
      "[[skills.config]]",
      'name = "adapt"',
      "enabled = false",
    ]);
  });
});

describe("Codex AGENTS.md", () => {
  it("combines the user's AGENTS.md, both CLAUDE.md files and the shared memory instructions", () => {
    const userAgents = join(tmp, "user-AGENTS.md");
    writeFileSync(userAgents, "Reply in Italian.");
    writeFileSync(join(domainDir(GLOBAL_DOMAIN), "CLAUDE.md"), "Global rule.");
    writeFileSync(join(domainDir("herd"), "CLAUDE.md"), "Herd rule.");
    writeFileSync(join(domainDir("herd"), "memory", "MEMORY.md"), "- [Word](word.md) — the secret word\n");
    const md = buildCodexAgentsMd(resolveDomain("herd"), userAgents);
    const order = ["Generated by Companion", "Reply in Italian.", "Global rule.", "Herd rule.", "# Memory"].map((s) => md.indexOf(s));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]))).toBe(true);
    const mem = join(domainDir("herd"), "memory");
    // Same note format as Claude's auto-memory, in the same folder.
    expect(md).toContain(`\`${mem}/<short-kebab-name>.md\``);
    expect(md).toContain("type: <user | feedback | project | reference>");
    expect(md).toContain(`Add one line to \`${mem}/MEMORY.md\``);
    expect(md).toContain("- [Word](word.md) — the secret word");
    expect(md).toContain(`GLOBAL memory index (${join(domainDir(GLOBAL_DOMAIN), "memory")}/MEMORY.md)`);
  });

  it("has no GLOBAL section for a GLOBAL session and tolerates a missing user file", () => {
    const md = buildCodexAgentsMd(resolveDomain(GLOBAL_DOMAIN), join(tmp, "missing.md"));
    expect(md).not.toContain("GLOBAL memory index");
    expect(md).toContain("## Domain memory index");
    expect(md).toContain("(empty)");
  });
});

describe("Codex skills and home", () => {
  it("links user, GLOBAL and domain skills, domain first on a clash, and unlinks stale ones", () => {
    addSkill(join(tmp, "claude", "skills"), "foundry-poc");
    addSkill(join(domainDir(GLOBAL_DOMAIN), "skills"), "g-skill");
    addSkill(join(domainDir(GLOBAL_DOMAIN), "skills"), "both");
    addSkill(join(domainDir("herd"), "skills"), "both");
    const home = join(tmp, "codex");
    mkdirSync(join(home, "skills", "own"), { recursive: true }); // the user's own Codex skill
    symlinkSync("/nowhere", join(home, "skills", "stale"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const linked = linkCodexSkills(home, resolveDomain("herd"), ["stale", "own"]);
    expect(linked.sort()).toEqual(["both", "foundry-poc", "g-skill"]);
    expect(readlinkSync(join(home, "skills", "both"))).toBe(join(domainDir("herd"), "skills", "both"));
    expect(readlinkSync(join(home, "skills", "foundry-poc"))).toBe(join(tmp, "claude", "skills", "foundry-poc"));
    expect(existsSync(join(home, "skills", "stale"))).toBe(false);
    expect(lstatSync(join(home, "skills", "own")).isDirectory()).toBe(true);

    // A clash with the user's own Codex skill keeps theirs.
    addSkill(join(domainDir("herd"), "skills"), "own");
    expect(linkCodexSkills(home, resolveDomain("herd"), linked)).not.toContain("own");
    expect(warn).toHaveBeenCalled();

    // User group off: its links go away at the next spawn.
    updateDomain("herd", { skillGroups: { user: false } });
    expect(linkCodexSkills(home, resolveDomain("herd"), linked)).not.toContain("foundry-poc");
    expect(existsSync(join(home, "skills", "foundry-poc"))).toBe(false);
    warn.mockRestore();
  });

  it("returns nothing to link when there are no skills", () => {
    expect(linkCodexSkills(join(tmp, "codex"), resolveDomain("herd"), [])).toEqual([]);
  });

  it("prepares a CODEX_HOME: generated AGENTS.md over the old link, servers to write, bookkeeping on commit", () => {
    const home = join(tmp, "codex");
    mkdirSync(home, { recursive: true });
    const userAgents = join(tmp, "user-AGENTS.md");
    writeFileSync(userAgents, "User rules.");
    symlinkSync(userAgents, join(home, "AGENTS.md"));
    writeMcp("herd", { ping: { command: "node" } });
    updateDomain("herd", { skillGroups: { design: false } });

    const prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: userAgents });
    expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, "AGENTS.md"), "utf-8")).toContain("User rules.");
    expect(readFileSync(userAgents, "utf-8")).toBe("User rules."); // never written through the link
    expect(prepared.mcp.names).toEqual(["ping"]);
    expect(prepared.mcp.tables).toHaveLength(1 + 18); // the server + the design toggles
    expect(prepared.resolved.memoryDir).toBe(join(domainDir("herd"), "memory"));

    rewriteCodexMcpServers(join(home, "config.toml"), prepared.mcp.remove, prepared.mcp.tables);
    prepared.commit();
    expect(JSON.parse(readFileSync(join(home, ".companion-domain.json"), "utf-8"))).toEqual({ mcpServers: ["ping"], skills: [] });

    // A server switched off later is removed from config.toml at the next spawn.
    updateDomain("herd", { mcpDisabled: ["ping"], skillGroups: { design: true } });
    const next = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: userAgents });
    expect(next.mcp.remove).toEqual(["ping"]);
    rewriteCodexMcpServers(join(home, "config.toml"), next.mcp.remove, next.mcp.tables);
    expect(readFileSync(join(home, "config.toml"), "utf-8")).toBe("");
  });

  it("tolerates a corrupt bookkeeping file", () => {
    const home = join(tmp, "codex");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".companion-domain.json"), "{");
    expect(prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "x") }).mcp.remove).toEqual([]);
  });
});

// Codex has no plugins: a plugin turned on for the domain reaches Codex
// sessions as its MCP servers (config.toml) and its skills (links).
describe("plugins for Codex", () => {
  function installPlugin(id: string, opts: { skills?: string[]; mcp?: Record<string, unknown>; userOn?: boolean } = {}) {
    const name = id.split("@")[0];
    const root = join(tmp, "claude", "plugins", "cache", name);
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    for (const sk of opts.skills ?? []) addSkill(join(root, "skills"), sk);
    if (opts.mcp) writeFileSync(join(root, ".mcp.json"), JSON.stringify(opts.mcp));
    const regPath = join(tmp, "claude", "plugins", "installed_plugins.json");
    const reg = existsSync(regPath) ? JSON.parse(readFileSync(regPath, "utf-8")) : { version: 2, plugins: {} };
    reg.plugins[id] = [{ scope: "user", installPath: root }];
    writeFileSync(regPath, JSON.stringify(reg));
    if (opts.userOn !== undefined) writeFileSync(join(tmp, "claude", "settings.json"), JSON.stringify({ enabledPlugins: { [id]: opts.userOn } }));
    return root;
  }

  it("adds the servers and skills of the domain's plugins, and takes them out when the plugin is turned off", () => {
    const root = installPlugin("brain@lab", { skills: ["brain"], mcp: { brain: { type: "http", url: "http://127.0.0.1:7420/mcp" } }, userOn: false });
    const home = join(tmp, "codex");
    mkdirSync(home, { recursive: true });

    // Off for the user and not chosen by the domain: nothing for Codex.
    let prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "x") });
    expect(prepared.mcp.names).not.toContain("brain");
    prepared.commit();

    updateDomain("herd", { plugins: { "brain@lab": true } });
    prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "x") });
    expect(prepared.mcp.names).toContain("brain");
    const table = prepared.mcp.tables.find((t) => t.includes("[mcp_servers.brain]"));
    expect(table).toEqual([
      "# Managed by Companion: MCP server of domain herd (plugin brain@lab). Rewritten at every launch.",
      "[mcp_servers.brain]",
      'url = "http://127.0.0.1:7420/mcp"',
    ]);
    expect(readlinkSync(join(home, "skills", "brain"))).toBe(join(root, "skills", "brain"));
    prepared.commit();

    // Other domains (and GLOBAL) are not affected by herd's choice.
    expect(codexDomainMcp(join(tmp, "codex2"), resolveDomain(GLOBAL_DOMAIN)).names).not.toContain("brain");

    updateDomain("herd", { plugins: { "brain@lab": false } });
    prepared = prepareCodexDomainHome(home, "herd", { userAgentsMdPath: join(tmp, "x") });
    expect(prepared.mcp.names).not.toContain("brain");
    expect(prepared.mcp.remove).toContain("brain");
    expect(existsSync(join(home, "skills", "brain"))).toBe(false);
  });

  // A server the domain declares itself wins over a plugin's of the same name.
  it("lets the domain's own mcp.json win on a name clash", () => {
    installPlugin("brain@lab", { mcp: { brain: { url: "http://plugin/mcp" } }, userOn: true });
    writeMcp("herd", { brain: { url: "http://domain/mcp" } });
    const mcp = codexDomainMcp(join(tmp, "codex"), resolveDomain("herd"));
    expect(mcp.names.filter((n) => n === "brain")).toHaveLength(1);
    expect(mcp.tables.find((t) => t.includes("[mcp_servers.brain]"))).toContain('url = "http://domain/mcp"');
  });

  it("describes a server by its URL or command, never env or headers", () => {
    expect(mcpTypeOf({ url: "http://x" })).toBe("http");
    expect(mcpTypeOf({ command: "c" })).toBe("stdio");
    expect(mcpTypeOf({ type: "sse", url: "http://x" })).toBe("sse");
    expect(mcpTargetOf({ url: "http://x", headers: { Authorization: "secret" } })).toBe("http://x");
    expect(mcpTargetOf({ command: "npx", args: ["-y", "srv"], env: { TOKEN: "secret" } })).toBe("npx -y srv");
    expect(mcpTargetOf({})).toBe("");
  });
});
