import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { writePrivateFile } from "./private-file.js";

/**
 * Domains: the unit that shares context and tools between sessions.
 *
 * A domain is a folder `<root>/companion_domain_<slug>` that both CLIs are
 * pointed at on every spawn (see domain-runtime.ts):
 *  - `CLAUDE.md`: the domain's instructions,
 *  - `memory/` (+ `MEMORY.md` index): the domain's memory, shared by the
 *    Claude and Codex sessions of the domain,
 *  - `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`: the
 *    domain is a Claude Code plugin (`--plugin-dir`); its skills are also
 *    linked into each Codex session's home,
 *  - `mcp.json`: the domain's MCP servers. Deliberately NOT `.mcp.json`, so the
 *    plugin does not load them by itself: Companion passes them explicitly,
 *    minus the ones turned off in the Domains page.
 *
 * The GLOBAL domain applies to every (non-legacy) session in addition to the
 * session's own domain. It is created at server start and cannot be deleted.
 *
 * The registry (names, toggles) is COMPANION_HOME/domains.json. Deleting a
 * domain only removes its registry entry: files on disk are never deleted.
 */

export const GLOBAL_DOMAIN = "global";
export const DOMAIN_DIR_PREFIX = "companion_domain_";

export interface DomainInfo {
  slug: string;
  name: string;
  createdAt: number;
  description?: string;
  /**
   * MCP servers turned on (true) or off (false) by name: the domain's own
   * choice, else GLOBAL's (the default for every domain), else on. Covers
   * mcp.json servers and the ones Claude loads by itself (account-mcp.ts).
   * Replaces the older `mcpDisabled` list (converted when read).
   */
  mcp: Record<string, boolean>;
  /** Claude only: sessions of this domain start with `--chrome`. */
  chrome: boolean;
  /**
   * Claude only, used when `chrome` is on: which browser the session drives.
   * "local" (default) = the browser on Companion's own machine (isLocal),
   * falling back to a remote one so a VPS session can drive the user's Mac;
   * otherwise a specific browser deviceId. See chrome-browser.ts.
   */
  chromeBrowser: string;
  /** Claude only: marketplace plugins to force on/off (settings `enabledPlugins`). */
  plugins?: Record<string, boolean>;
  /** Skill groups (skill-groups.ts) turned on/off for this domain; absent = GLOBAL's choice, else on. */
  skillGroups?: Record<string, boolean>;
  /** Single skills turned on/off, keyed "<group>:<name>"; wins over the groups (see isSkillOn). */
  skillChoices?: Record<string, boolean>;
  /**
   * The brain (server/brain/) sessions of this domain use. One brain per
   * domain: a string = that brain, null = explicitly none, absent = GLOBAL's.
   * On GLOBAL: a string = the default brain of every domain without its own
   * choice; absent = none. See effectiveBrainSlug.
   */
  brain?: string | null;
  /**
   * The Linear team (and optionally project) this domain works on: its board
   * (#/domains/<slug>/board), the default scope of the Home page issue picker
   * and the per-domain transition rules. Only ids and display names are kept
   * here: the API key stays in linear-connections.json. Not inherited from
   * GLOBAL (a board is per domain); GLOBAL can have its own.
   */
  linear?: DomainLinearLink;
}

/**
 * A per-domain transition rule (on session start / on archive). Absent on the
 * link = the connection's own setting applies (how it worked before domains
 * had rules), so existing setups keep their behaviour until a domain chooses.
 */
export interface DomainLinearRule {
  enabled: boolean;
  /** A workflow state of the linked team ("" when disabled). */
  stateId: string;
  stateName: string;
}

export interface DomainLinearLink {
  connectionId: string;
  teamId: string;
  teamKey?: string;
  teamName?: string;
  /** Absent = the whole team. */
  projectId?: string;
  projectName?: string;
  autoTransition?: DomainLinearRule;
  archiveTransition?: DomainLinearRule;
}

