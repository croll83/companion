import { existsSync, readdirSync, realpathSync } from "node:fs";
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
 * Every group is ON unless the domain (or GLOBAL, as the default for all
 * domains) turns it off.
 */

export type SkillGroupId = "user" | "claude-ai" | "design";

export interface SkillGroup {
  id: SkillGroupId;
  label: string;
  description: string;
  /** Skill names as the user sees them. */
  skills: string[];
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

export function listSkillGroups(): SkillGroup[] {
  return [
    {
      id: "user",
      label: "Your skills",
      description: "Installed in ~/.claude/skills (on in every domain unless turned off here).",
      skills: [...userSkillDirs().keys()],
      codex: "linked",
    },
    {
      id: "claude-ai",
      label: "claude.ai skills",
      description: "Synced from your claude.ai profile (~/.claude/skills/synced).",
      skills: syncedSkillNames(),
      codex: "unsupported",
    },
    {
      id: "design",
      label: "Design skills",
      description: "The impeccable design skills (manual-only: run them with /name). Present only in the repositories that ship them.",
      skills: [...DESIGN_SKILLS],
      codex: "toggled",
    },
  ];
}

/** Whether `group` is on for a domain: its own choice, else GLOBAL's, else on. */
export function isSkillGroupOn(
  group: SkillGroupId,
  domain: { skillGroups?: Record<string, boolean> } | undefined,
  global: { skillGroups?: Record<string, boolean> } | undefined,
): boolean {
  return domain?.skillGroups?.[group] ?? global?.skillGroups?.[group] ?? true;
}

/** Claude `skillOverrides` turning off every skill of the groups that are off. */
export function claudeSkillOverrides(off: ReadonlySet<SkillGroupId>, groups = listSkillGroups()): Record<string, "off"> {
  const out: Record<string, "off"> = {};
  for (const g of groups) {
    if (!off.has(g.id)) continue;
    for (const name of g.skills) out[g.id === "claude-ai" ? `anthropic-skills:${name}` : name] = "off";
  }
  return out;
}
