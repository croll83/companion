/**
 * Discovery, path allow-listing and creation templates for the Claude Code /
 * Codex configuration files shown in the session panel (ClaudeConfigBrowser).
 *
 * Discovery mirrors what the CLIs actually load:
 * - CLAUDE.md / .claude/CLAUDE.md / CLAUDE.local.md (and AGENTS.md for Codex)
 *   from the session cwd up to the repository root, so sub-directory
 *   instruction files are listed too.
 * - skills, agents and commands are found by following symlinks (stat, not
 *   lstat), the way Claude Code does. User skills synced from claude.ai live
 *   under `~/.claude/skills/synced/<sync-id>/<name>/SKILL.md` and are listed
 *   read-only, because the next sync would overwrite local edits.
 *
 * The allow-list (`classifyConfigPath`) is what the dedicated config read/write
 * routes use instead of the generic `/fs/*` guard: only these well-known config
 * files, under the session's project root or `~/.claude` / `~/.codex`, are
 * accepted, wherever the project lives on disk.
 */
import { execSync } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ConfigFormat = "markdown" | "json" | "toml";

export interface ConfigFileContent {
  path: string;
  content: string;
}

export interface NamedConfigFile {
  name: string;
  path: string;
}

export interface SkillEntry {
  slug: string;
  name: string;
  description: string;
  path: string;
  /** "synced" = claude.ai-synced skill (read-only), "link" = symlinked skill dir */
  source?: "synced" | "link";
}

export interface ClaudeConfigListing {
  project: {
    root: string;
    cwd: string;
    claudeMd: ConfigFileContent[];
    claudeLocalMd: ConfigFileContent[];
    settings: ConfigFileContent | null;
    settingsLocal: ConfigFileContent | null;
    mcpJson: ConfigFileContent | null;
    commands: NamedConfigFile[];
    agents: NamedConfigFile[];
    skills: SkillEntry[];
    /** Codex: AGENTS.md files from cwd up to the project root */
    agentsMd: ConfigFileContent[];
  };
  user: {
    root: string;
    claudeMd: ConfigFileContent | null;
    skills: SkillEntry[];
    agents: NamedConfigFile[];
    settings: ConfigFileContent | null;
    settingsLocal: ConfigFileContent | null;
    commands: NamedConfigFile[];
    codex: {
      root: string;
      agentsMd: ConfigFileContent | null;
      config: { path: string; editable: boolean } | null;
    };
  };
}

// ─── TOML ─────────────────────────────────────────────────────────────────────

type TomlParse = (text: string) => unknown;

/** Bun ships a TOML parser (Bun.TOML.parse); there is no TOML package in our
 *  dependencies. Without it (e.g. under Node in tests) config.toml is read-only. */
export function getTomlParser(): TomlParse | null {
  const bun = (globalThis as { Bun?: { TOML?: { parse?: TomlParse } } }).Bun;
  return typeof bun?.TOML?.parse === "function" ? bun.TOML.parse : null;
}