export interface McpServerDef {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Claude's pre-registered OAuth client for an HTTP server (`{"clientId", "callbackPort"}`). */
  oauth?: { clientId?: string; callbackPort?: number };
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** Where domain folders live: COMPANION_DOMAINS_ROOT, else the user's home. Read at every call (tests). */
export function domainsRoot(): string {
  const env = process.env.COMPANION_DOMAINS_ROOT?.trim();
  return resolve(env || homedir());
}

export function domainDir(slug: string): string {
  return join(domainsRoot(), `${DOMAIN_DIR_PREFIX}${slug}`);
}

export function domainMemoryDir(slug: string): string {
  return join(domainDir(slug), "memory");
}

function registryPath(): string {
  return join(COMPANION_HOME, "domains.json");
}

// ── Slugs ───────────────────────────────────────────────────────────────────

/** "My Herd project!" → "my-herd-project". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug);
}

// ── Registry ────────────────────────────────────────────────────────────────

function normalize(raw: Partial<DomainInfo> & { slug: string }): DomainInfo {
  return {
    slug: raw.slug,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.slug,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    mcp: readMcpChoices(raw),
    chrome: raw.chrome === true,
    chromeBrowser: typeof raw.chromeBrowser === "string" && raw.chromeBrowser.trim() ? raw.chromeBrowser.trim() : "local",
    ...(raw.plugins && typeof raw.plugins === "object" ? { plugins: sanitizePlugins(raw.plugins) } : {}),
    ...(raw.skillGroups && typeof raw.skillGroups === "object" ? { skillGroups: sanitizePlugins(raw.skillGroups) } : {}),
    ...(raw.skillChoices && typeof raw.skillChoices === "object" ? { skillChoices: sanitizePlugins(raw.skillChoices) } : {}),
    ...readBrainChoice(raw),
    ...readLinearLink(raw.linear),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function readLinearRule(raw: unknown): DomainLinearRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<DomainLinearRule>;
  if (typeof r.enabled !== "boolean") return undefined;
  const stateId = r.enabled ? str(r.stateId) : "";
  if (r.enabled && !stateId) return undefined;
  return { enabled: r.enabled, stateId, stateName: r.enabled ? str(r.stateName) : "" };
}

/** The `linear` field as stored: needs a connection and a team, everything else optional. */
export function readLinearLink(raw: unknown): Pick<DomainInfo, "linear"> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const connectionId = str(r.connectionId);
  const teamId = str(r.teamId);
  if (!connectionId || !teamId) return {};
  const link: DomainLinearLink = { connectionId, teamId };
  for (const key of ["teamKey", "teamName", "projectId", "projectName"] as const) {
    if (str(r[key])) link[key] = str(r[key]);
  }
  if (!link.projectId) delete link.projectName;
  for (const key of ["autoTransition", "archiveTransition"] as const) {
    const rule = readLinearRule(r[key]);
    if (rule) link[key] = rule;
  }
  return { linear: link };
}

/** The `brain` field as stored: a valid slug, or null ("none") except on GLOBAL, where absent already means none. */
function readBrainChoice(raw: Partial<DomainInfo> & { slug: string }): Pick<DomainInfo, "brain"> {
  if (isValidSlug(raw.brain)) return { brain: raw.brain };
  if (raw.brain === null && raw.slug !== GLOBAL_DOMAIN) return { brain: null };
  return {};
}

/**
 * The brain sessions of a domain use: the domain's own choice (null = none),
 * else GLOBAL's, else none. `domain` is undefined for GLOBAL itself.
 */
export function effectiveBrainSlug(
  domain: Pick<DomainInfo, "brain"> | undefined,
  global: Pick<DomainInfo, "brain">,
): string | null {
  if (domain && domain.brain !== undefined) return domain.brain;
  return global.brain ?? null;
}

/** The MCP on/off map; a registry from before it has a `mcpDisabled` list (all off). */
function readMcpChoices(raw: Partial<DomainInfo> & { mcpDisabled?: unknown }): Record<string, boolean> {
  if (raw.mcp && typeof raw.mcp === "object") return sanitizePlugins(raw.mcp);
  const legacy = Array.isArray(raw.mcpDisabled) ? raw.mcpDisabled.filter((s): s is string => typeof s === "string" && !!s.trim()) : [];
  return Object.fromEntries(legacy.map((name) => [name, false]));
}

