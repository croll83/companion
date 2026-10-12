import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { pluginsOn, type InstalledPlugin } from "./claude-plugins.js";
import { cachedAccountMcpServers, type AccountMcpServer } from "./account-mcp.js";
import { ensurePrivateDir, writePrivateFile } from "./private-file.js";
import {
  GLOBAL_DOMAIN,
  domainDir,
  domainMemoryDir,
  ensureDomainLayout,
  ensureGlobalDomain,
  getDomain,
  listDomainSkills,
  readDomainMcp,
  readMemoryIndex,
  type DomainInfo,
  type McpServerDef,
} from "./domain-store.js";
import { SKILL_TOGGLE_MARKER, tomlInlineTable, tomlKey, tomlString } from "./companion-mcp-config.js";
import {
  claudeSkillOverrides,
  isSkillGroupOn,
  listSkillGroups,
  userSkillDirs,
  type SkillGroup,
  type SkillGroupId,
} from "./skill-groups.js";

/**
 * What a domain injects into every spawn and relaunch of a (non-legacy)
 * session, for both CLIs, so the Claude and Codex sessions of a domain see
 * the same instructions, memory, skills and MCP servers.
 *
 * Claude Code (flags verified on CLI 2.1.293):
 *  - `--plugin-dir <global>` `--plugin-dir <domain>`: skills, commands, agents,
 *  - `--add-dir <global>` `--add-dir <domain>` + CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1:
 *    the CLAUDE.md of both, also for a session attached to a folder outside the domain,
 *  - `--mcp-config <generated>`: global + domain mcp.json minus the servers
 *    turned off for the domain,
 *  - `--settings {autoMemoryDirectory: <domain>/memory, enabledPlugins,
 *    deniedMcpServers}`: the marketplace plugins turned on/off for the domain
 *    (claude-plugins.ts), and the servers it turns off by name, including the
 *    ones the CLI loads by itself (account-mcp.ts),
 *  - `--append-system-prompt-file <generated>`: where the GLOBAL memory is and
 *    its index (an `@import` in an add-dir CLAUDE.md is not resolved),
 *  - `--chrome` when the domain turns Claude in Chrome on.
 *
 * Codex (its own CODEX_HOME per session):
 *  - a generated AGENTS.md: the user's ~/.codex/AGENTS.md, the GLOBAL and
 *    domain CLAUDE.md, and a Memory section (both MEMORY.md indexes, and how
 *    to save notes in the format Claude's auto-memory uses, in the same
 *    folder, so both CLIs share one memory),
 *  - the same MCP servers as `[mcp_servers.*]` tables in config.toml, plus
 *    those of the domain's plugins,
 *  - the GLOBAL, domain and plugin skills linked into CODEX_HOME/skills.
 *  Codex has no equivalent of plugin commands/agents or of `--chrome`: those
 *  stay Claude-only (the UI says so).
 *
 * Generated files are rewritten at every spawn, under
 * COMPANION_HOME/domain-runtime/<sessionId>/ for Claude.
 */

export interface ResolvedDomain {
  domain: DomainInfo;
  global: DomainInfo;
  isGlobal: boolean;
  dir: string;
  globalDir: string;
  memoryDir: string;
  globalMemoryDir: string;
}

/**
 * The domain a session spawns with, its folders created if missing. A slug
 * that is no longer registered falls back to GLOBAL (deleting a domain in use
 * is refused, so this only happens after a hand-edited registry).
 */
export function resolveDomain(slug: string | undefined): ResolvedDomain {
  const global = ensureGlobalDomain();
  let domain = slug && slug !== GLOBAL_DOMAIN ? getDomain(slug) : global;
  if (!domain) {
    console.warn(`[domain-runtime] Unknown domain "${slug}", using GLOBAL`);
    domain = global;
  }
  ensureDomainLayout(domain);
  return {
    domain,
    global,
    isGlobal: domain.slug === GLOBAL_DOMAIN,
    dir: domainDir(domain.slug),
    globalDir: domainDir(GLOBAL_DOMAIN),
    memoryDir: domainMemoryDir(domain.slug),
    globalMemoryDir: domainMemoryDir(GLOBAL_DOMAIN),
  };
}

// ── MCP servers ─────────────────────────────────────────────────────────────

