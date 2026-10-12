import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  GLOBAL_DOMAIN,
  countMemoryNotes,
  domainDir,
  ensureDomainLayout,
  ensureGlobalDomain,
  getDomain,
  isValidSlug,
  slugify,
} from "./domain-store.js";

/**
 * Where a session runs: picking its folder at creation (a new folder inside
 * its domain, or an existing folder attached as is) and moving a live
 * session to another folder ("Change folder").
 *
 * Claude Code finds a conversation by its session id from any folder
 * (`--resume <id>` works after a cwd change — verified on CLI 2.1.293), so the
 * transcript stays where it is. What changes with the folder is everything
 * Claude Code scopes to it: project CLAUDE.md, project skills and settings,
 * and — for sessions without a domain — its auto-memory, which defaults to
 * ~/.claude/projects/<sanitized git root or folder>/memory. A legacy session
 * keeps that memory across a move: the folder is pinned (`autoMemoryDirectory`).
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

export function memoryAt(dir: string): FolderMemory {
  return { dir, notes: countMemoryNotes(dir) };
}

/**
 * The folder Claude Code keys a project's default auto-memory on: the main
 * repository root when `cwd` is inside git (a linked worktree shares its main
 * repo's memory), else `cwd` itself.
 */
export function claudeMemoryRoot(cwd: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    if (common && basename(common) === ".git") return dirname(common);
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

/** The default auto-memory folder of a Claude session started in `cwd` (no domain, no pin). */
export function defaultClaudeMemoryDir(cwd: string, projectsRoot = claudeProjectsRoot()): string {
  return join(projectsRoot, claudeProjectDirName(claudeMemoryRoot(cwd)), "memory");
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

export interface NewSessionPlacementRequest {
  domain?: unknown;
  /** "new": create `<domain folder>/<folderName>`; "existing": attach `cwd` as is. */
  folderMode?: unknown;
  folderName?: unknown;
  cwd?: unknown;
}

export type NewSessionPlacement =
  | { ok: true; domain: string; cwd?: string; created?: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * The domain and folder of a session being created. Without `folderMode`
 * (older clients) `cwd` is used as given, like before domains.
 */
export function resolveNewSessionPlacement(body: NewSessionPlacementRequest): NewSessionPlacement {
  let domain = GLOBAL_DOMAIN;
  if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
    if (!isValidSlug(body.domain)) return { ok: false, status: 400, error: "Invalid domain" };
    domain = body.domain;
  }
  const info = domain === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(domain);
  if (!info) return { ok: false, status: 404, error: `Domain not found: ${domain}` };

  if (body.folderMode === "new") {
    const name = typeof body.folderName === "string" ? slugify(body.folderName) : "";
    if (!name) return { ok: false, status: 400, error: "A name for the new folder is required (letters or digits)" };
    ensureDomainLayout(info);
    const cwd = join(domainDir(domain), name);
    if (existsSync(cwd)) {
      return { ok: false, status: 409, error: `${cwd} already exists: choose another name, or attach it as an existing folder` };
    }
    mkdirSync(cwd, { recursive: true });
    return { ok: true, domain, cwd, created: true };
  }
  if (body.folderMode === "existing") {
    const target = validateTargetFolder(body.cwd);
    if (!target.ok) return { ok: false, status: 400, error: target.error };
    return { ok: true, domain, cwd: target.cwd };
  }
  if (body.folderMode !== undefined) return { ok: false, status: 400, error: "folderMode must be \"new\" or \"existing\"" };
  return { ok: true, domain, ...(typeof body.cwd === "string" && body.cwd ? { cwd: body.cwd } : {}) };
}