/** Whether an MCP server is on for a domain: its own choice, else GLOBAL's, else on. */
export function isMcpOn(
  name: string,
  domain: Pick<DomainInfo, "mcp"> | undefined,
  global: Pick<DomainInfo, "mcp">,
): boolean {
  return domain?.mcp?.[name] ?? global.mcp?.[name] ?? true;
}

/**
 * Apply a partial on/off map: true/false set a choice, null removes it (back
 * to the inherited state); other keys are untouched, so two quick changes
 * from different screens never undo each other.
 */
function mergeChoices(current: Record<string, boolean> | undefined, patch: unknown): Record<string, boolean> | string {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "must be an object of name: true | false | null";
  const out = { ...(current ?? {}) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    if (v === null) delete out[key];
    else if (typeof v === "boolean") out[key] = v;
    else return `"${key}" must be true, false or null`;
  }
  return out;
}

/** A name → on/off map (plugins, skill groups), anything else dropped. */
function sanitizePlugins(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean" && k.trim()) out[k.trim()] = v;
  }
  return out;
}

function readRegistry(): DomainInfo[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf-8")) as { domains?: unknown };
    if (!Array.isArray(parsed.domains)) return [];
    return parsed.domains
      .filter((d): d is DomainInfo => !!d && typeof d === "object" && isValidSlug((d as DomainInfo).slug))
      .map((d) => normalize(d));
  } catch {
    return [];
  }
}

/**
 * Read every domain, let `change` edit them in place, and write them back in
 * one go: for changes that must apply to several domains at once (a brain
 * deleted or adopted in place of a plugin). Returns the domains as written.
 */
export function updateDomainsAtomically(change: (domains: DomainInfo[]) => void): DomainInfo[] {
  const domains = readRegistry();
  change(domains);
  const normalized = domains.map((d) => normalize(d));
  writeRegistry(normalized);
  return normalized;
}

function writeRegistry(domains: DomainInfo[]): void {
  mkdirSync(dirname(registryPath()), { recursive: true });
  writePrivateFile(registryPath(), `${JSON.stringify({ version: 1, domains }, null, 2)}\n`);
}

