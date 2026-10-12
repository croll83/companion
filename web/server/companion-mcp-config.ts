import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the built-in `companion` MCP server is handed to each CLI:
 *  - Claude Code: `--mcp-config <file>` naming a 0600 JSON file per session
 *    (a file, so the token is not on the command line or in the spawn log).
 *    `--strict-mcp-config` is NOT used: the user's own MCP servers keep working.
 *  - Codex: a `[mcp_servers.companion]` table upserted into the session's own
 *    CODEX_HOME/config.toml at every launch, leaving the rest of the file alone.
 */

/** Name of the server entry, so tools appear as `mcp__companion__<tool>` in Claude Code. */
export const COMPANION_MCP_SERVER_NAME = "companion";

/** The MCP server script (run with bun). */
export const COMPANION_MCP_SCRIPT = fileURLToPath(new URL("./mcp/companion-mcp.ts", import.meta.url));

export interface CompanionMcpEntry {
  command: string;
  args: string[];
  env: {
    COMPANION_SESSION_ID: string;
    COMPANION_API_URL: string;
    COMPANION_MCP_TOKEN: string;
  };
}

/**
 * The bun binary that runs the MCP server. Companion itself runs on bun, so
 * its own executable is the right one (CLIs may not have bun on PATH).
 */
export function bunExecutable(): string {
  return process.versions.bun ? process.execPath : "bun";
}

export function buildCompanionMcpEntry(opts: {
  sessionId: string;
  apiUrl: string;
  token: string;
  command?: string;
  script?: string;
}): CompanionMcpEntry {
  return {
    command: opts.command ?? bunExecutable(),
    args: [opts.script ?? COMPANION_MCP_SCRIPT],
    env: {
      COMPANION_SESSION_ID: opts.sessionId,
      COMPANION_API_URL: opts.apiUrl,
      COMPANION_MCP_TOKEN: opts.token,
    },
  };
}

// ── Claude Code ─────────────────────────────────────────────────────────────

function claudeConfigPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

/**
 * Write the `--mcp-config` file of a Claude session (0600 in a 0700 dir; it
 * holds the session's MCP token). Rewritten at every spawn. Returns its path.
 */
export function writeClaudeMcpConfig(dir: string, sessionId: string, entry: CompanionMcpEntry): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = claudeConfigPath(dir, sessionId);
  const config = {
    mcpServers: {
      [COMPANION_MCP_SERVER_NAME]: { type: "stdio", ...entry },
    },
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Delete a session's `--mcp-config` file (no-op when absent). */
export function removeClaudeMcpConfig(dir: string, sessionId: string): void {
  try {
    unlinkSync(claudeConfigPath(dir, sessionId));
  } catch {
    /* already gone */
  }
}

// ── Codex (config.toml) ─────────────────────────────────────────────────────

const MANAGED_COMMENT = "# Managed by Companion: its session tools (wake-ups, agents). Rewritten at every launch.";

/** `[a."b". c]` → `a.b.c` (quotes and spaces around dots dropped). */
function normalizeTomlKey(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\.\s*/g, ".")
    .replace(/"([^"]*)"|'([^']*)'/g, (_m, dq: string | undefined, sq: string | undefined) => dq ?? sq ?? "");
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const KEY_LINE = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=/;

/** Every marker comment Companion writes above a table it manages starts with this. */
const MANAGED_PREFIX = "# Managed by Companion";
/**
 * Marker above each `[[skills.config]]` entry Companion writes (a domain's
 * skill turned off). Those entries are matched by the marker, not by key, so
 * the user's own `[[skills.config]]` entries are never touched.
 */
export const SKILL_TOGGLE_MARKER = "# Managed by Companion: skill toggle";

/** Whether `fullKey` is (or is inside) `mcp_servers.<one of names>`. */
function isServerKey(fullKey: string, names: ReadonlySet<string>): boolean {
  for (const name of names) {
    const target = `mcp_servers.${name}`;
    if (fullKey === target || fullKey.startsWith(`${target}.`)) return true;
  }
  return false;
}

