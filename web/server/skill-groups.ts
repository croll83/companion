import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Skill groups a domain can turn on or off, like its MCP servers.
 *
 * These skills are installed outside the domain (Claude Code loads them for
 * every session), so a domain cannot simply leave them out. What works for
 * both CLIs without touching ~/.claude:
 *  - Claude Code: the `skillOverrides` setting passed in the spawn's
 *    `--settings` JSON (`{"<skill>": "off"}` removes it for the model and the
 *    user; verified on CLI 2.1.293 for user, project and synced skills —
 *    synced ones are keyed `anthropic-skills:<name>`; a bare name would also
 *    hit a same-named bundled skill).
 *  - Codex: it never reads ~/.claude/skills, so the "user" group is linked
 *    into the session's CODEX_HOME/skills only when on; repository skills it
 *    finds by itself (the design group in .agents/skills) are turned off with
 *    `[[skills.config]] name = … enabled = false` in config.toml (verified on
 *    Codex 0.161 with skills/list). The claude.ai group depends on claude.ai
 *    connectors and is Claude-only.
 *
 * Every skill is ON unless turned off: a single skill can be chosen on its
 * own (`skillChoices`, keyed "<group>:<name>"), which wins over its group's
 * choice; the domain's choices win over GLOBAL's (the default for every
 * domain). See isSkillOn.
 */

export type SkillGroupId = "user" | "claude-ai" | "design";

export interface SkillGroup {
  id: SkillGroupId;
  label: string;
  description: string;
  /** Skill names as the user sees them. */
  skills: string[];
  /** One-line description of each skill (from its SKILL.md frontmatter), when known. */
  descriptions: Record<string, string>;
  /** How Codex sessions get the group (see above). */
  codex: "linked" | "toggled" | "unsupported";
}

/**
 * The impeccable design skills of the companion-fork repository
 * (`.agents/skills`, linked from `.claude/skills`). They are manual-only
 * (`disable-model-invocation: true`): /name still runs them.
 */
export const DESIGN_SKILLS = [
  "adapt", "animate", "audit", "bolder", "clarify", "colorize", "critique", "delight", "distill",
  "extract", "frontend-design", "harden", "normalize", "onboard", "optimize", "polish", "quieter",
  "teach-impeccable",
] as const;

/** Claude Code's config folder (CLAUDE_CONFIG_DIR, like the CLI), read at every call. */
export function claudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function skillDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

/** The user's own skills (~/.claude/skills/<name>, synced ones excluded), name → real folder. */
export function userSkillDirs(): Map<string, string> {
  const dir = join(claudeConfigHome(), "skills");
  const out = new Map<string, string>();
  for (const name of skillDirs(dir)) {
    if (name === "synced") continue;
    try {
      out.set(name, realpathSync(join(dir, name)));
    } catch {
      /* dangling link */
    }
  }
  return out;
}

/** Skills synced from the claude.ai profile (~/.claude/skills/synced/<sync-id>/<name>). */
export function syncedSkillNames(): string[] {
  const root = join(claudeConfigHome(), "skills", "synced");
  const names = new Set<string>();
  let syncIds: string[] = [];
  try {
    syncIds = readdirSync(root);
  } catch {
    return [];
  }
  for (const id of syncIds) for (const name of skillDirs(join(root, id))) names.add(name);
  return [...names].sort();
}

/** The `description:` of a SKILL.md frontmatter, on one line (empty when absent or unreadable). */
export function skillDescription(skillMd: string): string {
  try {
    const text = readFileSync(skillMd, "utf-8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const line = fm?.[1].split(/\r?\n/).find((l) => /^description:/.test(l));
    return (line ?? "").replace(/^description:\s*/, "").replace(/^["']|["']$/g, "").trim().slice(0, 240);
  } catch {
    return "";
  }
}

function describe(dirs: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, dir] of dirs) {
    const d = skillDescription(join(dir, "SKILL.md"));
    if (d) out[name] = d;
  }
  return out;
}

/** Folders of the synced claude.ai skills, name → folder. */
function syncedSkillDirs(): Map<string, string> {
  const root = join(claudeConfigHome(), "skills", "synced");
  const out = new Map<string, string>();
  let syncIds: string[] = [];
  try {
    syncIds = readdirSync(root);
  } catch {
    return out;
  }
  for (const id of syncIds) for (const name of skillDirs(join(root, id))) if (!out.has(name)) out.set(name, join(root, id, name));
  return out;
}

export function listSkillGroups(): SkillGroup[] {
  const user = userSkillDirs();
  const synced = syncedSkillDirs();
  return [
    {
      id: "user",
      label: "Your skills",
      description: "Installed in ~/.claude/skills (on in every domain unless turned off here).",
      skills: [...user.keys()],
      descriptions: describe(user),
      codex: "linked",
    },
    {
      id: "claude-ai",
      label: "claude.ai skills",
      description: "Synced from your claude.ai profile (~/.claude/skills/synced).",
      skills: [...synced.keys()].sort(),
      descriptions: describe(synced),
      codex: "unsupported",
    },
    {
      id: "design",
      label: "Design skills",
      description: "The impeccable design skills (manual-only: run them with /name). Present only in the repositories that ship them.",
      skills: [...DESIGN_SKILLS],
      descriptions: {},
      codex: "toggled",
    },
  ];
}

/** Key of a single skill in `skillChoices`. */
export function skillKey(group: SkillGroupId, name: string): string {
  return `${group}:${name}`;
}

type SkillChoices = { skillGroups?: Record<string, boolean>; skillChoices?: Record<string, boolean> };

/** Whether `group` is on for a domain as a whole: its own choice, else GLOBAL's, else on. */
export function isSkillGroupOn(group: SkillGroupId, domain: SkillChoices | undefined, global: SkillChoices | undefined): boolean {
  return domain?.skillGroups?.[group] ?? global?.skillGroups?.[group] ?? true;
}

/**
 * Whether one skill is on for a domain: the domain's choice for the skill,
 * else for its group, else GLOBAL's for the skill, else for the group, else
 * on. `domain` is undefined for GLOBAL itself.
 */
export function isSkillOn(group: SkillGroupId, name: string, domain: SkillChoices | undefined, global: SkillChoices | undefined): boolean {
  const key = skillKey(group, name);
  return domain?.skillChoices?.[key] ?? domain?.skillGroups?.[group] ?? global?.skillChoices?.[key] ?? global?.skillGroups?.[group] ?? true;
}

/** The skills turned off for a domain, as skillKey()s. */
export function disabledSkills(domain: SkillChoices | undefined, global: SkillChoices | undefined, groups = listSkillGroups()): Set<string> {
  const off = new Set<string>();
  for (const g of groups) for (const name of g.skills) if (!isSkillOn(g.id, name, domain, global)) off.add(skillKey(g.id, name));
  return off;
}

/** Claude `skillOverrides` turning off each skill that is off (synced ones keyed `anthropic-skills:<name>`). */
export function claudeSkillOverrides(off: ReadonlySet<string>, groups = listSkillGroups()): Record<string, "off"> {
  const out: Record<string, "off"> = {};
  for (const g of groups) {
    for (const name of g.skills) {
      if (off.has(skillKey(g.id, name))) out[g.id === "claude-ai" ? `anthropic-skills:${name}` : name] = "off";
    }
  }
  return out;
}
