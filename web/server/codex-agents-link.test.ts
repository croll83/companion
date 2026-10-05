// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CliLauncher } from "./cli-launcher.js";

/**
 * Codex reads global instructions from $CODEX_HOME/AGENTS.md, and every
 * Companion session runs with its own CODEX_HOME. These tests pin the link that
 * makes the user's global ~/.codex/AGENTS.md reach Companion-hosted sessions,
 * without clobbering a per-session override.
 */
describe("codex global AGENTS.md link", () => {
  let root: string;
  let legacyHome: string;
  let codexHome: string;
  let launcher: CliLauncher;

  const link = (l: CliLauncher, a: string, b: string) =>
    (l as unknown as { linkGlobalAgentsMd(a: string, b: string): void }).linkGlobalAgentsMd(a, b);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-agents-"));
    legacyHome = join(root, "legacy");
    codexHome = join(root, "session");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    launcher = new CliLauncher(3456);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("links the session AGENTS.md to the global one", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    link(launcher, codexHome, legacyHome);

    const dest = join(codexHome, "AGENTS.md");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(dest))).toBe(resolve(join(legacyHome, "AGENTS.md")));
    expect(readFileSync(dest, "utf8")).toBe("global rules");
  });

  it("later edits to the global file are seen by the session (link, not copy)", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "v1");
    link(launcher, codexHome, legacyHome);
    writeFileSync(join(legacyHome, "AGENTS.md"), "v2");

    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toBe("v2");
  });

  it("follows a global AGENTS.md that is itself a symlink (e.g. to ~/.claude/CLAUDE.md)", () => {
    // The global file is commonly shared with Claude Code through a symlink.
    writeFileSync(join(root, "CLAUDE.md"), "shared rules");
    symlinkSync(join(root, "CLAUDE.md"), join(legacyHome, "AGENTS.md"));
    link(launcher, codexHome, legacyHome);

    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toBe("shared rules");
  });

  it("leaves a real per-session AGENTS.md alone", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    writeFileSync(join(codexHome, "AGENTS.md"), "session override");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    link(launcher, codexHome, legacyHome);

    const dest = join(codexHome, "AGENTS.md");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("session override");
    // An override is a deliberate choice, not an error: no warning on every launch.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is idempotent across relaunches", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    link(launcher, codexHome, legacyHome);
    link(launcher, codexHome, legacyHome);

    expect(lstatSync(join(codexHome, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  it("repoints a link that targets somewhere else", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    writeFileSync(join(root, "elsewhere.md"), "old");
    symlinkSync(join(root, "elsewhere.md"), join(codexHome, "AGENTS.md"));
    link(launcher, codexHome, legacyHome);

    expect(resolve(readlinkSync(join(codexHome, "AGENTS.md")))).toBe(resolve(join(legacyHome, "AGENTS.md")));
  });

  it("removes a dangling link once the global file is deleted", () => {
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    link(launcher, codexHome, legacyHome);
    rmSync(join(legacyHome, "AGENTS.md"));
    link(launcher, codexHome, legacyHome);

    expect(() => lstatSync(join(codexHome, "AGENTS.md"))).toThrow();
  });

  it("does nothing when there is no global AGENTS.md", () => {
    link(launcher, codexHome, legacyHome);

    expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
  });

  it("logs and carries on when the link cannot be created", () => {
    // A filesystem error must never block the session from launching.
    writeFileSync(join(legacyHome, "AGENTS.md"), "global rules");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rmSync(codexHome, { recursive: true, force: true }); // dest dir missing → symlink fails

    expect(() => link(launcher, codexHome, legacyHome)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to link AGENTS.md"), expect.anything());
    warn.mockRestore();
  });
});