/** Returns an error message when `content` is not valid for `format`, else null. */
export function validateConfigContent(format: ConfigFormat, content: string): string | null {
  if (format === "json") {
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (format === "toml") {
    const parse = getTomlParser();
    if (!parse) return "TOML validation is unavailable, so this file is read-only";
    try {
      parse(content);
      return null;
    } catch (e) {
      return `Invalid TOML: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return null;
}

// ─── Project layout ──────────────────────────────────────────────────────────

export interface ConfigContext {
  cwd: string;
  projectRoot: string;
  /** cwd, then each parent up to and including projectRoot */
  walkDirs: string[];
  home: string;
}

/** Resolve the project root (git toplevel, or cwd outside a repo) and the
 *  walk-up directory list used for instruction-file discovery. */
export function resolveConfigContext(rawCwd: string, home: string): ConfigContext {
  const cwd = resolve(rawCwd);
  let projectRoot = cwd;
  try {
    projectRoot = resolve(
      execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    // Not a git repo — only the exact cwd is the project.
  }
  // A cwd outside the reported root (symlinked cwd) falls back to cwd only.
  if (cwd !== projectRoot && !cwd.startsWith(projectRoot + sep)) projectRoot = cwd;

  const walkDirs: string[] = [];
  let dir = cwd;
  while (true) {
    walkDirs.push(dir);
    if (dir === projectRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { cwd, projectRoot, walkDirs, home: resolve(home) };
}

async function readIfExists(path: string): Promise<ConfigFileContent | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { path, content: await readFile(path, "utf-8") };
  } catch {
    return null;
  }
}

/** Read each `rels` file that exists in each walk-up directory, in walk order. */
export async function collectWalkUp(walkDirs: string[], rels: string[]): Promise<ConfigFileContent[]> {
  const out: ConfigFileContent[] = [];
  for (const d of walkDirs) {
    for (const rel of rels) {
      const found = await readIfExists(join(d, rel));
      if (found) out.push(found);
    }
  }
  return out;
}

/** Parse `name` and `description` from YAML frontmatter (folded `>`/`|`
 *  descriptions are joined into one line). */
export function parseFrontmatter(content: string): { name?: string; description?: string } {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return {};
  const lines = fm[1].split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value) || value === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(" ");
    }
    out[m[1] as "name" | "description"] = unquote(value);
  }
  return out;
}

/** Recursively list `*.md` files under `dir`, following symlinks. Nested
 *  files get Claude Code's namespaced name (`sub:name`). */
async function listMarkdownTree(dir: string, useFrontmatterName: boolean): Promise<NamedConfigFile[]> {
  const out: NamedConfigFile[] = [];
  const visited = new Set<string>();
  async function walk(current: string, prefix: string[], depth: number): Promise<void> {
    if (depth > 5) return;
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return;
    }
    if (visited.has(real)) return; // symlink cycle
    visited.add(real);
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const entry of names) {
      if (entry.startsWith(".")) continue;
      const full = join(current, entry);
      let info;
      try {
        info = await stat(full); // follows symlinks
      } catch {
        continue; // dangling link
      }
      if (info.isDirectory()) {
        await walk(full, [...prefix, entry], depth + 1);
      } else if (info.isFile() && entry.endsWith(".md")) {
        let name = [...prefix, entry.replace(/\.md$/, "")].join(":");
        if (useFrontmatterName) {
          try {
            name = parseFrontmatter(await readFile(full, "utf-8")).name || name;
          } catch { /* unreadable — keep file name */ }
        }
        out.push({ name, path: full });
      }
    }
  }
  await walk(dir, [], 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkill(dir: string, slug: string, source?: SkillEntry["source"]): Promise<SkillEntry | null> {
  const found = await readIfExists(join(dir, "SKILL.md"));
  if (!found) return null;
  const fm = parseFrontmatter(found.content);
  return {
    slug,
    name: fm.name || slug,
    description: fm.description || "",
    path: found.path,
    ...(source ? { source } : {}),
  };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** List skills in `<skillsDir>/<name>/SKILL.md` (symlinks followed). With
 *  `includeSynced`, also `<skillsDir>/synced/<sync-id>/<name>/SKILL.md`. */
async function listSkills(skillsDir: string, includeSynced: boolean): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(skillsDir, entry.name);
    if (!(await isDir(full))) continue;
    if (includeSynced && entry.name === "synced") {
      for (const syncId of await readdir(full).catch(() => [] as string[])) {
        const syncDir = join(full, syncId);
        if (!(await isDir(syncDir))) continue;
        for (const name of await readdir(syncDir).catch(() => [] as string[])) {
          const skill = await readSkill(join(syncDir, name), name, "synced");
          if (skill) out.push(skill);
        }
      }
      continue;
    }
    const skill = await readSkill(full, entry.name, entry.isSymbolicLink() ? "link" : undefined);
    if (skill) out.push(skill);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverClaudeConfig(ctx: ConfigContext): Promise<ClaudeConfigListing> {
  const { projectRoot, walkDirs, home } = ctx;
  const projectClaude = join(projectRoot, ".claude");
  const userRoot = join(home, ".claude");
  const codexRoot = join(home, ".codex");
  const codexConfigPath = join(codexRoot, "config.toml");
  const codexConfigExists = (await readIfExists(codexConfigPath)) !== null;

  return {
    project: {
      root: projectRoot,
      cwd: ctx.cwd,
      claudeMd: await collectWalkUp(walkDirs, ["CLAUDE.md", join(".claude", "CLAUDE.md")]),
      claudeLocalMd: await collectWalkUp(walkDirs, ["CLAUDE.local.md"]),
      settings: await readIfExists(join(projectClaude, "settings.json")),
      settingsLocal: await readIfExists(join(projectClaude, "settings.local.json")),
      mcpJson: await readIfExists(join(projectRoot, ".mcp.json")),
      commands: await listMarkdownTree(join(projectClaude, "commands"), false),
      agents: await listMarkdownTree(join(projectClaude, "agents"), true),
      skills: await listSkills(join(projectClaude, "skills"), false),
      agentsMd: await collectWalkUp(walkDirs, ["AGENTS.md"]),
    },
    user: {
      root: userRoot,
      claudeMd: await readIfExists(join(userRoot, "CLAUDE.md")),
      skills: await listSkills(join(userRoot, "skills"), true),
      agents: await listMarkdownTree(join(userRoot, "agents"), true),
      settings: await readIfExists(join(userRoot, "settings.json")),
      settingsLocal: await readIfExists(join(userRoot, "settings.local.json")),
      commands: await listMarkdownTree(join(userRoot, "commands"), false),
      codex: {
        root: codexRoot,
        agentsMd: await readIfExists(join(codexRoot, "AGENTS.md")),
        config: codexConfigExists
          ? { path: codexConfigPath, editable: getTomlParser() !== null }
          : null,
      },
    },
  };
}

// ─── Allow-list ──────────────────────────────────────────────────────────────

export interface ConfigPathInfo {
  format: ConfigFormat;
  readOnly: boolean;
}

/** Path segments of `abs` below `base`, or null when `abs` is not inside it. */
function segmentsUnder(abs: string, base: string): string[] | null {
  if (!abs.startsWith(base + sep)) return null;
  const rel = relative(base, abs);
  return rel.split(sep);
}

/** `.claude/commands/**.md`, `.claude/agents/**.md`, `.claude/skills/<n>/SKILL.md` */
function classifyClaudeDirEntry(abs: string, claudeDir: string, allowSynced: boolean): ConfigPathInfo | null {
  const segs = segmentsUnder(abs, claudeDir);
  if (!segs || segs.some((s) => s === "" || s === "." || s === "..")) return null;
  const [top, ...rest] = segs;
  if ((top === "commands" || top === "agents") && rest.length >= 1 && abs.endsWith(".md")) {
    return { format: "markdown", readOnly: false };
  }
  if (top === "skills") {
    if (rest.length === 2 && rest[1] === "SKILL.md") return { format: "markdown", readOnly: false };
    if (allowSynced && rest.length === 4 && rest[0] === "synced" && rest[3] === "SKILL.md") {
      return { format: "markdown", readOnly: true };
    }
  }
  return null;
}

/**
 * Classify `rawPath` as one of the known config files for this session, or
 * return null when it is anything else. The check is on the resolved path, so
 * `..` segments cannot escape the allowed locations.
 */
export function classifyConfigPath(rawPath: string, ctx: ConfigContext): ConfigPathInfo | null {
  const abs = resolve(rawPath);
  const md: ConfigPathInfo = { format: "markdown", readOnly: false };
  const json: ConfigPathInfo = { format: "json", readOnly: false };

  // Instruction files anywhere on the cwd → project-root walk.
  for (const d of ctx.walkDirs) {
    for (const rel of ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md", "AGENTS.md"]) {
      if (abs === join(d, rel)) return md;
    }
  }

  const projectClaude = join(ctx.projectRoot, ".claude");
  if (abs === join(projectClaude, "settings.json") || abs === join(projectClaude, "settings.local.json")) {
    return json;
  }
  if (abs === join(ctx.projectRoot, ".mcp.json")) return json;
  const projectEntry = classifyClaudeDirEntry(abs, projectClaude, false);
  if (projectEntry) return projectEntry;

  const userClaude = join(ctx.home, ".claude");
  if (abs === join(userClaude, "CLAUDE.md")) return md;
  if (abs === join(userClaude, "settings.json") || abs === join(userClaude, "settings.local.json")) {
    return json;
  }
  const userEntry = classifyClaudeDirEntry(abs, userClaude, true);
  if (userEntry) return userEntry;

  const codexRoot = join(ctx.home, ".codex");
  if (abs === join(codexRoot, "AGENTS.md")) return md;
  if (abs === join(codexRoot, "config.toml")) {
    return { format: "toml", readOnly: getTomlParser() === null };
  }
  return null;
}

// ─── Creation ────────────────────────────────────────────────────────────────

export type NewConfigType =
  | "claude-md"
  | "claude-local-md"
  | "settings"
  | "settings-local"
  | "mcp-json"
  | "command"
  | "agent"
  | "skill"
  | "agents-md";

export type ConfigScope = "project" | "user";

const NAMED_TYPES = new Set<NewConfigType>(["command", "agent", "skill"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const SETTINGS_TEMPLATE = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json"
}
`;

/**
 * Resolve the target path and starter content for a "New…" action.
 * Returns `{ error }` for an unsupported scope/type pair or a bad name.
 */
export function planNewConfigFile(
  ctx: ConfigContext,
  scope: ConfigScope,
  type: NewConfigType,
  rawName?: string,
): { path: string; content: string } | { error: string } {
  const name = (rawName ?? "").trim();
  if (NAMED_TYPES.has(type)) {
    const re = type === "skill" ? SKILL_NAME_RE : NAME_RE;
    if (!re.test(name)) {
      return {
        error: type === "skill"
          ? "Skill names use lowercase letters, digits and hyphens (max 64)"
          : "Names use letters, digits, '-' and '_' (max 64)",
      };
    }
  }
  const base = scope === "project" ? join(ctx.projectRoot, ".claude") : join(ctx.home, ".claude");
  const where = scope === "project" ? "this project" : "every project";

  switch (type) {
    case "claude-md":
      return {
        path: scope === "project" ? join(ctx.projectRoot, "CLAUDE.md") : join(base, "CLAUDE.md"),
        content: `# CLAUDE.md\n\nInstructions for Claude Code in ${where}.\n`,
      };
    case "claude-local-md":
      if (scope !== "project") break;
      return {
        path: join(ctx.projectRoot, "CLAUDE.local.md"),
        content: "# CLAUDE.local.md\n\nPersonal instructions for this project. Keep this file out of git.\n",
      };
    case "settings":
      return { path: join(base, "settings.json"), content: SETTINGS_TEMPLATE };
    case "settings-local":
      return { path: join(base, "settings.local.json"), content: SETTINGS_TEMPLATE };
    case "mcp-json":
      if (scope !== "project") break;
      return { path: join(ctx.projectRoot, ".mcp.json"), content: `{\n  "mcpServers": {}\n}\n` };
    case "command":
      return {
        path: join(base, "commands", `${name}.md`),
        content: `---\ndescription: What /${name} does\nargument-hint: [args]\n---\n\nDescribe the task for /${name}. $ARGUMENTS holds the arguments.\n`,
      };
    case "agent":
      return {
        path: join(base, "agents", `${name}.md`),
        content: `---\nname: ${name}\ndescription: When Claude should delegate to this agent\n# tools: Read, Grep, Glob  (omit to inherit all tools)\n---\n\nYou are ${name}. Describe the agent's role and how it should work.\n`,
      };
    case "skill":
      return {
        path: join(base, "skills", name, "SKILL.md"),
        content: `---\nname: ${name}\ndescription: What this skill does and when Claude should use it\n---\n\n# ${name}\n\nStep-by-step instructions for the skill.\n`,
      };
    case "agents-md":
      return {
        path: scope === "project" ? join(ctx.projectRoot, "AGENTS.md") : join(ctx.home, ".codex", "AGENTS.md"),
        content: `# AGENTS.md\n\nInstructions for Codex in ${where}.\n`,
      };
  }
  return { error: `Cannot create ${type} in ${scope} scope` };
}