/** All domains, GLOBAL first, then by name. */
export function listDomains(): DomainInfo[] {
  return readRegistry().sort((a, b) => {
    if (a.slug === GLOBAL_DOMAIN) return -1;
    if (b.slug === GLOBAL_DOMAIN) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function getDomain(slug: string): DomainInfo | undefined {
  return readRegistry().find((d) => d.slug === slug);
}

// ── Folder layout ───────────────────────────────────────────────────────────

function claudeMdTemplate(domain: Pick<DomainInfo, "slug" | "name" | "description">): string {
  if (domain.slug === GLOBAL_DOMAIN) {
    return [
      "# GLOBAL domain",
      "",
      "Instructions in this file apply to every Companion session (Claude Code and Codex),",
      "in addition to the instructions of the session's own domain.",
      "",
    ].join("\n");
  }
  return [
    `# Domain: ${domain.name}`,
    "",
    domain.description || "What this domain is about, and the conventions its sessions should follow.",
    "",
    "Every Companion session in this domain (Claude Code and Codex) reads this file and shares",
    "the domain's memory, skills and MCP servers.",
    "",
  ].join("\n");
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  // "wx": never overwrite, even if the file appeared since the check.
  try {
    writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
}

/**
 * Create the domain folder and whatever part of its layout is missing.
 * Existing files are never overwritten (the user may have edited them).
 */
export function ensureDomainLayout(domain: Pick<DomainInfo, "slug" | "name" | "description">): string {
  const dir = domainDir(domain.slug);
  for (const sub of ["memory", "skills", "commands", "agents", ".claude-plugin"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeIfMissing(join(dir, "CLAUDE.md"), claudeMdTemplate(domain));
  writeIfMissing(join(dir, "memory", "MEMORY.md"), "");
  writeIfMissing(
    join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({
      name: `domain-${domain.slug}`,
      version: "1.0.0",
      description: domain.description || `Companion domain ${domain.name}`,
    }, null, 2)}\n`,
  );
  writeIfMissing(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
  return dir;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

/** Create the GLOBAL domain (registry entry and folder) when missing. Called at server start. */
export function ensureGlobalDomain(): DomainInfo {
  const domains = readRegistry();
  let global = domains.find((d) => d.slug === GLOBAL_DOMAIN);
  if (!global) {
    global = normalize({ slug: GLOBAL_DOMAIN, name: "GLOBAL", mcp: {}, chrome: false });
    writeRegistry([global, ...domains]);
  }
  ensureDomainLayout(global);
  return global;
}

export type DomainResult = { ok: true; domain: DomainInfo } | { ok: false; status: 400 | 404 | 409; error: string };

export function createDomain(input: { name?: unknown; slug?: unknown; description?: unknown }): DomainResult {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, status: 400, error: "Domain name is required" };
  const slug = typeof input.slug === "string" && input.slug.trim() ? input.slug.trim() : slugify(name);
  if (!isValidSlug(slug)) return { ok: false, status: 400, error: "The name must contain letters or digits" };
  const domains = readRegistry();
  if (domains.some((d) => d.slug === slug)) {
    return { ok: false, status: 409, error: `A domain "${slug}" already exists` };
  }
  const domain = normalize({
    slug,
    name,
    createdAt: Date.now(),
    description: typeof input.description === "string" ? input.description : undefined,
    mcp: {},
    chrome: false,
  });
  ensureDomainLayout(domain);
  writeRegistry([...domains, domain]);
  return { ok: true, domain };
}

export interface DomainPatch {
  name?: unknown;
  description?: unknown;
  /** Partial map name → true | false | null (null = back to GLOBAL's choice). */
  mcp?: unknown;
  /** Older form: the full list of servers off for the domain (replaces every "off" choice). */
  mcpDisabled?: unknown;
  skillChoices?: unknown;
  chrome?: unknown;
  chromeBrowser?: unknown;
  plugins?: unknown;
  skillGroups?: unknown;
  /** A brain slug, null (no brain) or "inherit" (back to GLOBAL's; not for GLOBAL). Existence is checked by the route. */
  brain?: unknown;
}

export function updateDomain(slug: string, patch: DomainPatch): DomainResult {
  const domains = readRegistry();
  const idx = domains.findIndex((d) => d.slug === slug);
  if (idx < 0) return { ok: false, status: 404, error: "Domain not found" };
  const cur = domains[idx];
  const next: DomainInfo = { ...cur };
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) return { ok: false, status: 400, error: "Invalid name" };
    next.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") return { ok: false, status: 400, error: "Invalid description" };
    if (patch.description.trim()) next.description = patch.description.trim();
    else delete next.description;
  }
  if (patch.mcpDisabled !== undefined) {
    if (!Array.isArray(patch.mcpDisabled) || patch.mcpDisabled.some((s) => typeof s !== "string")) {
      return { ok: false, status: 400, error: "mcpDisabled must be a list of server names" };
    }
    const kept = Object.entries(next.mcp).filter(([, on]) => on);
    next.mcp = { ...Object.fromEntries(kept), ...Object.fromEntries((patch.mcpDisabled as string[]).map((n) => [n, false])) };
  }
  if (patch.mcp !== undefined) {
    const merged = mergeChoices(next.mcp, patch.mcp);
    if (typeof merged === "string") return { ok: false, status: 400, error: `mcp ${merged}` };
    next.mcp = merged;
  }
  if (patch.chrome !== undefined) {
    if (typeof patch.chrome !== "boolean") return { ok: false, status: 400, error: "chrome must be a boolean" };
    next.chrome = patch.chrome;
  }
  if (patch.chromeBrowser !== undefined) {
    if (typeof patch.chromeBrowser !== "string" || !patch.chromeBrowser.trim()) {
      return { ok: false, status: 400, error: "chromeBrowser must be \"local\" or a browser deviceId" };
    }
    next.chromeBrowser = patch.chromeBrowser.trim();
  }
  for (const key of ["plugins", "skillGroups", "skillChoices"] as const) {
    if (patch[key] === undefined) continue;
    const merged = mergeChoices(cur[key], patch[key]);
    if (typeof merged === "string") return { ok: false, status: 400, error: `${key} ${merged}` };
    if (Object.keys(merged).length > 0) next[key] = merged;
    else delete next[key];
  }
  if (patch.brain !== undefined) {
    const error = applyBrainChoice(next, patch.brain);
    if (error) return { ok: false, status: 400, error };
  }
  domains[idx] = next;
  writeRegistry(domains);
  return { ok: true, domain: next };
}

/**
 * Set a domain's brain from a patch: a slug replaces the previous one (one
 * brain per domain), null turns it off, "inherit" removes the choice. On
 * GLOBAL, null and "inherit" are refused/normalized: absent already means none.
 */
function applyBrainChoice(domain: DomainInfo, value: unknown): string | null {
  const isGlobal = domain.slug === GLOBAL_DOMAIN;
  if (value === "inherit") {
    if (isGlobal) return "GLOBAL has nothing to inherit a brain from: use null for none";
    delete domain.brain;
  } else if (value === null) {
    if (isGlobal) delete domain.brain;
    else domain.brain = null;
  } else if (isValidSlug(value)) {
    domain.brain = value;
  } else {
    return "brain must be a brain slug, null or \"inherit\"";
  }
  return null;
}

/**
 * Link a domain to a Linear team/project, or unlink it (null). The caller
 * validates the ids against Linear first (domain-linear-routes.ts).
 */
export function setDomainLinear(slug: string, link: DomainLinearLink | null): DomainResult {
  const domains = readRegistry();
  const idx = domains.findIndex((d) => d.slug === slug);
  if (idx < 0) return { ok: false, status: 404, error: "Domain not found" };
  const next: DomainInfo = { ...domains[idx] };
  delete next.linear;
  if (link) {
    const read = readLinearLink(link);
    if (!read.linear) return { ok: false, status: 400, error: "A Linear link needs a connectionId and a teamId" };
    next.linear = read.linear;
  }
  domains[idx] = next;
  writeRegistry(domains);
  return { ok: true, domain: next };
}

/** Unlink every domain linked to a Linear connection (it was deleted). Returns their slugs. */
export function clearLinearConnectionFromDomains(connectionId: string): string[] {
  const cleared: string[] = [];
  const domains = readRegistry();
  for (const d of domains) {
    if (d.linear?.connectionId === connectionId) {
      delete d.linear;
      cleared.push(d.slug);
    }
  }
  if (cleared.length > 0) writeRegistry(domains);
  return cleared;
}

/** Remove a domain from the registry. Its folder and files stay on disk. */
export function deleteDomain(slug: string): DomainResult {
  if (slug === GLOBAL_DOMAIN) return { ok: false, status: 400, error: "The GLOBAL domain cannot be deleted" };
  const domains = readRegistry();
  const domain = domains.find((d) => d.slug === slug);
  if (!domain) return { ok: false, status: 404, error: "Domain not found" };
  writeRegistry(domains.filter((d) => d.slug !== slug));
  return { ok: true, domain };
}

// ── Contents ────────────────────────────────────────────────────────────────

export interface McpConfigRead {
  servers: Record<string, McpServerDef>;
  /** Set when mcp.json exists but cannot be used (the servers are then empty). */
  error?: string;
}

/** The servers declared in a domain's mcp.json (`{"mcpServers": {...}}`). */
export function readDomainMcp(slug: string): McpConfigRead {
  const path = join(domainDir(slug), "mcp.json");
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { servers: {} };
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    const raw = parsed.mcpServers;
    if (raw === undefined) return { servers: {} };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { servers: {}, error: "mcpServers must be an object" };
    const servers: Record<string, McpServerDef> = {};
    for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
      if (def && typeof def === "object" && !Array.isArray(def)) servers[name] = def as McpServerDef;
    }
    return { servers };
  } catch (err) {
    return { servers: {}, error: `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type McpEditResult = { ok: true; servers: string[] } | { ok: false; status: 400 | 404 | 409; error: string };

/** A server definition from the Domains page form: a URL (HTTP) or a command (stdio). */
function parseServerInput(input: { url?: unknown; command?: unknown; args?: unknown }): McpServerDef | string {
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!!url === !!command) return "Give either a URL or a command";
  if (url) {
    if (!/^https?:\/\/\S+$/.test(url)) return "The URL must start with http:// or https://";
    return { type: "http", url };
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((a) => typeof a !== "string"))) {
    return "args must be a list of strings";
  }
  const args = (input.args as string[] | undefined)?.filter((a) => a.length > 0) ?? [];
  return { type: "stdio", command, ...(args.length > 0 ? { args } : {}) };
}

/**
 * Add or replace (`def`), or remove (`null`), one server in a domain's
 * mcp.json, keeping everything else in the file. A file that is not valid
 * JSON is left alone. Written 0600: server env may hold tokens.
 */
export function setDomainMcpServer(
  slug: string,
  name: unknown,
  input: { url?: unknown; command?: unknown; args?: unknown } | null,
): McpEditResult {
  if (slug !== GLOBAL_DOMAIN && !getDomain(slug)) return { ok: false, status: 404, error: "Domain not found" };
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name)) {
    return { ok: false, status: 400, error: "Server name: letters, digits, \"-\" or \"_\" (Codex needs it)" };
  }
  const path = join(domainDir(slug), "mcp.json");
  let doc: Record<string, unknown> = {};
  if (existsSync(path)) {
    const read = readDomainMcp(slug);
    if (read.error) return { ok: false, status: 409, error: `${read.error}: fix mcp.json first` };
    doc = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }
  const servers = { ...((doc.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  if (input === null) {
    if (!(name in servers)) return { ok: false, status: 404, error: `No server "${name}" in mcp.json` };
    delete servers[name];
  } else {
    const def = parseServerInput(input);
    if (typeof def === "string") return { ok: false, status: 400, error: def };
    servers[name] = def;
  }
  mkdirSync(domainDir(slug), { recursive: true });
  writePrivateFile(path, `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`);
  return { ok: true, servers: Object.keys(servers).sort() };
}

export type SkillEditResult = { ok: true; path: string } | { ok: false; status: 400 | 404 | 409; error: string };

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Create a skill of the domain's own: `<domain>/skills/<name>/SKILL.md` with
 * its frontmatter. Claude loads it through the domain plugin (/<name> is
 * namespaced as domain-<slug>:<name>), Codex through the linked skills.
 */
export function createDomainSkill(slug: string, name: unknown, description: unknown): SkillEditResult {
  if (slug !== GLOBAL_DOMAIN && !getDomain(slug)) return { ok: false, status: 404, error: "Domain not found" };
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    return { ok: false, status: 400, error: "Skill name: lowercase letters, digits and \"-\" (max 64)" };
  }
  if (typeof description !== "string" || !description.trim()) {
    return { ok: false, status: 400, error: "A description is required: it tells the model when to use the skill" };
  }
  const dir = join(domainDir(slug), "skills", name);
  if (existsSync(dir)) return { ok: false, status: 409, error: `The domain already has a skill "${name}"` };
  mkdirSync(dir, { recursive: true });
  const desc = description.trim().replace(/\s+/g, " ");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${name}\n\nInstructions for the agent go here.\n`, "utf-8");
  return { ok: true, path };
}

/** Remove a skill of the domain's own: its folder is moved to `<domain>/.removed-skills/<name>-<time>`, never deleted. */
export function removeDomainSkill(slug: string, name: string): SkillEditResult {
  if (slug !== GLOBAL_DOMAIN && !getDomain(slug)) return { ok: false, status: 404, error: "Domain not found" };
  const dir = join(domainDir(slug), "skills", name);
  if (!SKILL_NAME.test(name) || !existsSync(join(dir, "SKILL.md"))) return { ok: false, status: 404, error: `No skill "${name}" in the domain` };
  const dest = join(domainDir(slug), ".removed-skills", `${name}-${Date.now()}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  return { ok: true, path: dest };
}

/** Skill folder names (`skills/<name>/SKILL.md`) of a domain. */
export function listDomainSkills(slug: string): string[] {
  const dir = join(domainDir(slug), "skills");
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

/** Memory notes (every .md in memory/ except the MEMORY.md index). */
export function countMemoryNotes(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
  } catch {
    return 0;
  }
}

/** The MEMORY.md index of a memory folder ("" when missing). Capped so a runaway index cannot flood a prompt. */
export function readMemoryIndex(memoryDir: string, maxBytes = 24_000): string {
  try {
    const text = readFileSync(join(memoryDir, "MEMORY.md"), "utf-8");
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[... index truncated ...]\n` : text;
  } catch {
    return "";
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
