import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMPANION_MCP_SCRIPT,
  buildCompanionMcpEntry,
  bunExecutable,
  removeClaudeMcpConfig,
  upsertCodexMcpServer,
  writeClaudeMcpConfig,
} from "./companion-mcp-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = buildCompanionMcpEntry({
  sessionId: "sess-1",
  apiUrl: "http://127.0.0.1:3456/api",
  token: "cmcp_sess-1.abc",
  command: "/usr/bin/bun",
  script: "/opt/companion/server/mcp/companion-mcp.ts",
});

describe("buildCompanionMcpEntry", () => {
  // The three variables the MCP server needs, and the bun + script command.
  it("runs the MCP script with bun and the session's variables", () => {
    expect(entry).toEqual({
      command: "/usr/bin/bun",
      args: ["/opt/companion/server/mcp/companion-mcp.ts"],
      env: {
        COMPANION_SESSION_ID: "sess-1",
        COMPANION_API_URL: "http://127.0.0.1:3456/api",
        COMPANION_MCP_TOKEN: "cmcp_sess-1.abc",
      },
    });
    const defaults = buildCompanionMcpEntry({ sessionId: "s", apiUrl: "u", token: "t" });
    expect(defaults.command).toBe(bunExecutable());
    expect(defaults.args).toEqual([COMPANION_MCP_SCRIPT]);
    expect(COMPANION_MCP_SCRIPT).toMatch(/server\/mcp\/companion-mcp\.ts$/);
    expect(existsSync(COMPANION_MCP_SCRIPT)).toBe(true);
  });
});

describe("Claude --mcp-config file", () => {
  // The file holds the token: private file in a private dir, one per session,
  // removed with the session.
  it("writes a private stdio server entry named companion and removes it", () => {
    const configDir = join(dir, "mcp-config");
    const path = writeClaudeMcpConfig(configDir, "sess-1", entry);
    expect(path).toBe(join(configDir, "sess-1.json"));
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      mcpServers: { companion: { type: "stdio", ...entry } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);

    removeClaudeMcpConfig(configDir, "sess-1");
    expect(existsSync(path)).toBe(false);
    removeClaudeMcpConfig(configDir, "sess-1"); // idempotent
  });
});

describe("Codex config.toml upsert", () => {
  const userConfig = [
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    "",
    "[mcp_servers.github]",
    'command = "gh-mcp"',
    'args = ["serve"]',
    "",
    "[profiles.fast]",
    'model = "gpt-5.5-mini"',
    "",
  ].join("\n");

  // The user's settings and MCP servers are kept byte-for-byte; the companion
  // table is appended, and the file becomes private (it holds the token).
  it("adds the companion server and keeps the rest of the file", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, userConfig, { mode: 0o644 });
    upsertCodexMcpServer(path, entry);
    const text = readFileSync(path, "utf-8");
    expect(text.startsWith(userConfig.trimEnd())).toBe(true);
    expect(text).toContain("[mcp_servers.companion]");
    expect(text).toContain('command = "/usr/bin/bun"');
    expect(text).toContain('args = ["/opt/companion/server/mcp/companion-mcp.ts"]');
    expect(text).toContain('env = { COMPANION_SESSION_ID = "sess-1", COMPANION_API_URL = "http://127.0.0.1:3456/api", COMPANION_MCP_TOKEN = "cmcp_sess-1.abc" }');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // Every launch rewrites the entry: a new token replaces the old one, and
  // the file never accumulates copies (a duplicate table breaks Codex).
  it("replaces an existing entry instead of duplicating it", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, userConfig);
    upsertCodexMcpServer(path, entry);
    upsertCodexMcpServer(path, { ...entry, env: { ...entry.env, COMPANION_MCP_TOKEN: "cmcp_sess-1.new" } });
    upsertCodexMcpServer(path, { ...entry, env: { ...entry.env, COMPANION_MCP_TOKEN: "cmcp_sess-1.new" } });
    const text = readFileSync(path, "utf-8");
    expect(text.match(/\[mcp_servers\.companion\]/g)).toHaveLength(1);
    expect(text.match(/Managed by Companion/g)).toHaveLength(1);
    expect(text).toContain("cmcp_sess-1.new");
    expect(text).not.toContain("cmcp_sess-1.abc");
    expect(text).toContain("[mcp_servers.github]");
    expect(text).toContain("[profiles.fast]");
  });

  // Hand-written companion definitions in any TOML spelling are replaced:
  // quoted table names, sub-tables, dotted keys and inline tables.
  it("removes other spellings of the companion server", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, [
      'mcp_servers.companion.command = "old"',
      "[mcp_servers]",
      'companion = { command = "inline" }',
      'other = { command = "keep-me" }',
      '[ mcp_servers . "companion" ]',
      'command = "quoted"',
      "[mcp_servers.companion.env]",
      'X = "1"',
      "[tools]",
      "web_search = true",
    ].join("\r\n"));
    upsertCodexMcpServer(path, entry);
    const text = readFileSync(path, "utf-8");
    expect(text).not.toMatch(/old|inline|quoted|X = "1"/);
    expect(text).toContain('other = { command = "keep-me" }');
    expect(text).toContain("[tools]\nweb_search = true");
    expect(text.match(/companion/g)?.length).toBeGreaterThan(0);
    expect(text.match(/^\[mcp_servers\.companion\]$/gm)).toHaveLength(1);
  });

  // Setting off: the entry is removed, nothing else changes; an absent file
  // stays absent. A file without the entry is not rewritten.
  it("removes the entry when given null", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, userConfig);
    upsertCodexMcpServer(path, entry);
    upsertCodexMcpServer(path, null);
    expect(readFileSync(path, "utf-8")).toBe(userConfig.trimEnd() + "\n");

    const absent = join(dir, "absent.toml");
    upsertCodexMcpServer(absent, null);
    expect(existsSync(absent)).toBe(false);

    const empty = join(dir, "empty.toml");
    writeFileSync(empty, "");
    upsertCodexMcpServer(empty, null);
    expect(readFileSync(empty, "utf-8")).toBe("");
  });

  it("creates the file when there is none", () => {
    const path = join(dir, "new.toml");
    upsertCodexMcpServer(path, entry);
    const text = readFileSync(path, "utf-8");
    expect(text.startsWith("# Managed by Companion")).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
  });

  // A config.toml linked to the user's global file must not be written
  // through: the link is replaced by a private copy and the target untouched.
  it("never writes through a symlink", () => {
    const global = join(dir, "global.toml");
    writeFileSync(global, userConfig);
    const path = join(dir, "config.toml");
    symlinkSync(global, path);
    upsertCodexMcpServer(path, entry);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf-8")).toContain("[mcp_servers.companion]");
    expect(readFileSync(global, "utf-8")).toBe(userConfig);
  });

  // Strings with quotes/backslashes stay valid TOML basic strings.
  it("escapes string values", () => {
    const path = join(dir, "config.toml");
    upsertCodexMcpServer(path, { ...entry, command: 'C:\\bun "x"' });
    expect(readFileSync(path, "utf-8")).toContain('command = "C:\\\\bun \\"x\\""');
  });
});