/**
 * Remove every definition of `mcp_servers.<name>`, for each of `names`, from a
 * config.toml text: its table and sub-tables, `name = {…}` / `name.x = …`
 * lines under `[mcp_servers]`, and top-level `mcp_servers.name… = …` lines.
 * Leaving any of them next to the new table would be a duplicate key, which
 * makes Codex refuse the whole file. (Single-line values only: a multi-line
 * array in a hand-written entry is not expected.)
 */
function stripServers(text: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let section = "";
  let skippingTable = false;
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      section = normalizeTomlKey(header[1]);
      // A table under our skill-toggle marker is always ours to rewrite.
      const markedSkillToggle = out.length > 0 && out[out.length - 1].trim().startsWith(SKILL_TOGGLE_MARKER);
      skippingTable = markedSkillToggle || isServerKey(section, names);
      if (skippingTable) {
        // Drop our own marker comment right above the table.
        if (out.length > 0 && out[out.length - 1].trim().startsWith(MANAGED_PREFIX)) out.pop();
        continue;
      }
      out.push(line);
      continue;
    }
    if (skippingTable) {
      // Our marker comment always sits right above the next table: it ends
      // the skipped one and must stay visible to the header check above.
      if (!line.trim().startsWith(MANAGED_PREFIX)) continue;
      skippingTable = false;
    }
    const key = KEY_LINE.exec(line);
    if (key) {
      const full = normalizeTomlKey(section ? `${section}.${key[1]}` : key[1]);
      if (isServerKey(full, names)) continue;
    }
    out.push(line);
  }
  // Trailing blank lines left behind by a removed final table.
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export function tomlString(value: string): string {
  // JSON string escapes (\" \\ \n \uXXXX) are valid TOML basic-string escapes.
  return JSON.stringify(value);
}

/** A TOML key: bare when possible, quoted otherwise. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** `{ A = "1", B = "2" }` */
export function tomlInlineTable(values: Record<string, string>): string {
  const body = Object.entries(values).map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(", ");
  return body ? `{ ${body} }` : "{}";
}

/** The `[mcp_servers.companion]` block (marker comment first) written into a Codex config.toml. */
export function companionTable(entry: CompanionMcpEntry): string[] {
  const env = Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ");
  return [
    MANAGED_COMMENT,
    `[mcp_servers.${COMPANION_MCP_SERVER_NAME}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    `env = { ${env} }`,
  ];
}

/**
 * Upsert (entry) or remove (null) the `companion` MCP server in a Codex
 * config.toml, preserving everything else. The file is never written through
 * a symlink (that could be the user's global ~/.codex/config.toml): a link is
 * replaced by a private copy first. Written 0600, it holds the MCP token.
 */
export function upsertCodexMcpServer(configPath: string, entry: CompanionMcpEntry | null): void {
  rewriteCodexMcpServers(configPath, [COMPANION_MCP_SERVER_NAME], entry ? [companionTable(entry)] : []);
}

/**
 * Remove the servers named in `remove` from a Codex config.toml and append
 * `tables` (each a whole `[mcp_servers.x]` block, marker comment first),
 * preserving everything else. The file is never written through a symlink
 * (that could be the user's global ~/.codex/config.toml): a link is replaced
 * by a private copy first. Written 0600 (it can hold tokens); not rewritten
 * when nothing changes.
 */
export function rewriteCodexMcpServers(configPath: string, remove: Iterable<string>, tables: string[][]): void {
  let text = "";
  let isLink = false;
  if (existsSync(configPath)) {
    isLink = lstatSync(configPath).isSymbolicLink();
    text = readFileSync(configPath, "utf-8");
  } else if (tables.length === 0) {
    return;
  }
  const lines = stripServers(text.replace(/\r\n/g, "\n"), new Set(remove));
  for (const table of tables) {
    if (lines.length > 0) lines.push("");
    lines.push(...table);
  }
  const next = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (!isLink && next === text) return;
  if (isLink) unlinkSync(configPath);
  writeFileSync(configPath, next, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}
