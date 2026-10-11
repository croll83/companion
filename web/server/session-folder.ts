import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Moving a live session to another working folder.
 *
 * Claude Code finds a conversation by its session id from any folder
 * (`--resume <id>` works after a cwd change — verified on CLI 2.1.293), so the
 * transcript stays where it is. What does change with the folder is everything
 * Claude Code scopes to it: project CLAUDE.md, project skills and settings,
 * and its auto-memory, which lives in ~/.claude/projects/<folder>/memory. That
 * last one is easy to miss, so the preview reports it before the move.
 */

/** Claude Code's project directory name for a folder: every non-alphanumeric becomes "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

export interface FolderMemory {
  dir: string;
  notes: number;
}

/** The auto-memory a Claude session started in `cwd` reads and writes. */
export function claudeMemoryFor(cwd: string, projectsRoot = claudeProjectsRoot()): FolderMemory {
  const dir = join(projectsRoot, claudeProjectDirName(cwd), "memory");
  let notes = 0;
  try {
    notes = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
  } catch {
    // No memory yet for this folder.
  }
  return { dir, notes };
}

/** Validate a requested folder: absolute, existing directory. Returns the normalized path. */
export function validateTargetFolder(raw: unknown): { ok: true; cwd: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "Folder is required" };
  const trimmed = raw.trim();
  if (!isAbsolute(trimmed)) return { ok: false, error: "Folder must be an absolute path" };
  const cwd = resolve(trimmed);
  if (!existsSync(cwd)) return { ok: false, error: `Folder does not exist: ${cwd}` };
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, error: `Not a folder: ${cwd}` };
  } catch {
    return { ok: false, error: `Folder is not accessible: ${cwd}` };
  }
  return { ok: true, cwd };
}
