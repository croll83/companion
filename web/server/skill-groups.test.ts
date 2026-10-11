import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_SKILLS,
  claudeConfigHome,
  claudeSkillOverrides,
  isSkillGroupOn,
  listSkillGroups,
  syncedSkillNames,
  userSkillDirs,
} from "./skill-groups.js";

/**
 * Skill groups a domain toggles. Discovery reads a fake Claude config folder
 * (CLAUDE_CONFIG_DIR), never the real ~/.claude.
 */

let tmp: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

function skill(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-groups-"));
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  // A user skill as a real folder, one as a link (like the pentest skills),
  // a dangling link, a folder without SKILL.md, and two synced skills.
  skill(join(tmp, "claude", "skills", "foundry-poc"));
  skill(join(tmp, "elsewhere", "ton-audit"));
  symlinkSync(join(tmp, "elsewhere", "ton-audit"), join(tmp, "claude", "skills", "ton-audit"));
  symlinkSync(join(tmp, "gone"), join(tmp, "claude", "skills", "dangling"));
  mkdirSync(join(tmp, "claude", "skills", "not-a-skill"), { recursive: true });
  skill(join(tmp, "claude", "skills", "synced", "sync-1", "pdf"));
  skill(join(tmp, "claude", "skills", "synced", "sync-1", "docs"));
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("discovery", () => {
  it("honours CLAUDE_CONFIG_DIR like the CLI", () => {
    expect(claudeConfigHome()).toBe(join(tmp, "claude"));
  });

  // Links are resolved (Codex gets a link to the real folder); synced and
  // broken entries are not user skills.
  it("lists the user's skills with their real folders", () => {
    const dirs = userSkillDirs();
    expect([...dirs.keys()]).toEqual(["foundry-poc", "ton-audit"]);
    expect(dirs.get("ton-audit")).toBe(join(tmp, "elsewhere", "ton-audit"));
  });

  it("lists claude.ai synced skills", () => {
    expect(syncedSkillNames()).toEqual(["docs", "pdf"]);
  });

  it("returns empty lists without a Claude config folder", () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, "none");
    expect(userSkillDirs().size).toBe(0);
    expect(syncedSkillNames()).toEqual([]);
  });

  it("describes the three groups and how Codex gets them", () => {
    const groups = listSkillGroups();
    expect(groups.map((g) => [g.id, g.codex])).toEqual([["user", "linked"], ["claude-ai", "unsupported"], ["design", "toggled"]]);
    expect(groups[0].skills).toEqual(["foundry-poc", "ton-audit"]);
    expect(groups[2].skills).toEqual([...DESIGN_SKILLS]);
    expect(DESIGN_SKILLS).toHaveLength(18);
  });
});

describe("toggles", () => {
  // Every group is on unless the domain, or GLOBAL as the default, turns it off.
  it("resolves a group's state: domain, then GLOBAL, then on", () => {
    expect(isSkillGroupOn("user", undefined, undefined)).toBe(true);
    expect(isSkillGroupOn("user", {}, { skillGroups: { user: false } })).toBe(false);
    expect(isSkillGroupOn("user", { skillGroups: { user: true } }, { skillGroups: { user: false } })).toBe(true);
    expect(isSkillGroupOn("design", { skillGroups: { design: false } }, undefined)).toBe(false);
  });

  // Synced skills are keyed with their plugin prefix: a bare name would also
  // turn off a bundled skill with the same name (verified on CLI 2.1.293).
  it("builds Claude skillOverrides for the groups that are off", () => {
    expect(claudeSkillOverrides(new Set())).toEqual({});
    expect(claudeSkillOverrides(new Set(["user", "claude-ai"]))).toEqual({
      "foundry-poc": "off",
      "ton-audit": "off",
      "anthropic-skills:docs": "off",
      "anthropic-skills:pdf": "off",
    });
    expect(Object.keys(claudeSkillOverrides(new Set(["design"])))).toEqual([...DESIGN_SKILLS]);
  });
});
