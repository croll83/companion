import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DomainInfo, McpServerDef } from "./domain-store.js";
import { claudeConfigHome } from "./skill-groups.js";

/**
 * Claude Code marketplace plugins installed for the user, as domains see them.
 *
 * A plugin is installed once (`claude plugin install`, user scope) and turned
 * on or off per domain: Claude sessions get `enabledPlugins` in `--settings`
 * (domain-runtime.ts), which wins over the user's settings.json. Codex has no
 * plugins, so for Codex sessions Companion copies what a plugin brings that
 * Codex understands: its MCP servers (config.toml) and its skills (links in
 * CODEX_HOME/skills). Plugin commands, agents and hooks are Claude only.
 */

export interface InstalledPlugin {
  /** `name@marketplace`, the key of `enabledPlugins`. */
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  description?: string;
  installPath: string;
  /** Skill folder names (`skills/<name>/SKILL.md`). */
  skills: string[];
  /** MCP servers the plugin declares, `${CLAUDE_PLUGIN_ROOT}` resolved. */
  mcpServers: Record<string, McpServerDef>;
  /** On in the user's own settings.json (`enabledPlugins[id] === true`): the state when no domain decides. */
  enabledByUser: boolean;
}

interface InstallEntry {
  scope?: string;
  installPath?: string;
  version?: string;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `${CLAUDE_PLUGIN_ROOT}` in every string of a server definition. */
function resolveRoot(def: McpServerDef, root: string): McpServerDef {
  const sub = (s: string) => s.split("${CLAUDE_PLUGIN_ROOT}").join(root);
  const out: McpServerDef = {};
  for (const [k, v] of Object.entries(def)) {
    if (typeof v === "string") (out as Record<string, unknown>)[k] = sub(v);
    else if (Array.isArray(v)) (out as Record<string, unknown>)[k] = v.map((x) => (typeof x === "string" ? sub(x) : x));
    else if (asObject(v)) {
      (out as Record<string, unknown>)[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([ek, ev]) => [ek, typeof ev === "string" ? sub(ev) : ev]),
      );
    } else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Servers of a `.mcp.json`-style object: `{"mcpServers": {...}}` or the servers directly. */
function serversOf(raw: unknown): Record<string, McpServerDef> {
  const obj = asObject(raw);
  if (!obj) return {};
  const servers = asObject(obj.mcpServers) ?? obj;
  const out: Record<string, McpServerDef> = {};
  for (const [name, def] of Object.entries(servers)) {
    const d = asObject(def);
    if (d && (typeof d.url === "string" || typeof d.command === "string")) out[name] = d as McpServerDef;
  }
  return out;
}

/** The MCP servers a plugin declares: `.mcp.json` at its root, or `mcpServers` in plugin.json (object or file path). */
function pluginMcpServers(root: string, manifest: Record<string, unknown> | undefined): Record<string, McpServerDef> {
  let servers: Record<string, McpServerDef> = {};
  const declared = manifest?.mcpServers;
  if (typeof declared === "string") {
    const path = isAbsolute(declared) ? declared : resolve(root, declared);
    servers = serversOf(readJson(path));
  } else if (asObject(declared)) {
    servers = serversOf(declared);
  } else if (existsSync(join(root, ".mcp.json"))) {
    servers = serversOf(readJson(join(root, ".mcp.json")));
  }
  return Object.fromEntries(Object.entries(servers).map(([n, d]) => [n, resolveRoot(d, root)]));
}

function pluginSkills(root: string): string[] {
  const dir = join(root, "skills");
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

/** The user's `enabledPlugins` in Claude's settings.json. */
function userEnabledPlugins(): Record<string, unknown> {
  return asObject(asObject(readJson(join(claudeConfigHome(), "settings.json")))?.enabledPlugins) ?? {};
}

/**
 * Plugins installed for the user (scope "user"), sorted by id. Installs bound
 * to one project folder (scope "local"/"project") are left out: a domain
 * spans folders, so only user installs can be turned on for it.
 */
export function listInstalledPlugins(): InstalledPlugin[] {
  const registry = asObject(asObject(readJson(join(claudeConfigHome(), "plugins", "installed_plugins.json")))?.plugins);
  if (!registry) return [];
  const enabled = userEnabledPlugins();
  const out: InstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(registry)) {
    if (!Array.isArray(entries)) continue;
    const entry = (entries as InstallEntry[]).find((e) => e && e.scope === "user" && typeof e.installPath === "string");
    if (!entry?.installPath || !existsSync(entry.installPath)) continue;
    const at = id.lastIndexOf("@");
    const root = entry.installPath;
    const manifest = asObject(readJson(join(root, ".claude-plugin", "plugin.json")));
    const description = typeof manifest?.description === "string" ? manifest.description : undefined;
    const version = typeof manifest?.version === "string" ? manifest.version : entry.version;
    out.push({
      id,
      name: at > 0 ? id.slice(0, at) : id,
      marketplace: at > 0 ? id.slice(at + 1) : "",
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      installPath: root,
      skills: pluginSkills(root),
      mcpServers: pluginMcpServers(root, manifest),
      enabledByUser: enabled[id] === true,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether sessions of `domain` get the plugin: the domain's own choice, else
 * GLOBAL's, else the user's settings. `domain` is undefined for GLOBAL itself.
 * Same order as the `enabledPlugins` Claude sessions are spawned with.
 */
export function isPluginOn(
  plugin: Pick<InstalledPlugin, "id" | "enabledByUser">,
  domain: Pick<DomainInfo, "plugins"> | undefined,
  global: Pick<DomainInfo, "plugins">,
): boolean {
  return domain?.plugins?.[plugin.id] ?? global.plugins?.[plugin.id] ?? plugin.enabledByUser;
}

/** The installed plugins turned on for sessions of a domain (`domain` undefined = GLOBAL). */
export function pluginsOn(
  domain: Pick<DomainInfo, "plugins"> | undefined,
  global: Pick<DomainInfo, "plugins">,
  plugins: InstalledPlugin[] = listInstalledPlugins(),
): InstalledPlugin[] {
  return plugins.filter((p) => isPluginOn(p, domain, global));
}
