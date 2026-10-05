import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  classifyConfigPath,
  discoverClaudeConfig,
  getTomlParser,
  parseFrontmatter,
  planNewConfigFile,
  resolveConfigContext,
  validateConfigContent,
} from "./claude-config.js";

const mkReal = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

let home: string;
let repo: string;
let external: string;

beforeEach(() => {
  home = mkReal("cc-home-");
  repo = mkReal("cc-repo-");
  external = mkReal("cc-ext-");
  execSync("git init -q", { cwd: repo });
});

afterEach(() => {
  for (const d of [home, repo, external]) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("resolveConfigContext", () => {
  // The walk must start at the session cwd and stop at the repo root, so
  // sub-directory CLAUDE.md files are reachable (the old UI passed repo_root).
  it("walks from a sub-directory cwd up to the git root", () => {
    const sub = join(repo, "packages", "core");
    mkdirSync(sub, { recursive: true });
    const ctx = resolveConfigContext(sub, home);
    expect(ctx.projectRoot).toBe(repo);
    expect(ctx.walkDirs).toEqual([sub, join(repo, "packages"), repo]);
  });

  // Outside a git repo only the cwd itself is the project.
  it("uses the cwd alone outside a git repo", () => {
    const ctx = resolveConfigContext(external, home);
    expect(ctx.projectRoot).toBe(external);
    expect(ctx.walkDirs).toEqual([external]);
  });

  // A cwd reached through a symlink is not under the realpath git root; the
  // walk must not run off to the filesystem root in that case.
  it("falls back to the cwd when it is not under the reported git root", () => {
    const link = join(external, "link");
    symlinkSync(repo, link);
    const ctx = resolveConfigContext(link, home);
    expect(ctx.projectRoot).toBe(link);
    expect(ctx.walkDirs).toEqual([link]);
  });
});

describe("parseFrontmatter", () => {
  // Quoted single-line values are unquoted.
  it("reads name and quoted description", () => {
    expect(parseFrontmatter('---\nname: "x"\ndescription: \'does y\'\n---\nbody')).toEqual({
      name: "x",
      description: "does y",
    });
  });

  // Folded descriptions (`description: >`) are common in skills; they used to
  // show up as ">" in the panel.
  it("joins folded block descriptions", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: >\n  line one\n  line two\n---\n")).toEqual({
      name: "x",
      description: "line one line two",
    });
  });

  it("returns an empty object without frontmatter", () => {
    expect(parseFrontmatter("# just markdown")).toEqual({});
  });
});