export interface DomainMcpServerView {
  name: string;
  /**
   * Where it is declared: the GLOBAL mcp.json, this domain's own, or the
   * user's Claude config / claude.ai account ("account", Claude-only).
   */
  source: "global" | "domain" | "account";
  /** Whether sessions of this domain get it. */
  enabled: boolean;
  /** Turned off in the GLOBAL domain itself (so off everywhere). */
  disabledGlobally?: boolean;
  type: string;
  /** The URL, or the command and its args (never env or headers: they may hold tokens). */
  target: string;
  /** Account servers: health from the last `claude mcp list`. */
  health?: string;
}

/**
 * The MCP servers a session of `r.domain` gets: GLOBAL's (minus the ones
 * GLOBAL turns off), then the domain's own (same name: the domain wins), minus
 * the ones the domain turns off.
 */
export function effectiveMcpServers(r: ResolvedDomain): Record<string, McpServerDef> {
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(readDomainMcp(GLOBAL_DOMAIN).servers)) {
    if (!r.global.mcpDisabled.includes(name)) out[name] = def;
  }
  if (!r.isGlobal) {
    for (const [name, def] of Object.entries(readDomainMcp(r.domain.slug).servers)) out[name] = def;
    for (const name of r.domain.mcpDisabled) delete out[name];
  }
  return out;
}

/** A server's transport as the Domains page shows it. */
export function mcpTypeOf(def: McpServerDef): string {
  return def.type || (def.url ? "http" : "stdio");
}

/** A server's URL, or its command and args (never env or headers: they may hold tokens). */
export function mcpTargetOf(def: McpServerDef): string {
  return def.url ?? [def.command ?? "", ...(def.args ?? [])].join(" ").trim();
}

/**
 * What the Domains page lists for a domain: every server it could get, with
 * its toggle state. Account servers (account-mcp.ts) come last, unless a
 * mcp.json declares the same name.
 */
