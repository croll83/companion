import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  /** MCP server names (from global or domain mcp.json) turned off for this domain's sessions. */
  mcpDisabled: string[];
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
    mcpDisabled: Array.isArray(raw.mcpDisabled) ? raw.mcpDisabled.filter((s): s is string => typeof s === "string") : [],
    chrome: raw.chrome === true,
    chromeBrowser: typeof raw.chromeBrowser === "string" && raw.chromeBrowser.trim() ? raw.chromeBrowser.trim() : "local",
    ...(raw.plugins && typeof raw.plugins === "object" ? { plugins: sanitizePlugins(raw.plugins) } : {}),
    ...(raw.skillGroups && typeof raw.skillGroups === "object" ? { skillGroups: sanitizePlugins(raw.skillGroups) } : {}),
  };
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
    global = normalize({ slug: GLOBAL_DOMAIN, name: "GLOBAL", mcpDisabled: [], chrome: false });
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
    mcpDisabled: [],
    chrome: false,
  });
  ensureDomainLayout(domain);
  writeRegistry([...domains, domain]);
  return { ok: true, domain };
}

export interface DomainPatch {
  name?: unknown;
  description?: unknown;
  mcpDisabled?: unknown;
  chrome?: unknown;
  chromeBrowser?: unknown;
  plugins?: unknown;
  skillGroups?: unknown;
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
    next.mcpDisabled = [...new Set(patch.mcpDisabled as string[])];
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
  if (patch.plugins !== undefined) {
    if (!patch.plugins || typeof patch.plugins !== "object") return { ok: false, status: 400, error: "plugins must be an object" };
    next.plugins = { ...(cur.plugins ?? {}), ...sanitizePlugins(patch.plugins) };
  }
  if (patch.skillGroups !== undefined) {
    if (!patch.skillGroups || typeof patch.skillGroups !== "object") return { ok: false, status: 400, error: "skillGroups must be an object" };
    next.skillGroups = { ...(cur.skillGroups ?? {}), ...sanitizePlugins(patch.skillGroups) };
  }
  domains[idx] = next;
  writeRegistry(domains);
  return { ok: true, domain: next };
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