describe("discoverClaudeConfig", () => {
  // Every project-level file type the panel lists, including the ones that
  // were missing before (CLAUDE.local.md, .mcp.json, project agents/skills).
  it("lists project instruction files, settings, .mcp.json, commands, agents and skills", async () => {
    const sub = join(repo, "pkg");
    write(join(repo, "CLAUDE.md"), "# root");
    write(join(sub, "CLAUDE.md"), "# sub");
    write(join(repo, "CLAUDE.local.md"), "# local");
    write(join(repo, "AGENTS.md"), "# agents");
    write(join(repo, ".claude", "settings.json"), "{}");
    write(join(repo, ".claude", "settings.local.json"), "{}");
    write(join(repo, ".mcp.json"), '{"mcpServers":{}}');
    write(join(repo, ".claude", "commands", "deploy.md"), "deploy");
    write(join(repo, ".claude", "commands", "git", "pr.md"), "pr");
    write(join(repo, ".claude", "commands", "notes.txt"), "ignored");
    write(join(repo, ".claude", "agents", "rev.md"), "---\nname: reviewer\n---\n");
    write(join(repo, ".claude", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lints\n---\n");

    const cfg = await discoverClaudeConfig(resolveConfigContext(sub, home));
    expect(cfg.project.root).toBe(repo);
    expect(cfg.project.cwd).toBe(sub);
    expect(cfg.project.claudeMd.map((f) => f.path)).toEqual([join(sub, "CLAUDE.md"), join(repo, "CLAUDE.md")]);
    expect(cfg.project.claudeLocalMd[0].content).toBe("# local");
    expect(cfg.project.agentsMd.map((f) => f.path)).toEqual([join(repo, "AGENTS.md")]);
    expect(cfg.project.settings?.path).toBe(join(repo, ".claude", "settings.json"));
    expect(cfg.project.settingsLocal).not.toBeNull();
    expect(cfg.project.mcpJson?.content).toContain("mcpServers");
    // Nested commands get Claude Code's namespaced name
    expect(cfg.project.commands.map((c) => c.name)).toEqual(["deploy", "git:pr"]);
    // Agents use the frontmatter name
    expect(cfg.project.agents).toEqual([{ name: "reviewer", path: join(repo, ".claude", "agents", "rev.md") }]);
    expect(cfg.project.skills).toEqual([
      { slug: "lint", name: "lint", description: "Lints", path: join(repo, ".claude", "skills", "lint", "SKILL.md") },
    ]);
  });

  // Regression for the reported bug: symlinked skill dirs (Dirent.isDirectory()
  // is false for them) and claude.ai-synced skills were invisible.
  it("follows symlinked skills and lists synced skills read-only", async () => {
    write(join(external, "audit", "SKILL.md"), "---\nname: audit\ndescription: Audits\n---\n");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(external, "audit"), join(home, ".claude", "skills", "audit"));
    symlinkSync(join(external, "missing"), join(home, ".claude", "skills", "dangling"));
    write(join(home, ".claude", "skills", "plain", "SKILL.md"), "no frontmatter");
    write(join(home, ".claude", "skills", "nodoc", "README.md"), "not a skill");
    write(join(home, ".claude", "skills", "synced", "sync-1", "pdf", "SKILL.md"), "---\nname: pdf\n---\n");
    write(join(home, ".claude", "skills", "synced", "stray.txt"), "x");

    const cfg = await discoverClaudeConfig(resolveConfigContext(repo, home));
    expect(cfg.user.skills).toEqual([
      { slug: "audit", name: "audit", description: "Audits", path: join(home, ".claude", "skills", "audit", "SKILL.md"), source: "link" },
      { slug: "pdf", name: "pdf", description: "", path: join(home, ".claude", "skills", "synced", "sync-1", "pdf", "SKILL.md"), source: "synced" },
      { slug: "plain", name: "plain", description: "", path: join(home, ".claude", "skills", "plain", "SKILL.md") },
    ]);
  });

  // Symlinked agent/command files and dirs are followed, and a symlink cycle
  // does not hang discovery.
  it("follows symlinked commands and agents without looping on cycles", async () => {
    write(join(external, "shared", "ship.md"), "ship");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    symlinkSync(join(external, "shared"), join(home, ".claude", "commands", "shared"));
    symlinkSync(join(home, ".claude", "commands"), join(home, ".claude", "commands", "loop"));
    write(join(external, "helper.md"), "helper");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    symlinkSync(join(external, "helper.md"), join(home, ".claude", "agents", "helper.md"));

    const cfg = await discoverClaudeConfig(resolveConfigContext(repo, home));
    expect(cfg.user.commands.map((c) => c.name)).toEqual(["shared:ship"]);
    expect(cfg.user.agents.map((a) => a.name)).toEqual(["helper"]);
  });

  // User-level files including the previously missing settings.local.json,
  // plus the Codex files.
  it("lists user CLAUDE.md, settings files and Codex AGENTS.md / config.toml", async () => {
    write(join(home, ".claude", "CLAUDE.md"), "# me");
    write(join(home, ".claude", "settings.json"), "{}");
    write(join(home, ".claude", "settings.local.json"), "{}");
    write(join(home, ".codex", "AGENTS.md"), "# codex");
    write(join(home, ".codex", "config.toml"), 'model = "x"\n');

    const cfg = await discoverClaudeConfig(resolveConfigContext(repo, home));
    expect(cfg.user.root).toBe(join(home, ".claude"));
    expect(cfg.user.claudeMd?.content).toBe("# me");
    expect(cfg.user.settingsLocal?.path).toBe(join(home, ".claude", "settings.local.json"));
    expect(cfg.user.codex.agentsMd?.content).toBe("# codex");
    // Node (vitest) has no Bun.TOML, so config.toml is not editable here
    expect(cfg.user.codex.config).toEqual({ path: join(home, ".codex", "config.toml"), editable: false });
  });

  it("returns empty collections when nothing exists", async () => {
    const cfg = await discoverClaudeConfig(resolveConfigContext(repo, home));
    expect(cfg.project.claudeMd).toEqual([]);
    expect(cfg.project.mcpJson).toBeNull();
    expect(cfg.user.skills).toEqual([]);
    expect(cfg.user.codex.config).toBeNull();
  });
});

describe("classifyConfigPath", () => {
  // The allow-list is what keeps the config routes from becoming a generic
  // read/write API: only the known files are accepted.
  it("accepts the known project and user config files", () => {
    const sub = join(repo, "a");
    mkdirSync(sub);
    const ctx = resolveConfigContext(sub, home);
    const md = { format: "markdown", readOnly: false };
    const json = { format: "json", readOnly: false };
    expect(classifyConfigPath(join(sub, "CLAUDE.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, ".claude", "CLAUDE.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, "CLAUDE.local.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, "AGENTS.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, ".claude", "settings.json"), ctx)).toEqual(json);
    expect(classifyConfigPath(join(repo, ".claude", "settings.local.json"), ctx)).toEqual(json);
    expect(classifyConfigPath(join(repo, ".mcp.json"), ctx)).toEqual(json);
    expect(classifyConfigPath(join(repo, ".claude", "commands", "x", "y.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, ".claude", "agents", "a.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(repo, ".claude", "skills", "s", "SKILL.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(home, ".claude", "CLAUDE.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(home, ".claude", "settings.local.json"), ctx)).toEqual(json);
    expect(classifyConfigPath(join(home, ".claude", "skills", "s", "SKILL.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(home, ".claude", "skills", "synced", "id", "s", "SKILL.md"), ctx))
      .toEqual({ format: "markdown", readOnly: true });
    expect(classifyConfigPath(join(home, ".codex", "AGENTS.md"), ctx)).toEqual(md);
    expect(classifyConfigPath(join(home, ".codex", "config.toml"), ctx)).toEqual({ format: "toml", readOnly: true });
  });

  it("rejects anything else, including traversal and look-alikes", () => {
    const ctx = resolveConfigContext(repo, home);
    expect(classifyConfigPath(join(repo, "src", "index.ts"), ctx)).toBeNull();
    expect(classifyConfigPath(join(repo, "sub", "CLAUDE.md"), ctx)).toBeNull(); // below cwd, not on the walk
    expect(classifyConfigPath(join(repo, ".claude", "commands", "..", "..", "secret.md"), ctx)).toBeNull();
    expect(classifyConfigPath(join(repo, ".claude", "commands", "x.txt"), ctx)).toBeNull();
    expect(classifyConfigPath(join(repo, ".claude", "skills", "s", "other.md"), ctx)).toBeNull();
    expect(classifyConfigPath(join(repo, ".claude", "skills", "synced", "id", "s", "SKILL.md"), ctx)).toBeNull();
    expect(classifyConfigPath(join(home, ".claude", ".claude", "CLAUDE.md"), ctx)).toBeNull();
    expect(classifyConfigPath(join(home, ".ssh", "id_rsa"), ctx)).toBeNull();
    expect(classifyConfigPath(join(home, ".codex", "auth.json"), ctx)).toBeNull();
    expect(classifyConfigPath("/etc/passwd", ctx)).toBeNull();
  });
});

describe("validateConfigContent / getTomlParser", () => {
  it("accepts valid JSON and markdown, rejects invalid JSON with a clear message", () => {
    expect(validateConfigContent("json", '{"a":1}')).toBeNull();
    expect(validateConfigContent("markdown", "anything {")).toBeNull();
    expect(validateConfigContent("json", "{oops")).toMatch(/^Invalid JSON: /);
  });

  // Under Node there is no Bun.TOML: TOML must be refused, never written unvalidated.
  it("refuses TOML when no parser is available", () => {
    expect(getTomlParser()).toBeNull();
    expect(validateConfigContent("toml", "a = 1")).toMatch(/unavailable/);
  });

  // With Bun's built-in parser present, TOML is validated through it.
  it("validates TOML with Bun.TOML.parse when present", () => {
    vi.stubGlobal("Bun", {
      TOML: {
        parse: (s: string) => {
          if (s.includes("[")) throw new Error("Unterminated array");
          return {};
        },
      },
    });
    expect(getTomlParser()).not.toBeNull();
    expect(validateConfigContent("toml", "a = 1")).toBeNull();
    expect(validateConfigContent("toml", "a = [")).toBe("Invalid TOML: Unterminated array");
    const ctx = resolveConfigContext(repo, home);
    expect(classifyConfigPath(join(home, ".codex", "config.toml"), ctx)).toEqual({ format: "toml", readOnly: false });
  });
});

describe("planNewConfigFile", () => {
  // Paths and templates for every "New…" action, per scope.
  it("plans project files at the project root with templates", () => {
    const ctx = resolveConfigContext(repo, home);
    const plan = (type: Parameters<typeof planNewConfigFile>[2], name?: string) =>
      planNewConfigFile(ctx, "project", type, name) as { path: string; content: string };
    expect(plan("claude-md").path).toBe(join(repo, "CLAUDE.md"));
    expect(plan("claude-local-md").path).toBe(join(repo, "CLAUDE.local.md"));
    expect(plan("settings").path).toBe(join(repo, ".claude", "settings.json"));
    expect(JSON.parse(plan("settings-local").content)).toHaveProperty("$schema");
    expect(JSON.parse(plan("mcp-json").content)).toEqual({ mcpServers: {} });
    expect(plan("command", "ship").path).toBe(join(repo, ".claude", "commands", "ship.md"));
    expect(plan("command", "ship").content).toMatch(/^---\ndescription:/);
    expect(plan("agent", "rev").path).toBe(join(repo, ".claude", "agents", "rev.md"));
    expect(plan("agent", "rev").content).toContain("name: rev");
    expect(plan("skill", "lint").path).toBe(join(repo, ".claude", "skills", "lint", "SKILL.md"));
    expect(plan("skill", "lint").content).toContain("name: lint");
    expect(plan("agents-md").path).toBe(join(repo, "AGENTS.md"));
  });

  it("plans user files under ~/.claude and ~/.codex", () => {
    const ctx = resolveConfigContext(repo, home);
    const p = (type: Parameters<typeof planNewConfigFile>[2], name?: string) =>
      (planNewConfigFile(ctx, "user", type, name) as { path: string }).path;
    expect(p("claude-md")).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(p("settings")).toBe(join(home, ".claude", "settings.json"));
    expect(p("settings-local")).toBe(join(home, ".claude", "settings.local.json"));
    expect(p("skill", "s1")).toBe(join(home, ".claude", "skills", "s1", "SKILL.md"));
    expect(p("agents-md")).toBe(join(home, ".codex", "AGENTS.md"));
  });

  // Names become path segments: anything that could escape the folder is refused.
  it("rejects bad names and project-only types in user scope", () => {
    const ctx = resolveConfigContext(repo, home);
    expect(planNewConfigFile(ctx, "project", "command", "../x")).toHaveProperty("error");
    expect(planNewConfigFile(ctx, "project", "agent", "")).toHaveProperty("error");
    expect(planNewConfigFile(ctx, "project", "skill", "Upper")).toHaveProperty("error");
    expect(planNewConfigFile(ctx, "user", "mcp-json")).toHaveProperty("error");
    expect(planNewConfigFile(ctx, "user", "claude-local-md")).toHaveProperty("error");
  });
});