export function domainMcpView(r: ResolvedDomain, account: AccountMcpServer[] = cachedAccountMcpServers().servers): DomainMcpServerView[] {
  const view = new Map<string, DomainMcpServerView>();
  const typeOf = mcpTypeOf;
  const targetOf = mcpTargetOf;
  for (const [name, def] of Object.entries(readDomainMcp(GLOBAL_DOMAIN).servers)) {
    const off = r.global.mcpDisabled.includes(name);
    view.set(name, {
      name,
      source: "global",
      enabled: !off && (r.isGlobal || !r.domain.mcpDisabled.includes(name)),
      ...(off && !r.isGlobal ? { disabledGlobally: true } : {}),
      type: typeOf(def),
      target: targetOf(def),
    });
  }
  if (!r.isGlobal) {
    for (const [name, def] of Object.entries(readDomainMcp(r.domain.slug).servers)) {
      view.set(name, { name, source: "domain", enabled: !r.domain.mcpDisabled.includes(name), type: typeOf(def), target: targetOf(def) });
    }
  }
  for (const a of account) {
    if (view.has(a.name)) continue;
    const off = r.global.mcpDisabled.includes(a.name);
    view.set(a.name, {
      name: a.name,
      source: "account",
      enabled: !off && (r.isGlobal || !r.domain.mcpDisabled.includes(a.name)),
      ...(off && !r.isGlobal ? { disabledGlobally: true } : {}),
      type: a.connector ? "claude.ai" : (/^https?:/.test(a.target) ? "http" : "stdio"),
      target: a.target,
      health: a.health,
    });
  }
  return [...view.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Skill groups ────────────────────────────────────────────────────────────

/** The skill groups (skill-groups.ts) turned off for sessions of `r.domain`. */
export function disabledSkillGroups(r: ResolvedDomain, groups: SkillGroup[] = listSkillGroups()): Set<SkillGroupId> {
  const off = new Set<SkillGroupId>();
  for (const g of groups) {
    if (!isSkillGroupOn(g.id, r.isGlobal ? undefined : r.domain, r.global)) off.add(g.id);
  }
  return off;
}

// ── Claude ──────────────────────────────────────────────────────────────────

export interface ClaudeDomainSpawn {
  args: string[];
  env: Record<string, string>;
  /** Merged into the spawn's single `--settings` JSON. */
  settings: Record<string, unknown>;
  /** The domain turns Claude in Chrome on (`--chrome` is in args). */
  chrome: boolean;
  /** Which browser to drive when chrome is on: "local" or a deviceId (see chrome-browser.ts). */
  chromeBrowser: string;
}

export function domainRuntimeDir(sessionId: string): string {
  return join(COMPANION_HOME, "domain-runtime", sessionId);
}

/** Remove a session's generated files (session deleted). */
export function removeDomainRuntime(sessionId: string): void {
  try {
    rmSync(domainRuntimeDir(sessionId), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function globalMemoryPrompt(r: ResolvedDomain): string {
  const index = readMemoryIndex(r.globalMemoryDir).trim();
  return [
    "# Companion GLOBAL memory",
    "",
    `This session belongs to the Companion domain "${r.domain.name}". Your auto-memory is the domain's memory (${r.memoryDir}).`,
    `There is also a GLOBAL memory shared by every session, in ${r.globalMemoryDir}. Its index (MEMORY.md) follows;`,
    "read a note file from that folder when it is relevant. Save facts about this domain in your auto-memory as usual;",
    "save a fact in the GLOBAL memory (same format: one file per fact plus one index line in its MEMORY.md) only when it applies to every project.",
    "",
    "## GLOBAL memory index",
    "",
    index || "(empty)",
    "",
  ].join("\n");
}

/**
 * Flags, env and settings for a Claude spawn in a domain. Rewrites the
 * session's generated files (MCP config, GLOBAL memory prompt).
 */
export function buildClaudeDomainSpawn(sessionId: string, slug: string | undefined): ClaudeDomainSpawn {
  const r = resolveDomain(slug);
  const runtime = domainRuntimeDir(sessionId);
  ensurePrivateDir(runtime);

  const args: string[] = ["--plugin-dir", r.globalDir];
  if (!r.isGlobal) args.push("--plugin-dir", r.dir);
  // One directory per flag: --add-dir is variadic.
  args.push("--add-dir", r.globalDir);
  if (!r.isGlobal) args.push("--add-dir", r.dir);

  const mcpPath = join(runtime, "mcp.json");
  const servers = effectiveMcpServers(r);
  if (Object.keys(servers).length > 0) {
    // 0600: server env may hold tokens.
    writePrivateFile(mcpPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    args.push("--mcp-config", mcpPath);
  } else {
    rmSync(mcpPath, { force: true });
  }

  const promptPath = join(runtime, "global-memory.md");
  if (!r.isGlobal) {
    writePrivateFile(promptPath, globalMemoryPrompt(r));
    args.push("--append-system-prompt-file", promptPath);
  } else {
    rmSync(promptPath, { force: true });
  }

  const chrome = r.domain.chrome === true;
  if (chrome) args.push("--chrome");
  const chromeBrowser = r.domain.chromeBrowser || "local";

  const plugins = { ...(r.global.plugins ?? {}), ...(r.isGlobal ? {} : r.domain.plugins ?? {}) };
  const settings: Record<string, unknown> = { autoMemoryDirectory: r.memoryDir };
  if (Object.keys(plugins).length > 0) settings.enabledPlugins = plugins;
  // Servers the CLI loads by itself (the user's own, claude.ai connectors)
  // are turned off by name; a name from a mcp.json is already left out of
  // --mcp-config, denying it too is harmless. Companion's own server never.
  const denied = [...new Set([...r.global.mcpDisabled, ...(r.isGlobal ? [] : r.domain.mcpDisabled)])].filter((n) => n !== "companion");
  if (denied.length > 0) settings.deniedMcpServers = denied.map((serverName) => ({ serverName }));
  const groups = listSkillGroups();
  const skillOverrides = claudeSkillOverrides(disabledSkillGroups(r, groups), groups);
  if (Object.keys(skillOverrides).length > 0) settings.skillOverrides = skillOverrides;

  return { args, env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }, settings, chrome, chromeBrowser };
}

// ── Codex ───────────────────────────────────────────────────────────────────

/** Bookkeeping of what Companion put in a session's CODEX_HOME, so a removed item is taken out again. */
const CODEX_STATE_FILE = ".companion-domain.json";

interface CodexDomainState {
  mcpServers: string[];
  skills: string[];
}

function readCodexState(codexHome: string): CodexDomainState {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome, CODEX_STATE_FILE), "utf-8")) as Partial<CodexDomainState>;
    return {
      mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers.filter((s) => typeof s === "string") : [],
      skills: Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return { mcpServers: [], skills: [] };
  }
}

/** Codex MCP server names must survive the TOML key round trip used to find them again. */
function isSafeServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** One mcp.json server as a Codex `[mcp_servers.<name>]` block, or null when Codex cannot express it. */
export function codexMcpTable(name: string, def: McpServerDef, slug: string, plugin?: string): string[] | null {
  const lines = [
    `# Managed by Companion: MCP server of domain ${slug}${plugin ? ` (plugin ${plugin})` : ""}. Rewritten at every launch.`,
    `[mcp_servers.${tomlKey(name)}]`,
  ];
  if (def.url) {
    lines.push(`url = ${tomlString(def.url)}`);
    lines.push(...codexHttpAuth(def));
    // A pre-registered OAuth client (Entra-style, no dynamic registration).
    // Codex picks its own callback port: providers like Entra ignore the port
    // of a loopback redirect, and Codex's port is one setting for all servers.
    const clientId = def.oauth?.clientId;
    if (typeof clientId === "string" && clientId) {
      lines.push("", `[mcp_servers.${tomlKey(name)}.oauth]`, `client_id = ${tomlString(clientId)}`);
    }
  } else if (def.command) {
    lines.push(`command = ${tomlString(def.command)}`);
    if (def.args?.length) lines.push(`args = [${def.args.map((a) => tomlString(String(a))).join(", ")}]`);
    if (def.env && Object.keys(def.env).length > 0) lines.push(`env = ${tomlInlineTable(def.env)}`);
    if (def.cwd) lines.push(`cwd = ${tomlString(def.cwd)}`);
  } else {
    return null;
  }
  return lines;
}

/**
 * HTTP headers in Codex form. Claude expands `${VAR}` in headers, Codex does
 * not: `Authorization: Bearer ${VAR}` becomes `bearer_token_env_var`, a
 * header that is exactly `${VAR}` becomes `env_http_headers` (Codex reads the
 * variable), anything else stays a literal `http_headers` value.
 */
function codexHttpAuth(def: McpServerDef): string[] {
  const literal: Record<string, string> = {};
  const fromEnv: Record<string, string> = {};
  let bearer: string | undefined;
  for (const [header, value] of Object.entries(def.headers ?? {})) {
    const b = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    const v = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (b && header.toLowerCase() === "authorization" && !bearer) bearer = b[1];
    else if (v) fromEnv[header] = v[1];
    else literal[header] = value;
  }
  const out: string[] = [];
  if (bearer) out.push(`bearer_token_env_var = ${tomlString(bearer)}`);
  if (Object.keys(fromEnv).length > 0) out.push(`env_http_headers = ${tomlInlineTable(fromEnv)}`);
  if (Object.keys(literal).length > 0) out.push(`http_headers = ${tomlInlineTable(literal)}`);
  return out;
}

export interface CodexDomainMcp {
  /** Server names to strip from config.toml (previously managed + the ones written now). */
  remove: string[];
  tables: string[][];
  names: string[];
}

/** The plugins turned on for sessions of `r.domain` (see claude-plugins.ts). */
export function domainPlugins(r: ResolvedDomain): InstalledPlugin[] {
  return pluginsOn(r.isGlobal ? undefined : r.domain, r.global);
}

/**
 * The domain's MCP servers as config.toml tables, plus what to remove first.
 * Servers of the domain's plugins come too (Codex has no plugins); a server
 * of mcp.json with the same name wins.
 */
export function codexDomainMcp(codexHome: string, r: ResolvedDomain, plugins: InstalledPlugin[] = domainPlugins(r)): CodexDomainMcp {
  const previous = readCodexState(codexHome).mcpServers;
  const tables: string[][] = [];
  const names: string[] = [];
  const add = (name: string, def: McpServerDef, plugin?: string) => {
    if (names.includes(name)) return;
    if (!isSafeServerName(name)) {
      console.warn(`[domain-runtime] MCP server "${name}" skipped for Codex: use letters, digits, "-" or "_" in its name`);
      return;
    }
    const table = codexMcpTable(name, def, r.domain.slug, plugin);
    if (!table) return;
    tables.push(table);
    names.push(name);
  };
  for (const [name, def] of Object.entries(effectiveMcpServers(r))) add(name, def);
  for (const p of plugins) for (const [name, def] of Object.entries(p.mcpServers)) add(name, def, p.id);
  return { remove: [...new Set([...previous, ...names])], tables, names };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** The generated AGENTS.md of a Codex session in a domain. */
export function buildCodexAgentsMd(r: ResolvedDomain, userAgentsMdPath: string): string {
  const parts: string[] = [
    `<!-- Generated by Companion at every launch of this session (domain "${r.domain.slug}"). Edits here are lost: edit the source files named below. -->`,
    "",
  ];
  const user = readOptional(userAgentsMdPath);
  if (user) parts.push(`<!-- Source: ${userAgentsMdPath} -->`, user, "");

  const globalMd = readOptional(join(r.globalDir, "CLAUDE.md"));
  if (globalMd) parts.push(`<!-- Source: ${join(r.globalDir, "CLAUDE.md")} (Companion GLOBAL domain) -->`, globalMd, "");
  if (!r.isGlobal) {
    const domainMd = readOptional(join(r.dir, "CLAUDE.md"));
    if (domainMd) parts.push(`<!-- Source: ${join(r.dir, "CLAUDE.md")} (Companion domain "${r.domain.name}") -->`, domainMd, "");
  }

  const mem = r.memoryDir;
  parts.push(
    "# Memory (shared with the Claude Code sessions of this domain)",
    "",
    `You have a persistent, file-based memory shared by every Claude Code and Codex session of the Companion domain "${r.domain.name}".`,
    "Claude Code sessions read and write the same folder as their auto-memory, so follow this format exactly.",
    "",
    `- Domain memory: ${mem}/ (index: ${mem}/MEMORY.md)`,
    ...(r.isGlobal ? [] : [`- GLOBAL memory, shared by all sessions: ${r.globalMemoryDir}/ (index: ${r.globalMemoryDir}/MEMORY.md)`]),
    "",
    "The indexes are below. Before answering a question a note covers, read that note file.",
    "",
    "When you learn a durable fact worth keeping for later sessions (the user asks you to remember something, a preference or a",
    "correction from the user, a project decision, where something lives), save it in the domain memory right away:",
    `1. Write one file per fact, \`${mem}/<short-kebab-name>.md\`:`,
    "   ```",
    "   ---",
    "   name: <short-kebab-name>",
    "   description: <one line: what the fact is, used later to judge relevance>",
    "   metadata:",
    "     type: <user | feedback | project | reference>",
    "   ---",
    "   <the fact. For feedback and project facts add a \"**Why:**\" line and a \"**How to apply:**\" line.>",
    "   ```",
    `2. Add one line to \`${mem}/MEMORY.md\`: \`- [<Title>](<short-kebab-name>.md) — <one-line hook>\`. MEMORY.md is only an index: never write the fact itself there.`,
    "3. Update an existing note instead of adding a duplicate; delete a note that turned out wrong, with its index line.",
    ...(r.isGlobal ? [] : ["Save in the GLOBAL memory (same format) only facts that apply to every project."]),
    "Never save secrets (tokens, passwords, keys).",
    "",
    `## Domain memory index (${mem}/MEMORY.md)`,
    "",
    readMemoryIndex(mem).trim() || "(empty)",
    "",
  );
  if (!r.isGlobal) {
    parts.push(
      `## GLOBAL memory index (${r.globalMemoryDir}/MEMORY.md)`,
      "",
      readMemoryIndex(r.globalMemoryDir).trim() || "(empty)",
      "",
    );
  }
  return parts.join("\n");
}

/**
 * Link the user's skills (group "user" on), the GLOBAL and the domain skills into CODEX_HOME/skills (a link per skill
 * folder; Codex 0.161 follows them, verified with skills/list). The domain
 * wins over GLOBAL on a name clash; a real folder already there (a skill of
 * the user's own ~/.codex) is never replaced. Links Companion made earlier
 * that are no longer wanted are removed.
 */
export function linkCodexSkills(
  codexHome: string,
  r: ResolvedDomain,
  previous: string[],
  off: ReadonlySet<SkillGroupId> = disabledSkillGroups(r),
  plugins: InstalledPlugin[] = domainPlugins(r),
): string[] {
  const skillsDir = join(codexHome, "skills");
  const wanted = new Map<string, string>();
  // The user's ~/.claude/skills, which Codex never reads by itself: linked
  // while their group is on, so Codex sessions get what Claude sessions get.
  if (!off.has("user")) for (const [name, dir] of userSkillDirs()) wanted.set(name, dir);
  // The skills of the domain's plugins (Claude gets them through the plugin).
  for (const p of plugins) for (const name of p.skills) wanted.set(name, join(p.installPath, "skills", name));
  for (const name of listDomainSkills(GLOBAL_DOMAIN)) wanted.set(name, join(r.globalDir, "skills", name));
  if (!r.isGlobal) for (const name of listDomainSkills(r.domain.slug)) wanted.set(name, join(r.dir, "skills", name));

  const linked: string[] = [];
  const isLink = (p: string) => {
    try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
  };
  for (const name of previous) {
    const p = join(skillsDir, name);
    if (!wanted.has(name) && isLink(p)) {
      try { unlinkSync(p); } catch { /* best effort */ }
    }
  }
  if (wanted.size === 0) return linked;
  mkdirSync(skillsDir, { recursive: true });
  for (const [name, target] of wanted) {
    const p = join(skillsDir, name);
    try {
      if (isLink(p)) {
        if (resolve(readlinkSync(p)) === resolve(target)) { linked.push(name); continue; }
        unlinkSync(p);
      } else if (existsSync(p)) {
        console.warn(`[domain-runtime] Codex skill "${name}" not linked: ${p} is the user's own skill`);
        continue;
      }
      symlinkSync(target, p);
      linked.push(name);
    } catch (err) {
      console.warn(`[domain-runtime] Could not link Codex skill "${name}":`, err);
    }
  }
  return linked;
}

/**
 * Make a Codex session's CODEX_HOME carry its domain: generated AGENTS.md and
 * linked skills. MCP servers are returned (not written) so the caller writes
 * config.toml once, together with the companion server.
 */
export function prepareCodexDomainHome(
  codexHome: string,
  slug: string | undefined,
  opts: { userAgentsMdPath: string },
): { resolved: ResolvedDomain; mcp: CodexDomainMcp; commit: () => void } {
  const r = resolveDomain(slug);
  const agentsPath = join(codexHome, "AGENTS.md");
  try {
    // A link (to ~/.codex/AGENTS.md, from before the session had a domain) is
    // replaced; the user's text is included in the generated file.
    if (isSymlink(agentsPath)) unlinkSync(agentsPath);
    writeFileSync(agentsPath, buildCodexAgentsMd(r, opts.userAgentsMdPath), "utf-8");
  } catch (err) {
    console.warn(`[domain-runtime] Could not write ${agentsPath}:`, err);
  }
  const state = readCodexState(codexHome);
  const groups = listSkillGroups();
  const off = disabledSkillGroups(r, groups);
  const plugins = domainPlugins(r);
  const skills = linkCodexSkills(codexHome, r, state.skills, off, plugins);
  const mcp = codexDomainMcp(codexHome, r, plugins);
  // Skills Codex finds by itself (repository ones, like the design group)
  // are turned off in config.toml; written in the same pass as the servers.
  mcp.tables.push(...codexSkillToggles(groups, off));
  return {
    resolved: r,
    mcp,
    // Called once config.toml has been written, so a failed write keeps the
    // old bookkeeping and the next spawn still knows what to remove.
    commit: () => {
      try {
        writeFileSync(
          join(codexHome, CODEX_STATE_FILE),
          `${JSON.stringify({ mcpServers: mcp.names, skills } satisfies CodexDomainState, null, 2)}\n`,
          "utf-8",
        );
      } catch (err) {
        console.warn(`[domain-runtime] Could not write ${CODEX_STATE_FILE}:`, err);
      }
    },
  };
}

/** `[[skills.config]]` entries (one per skill, marker first) turning off the "toggled" groups that are off. */
export function codexSkillToggles(groups: SkillGroup[], off: ReadonlySet<SkillGroupId>): string[][] {
  const out: string[][] = [];
  for (const g of groups) {
    if (g.codex !== "toggled" || !off.has(g.id)) continue;
    for (const name of g.skills) {
      out.push([`${SKILL_TOGGLE_MARKER} (${g.id}). Rewritten at every launch.`, "[[skills.config]]", `name = ${tomlString(name)}`, "enabled = false"]);
    }
  }
  return out;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
