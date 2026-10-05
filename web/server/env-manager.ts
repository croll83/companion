import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { dedupeFolders, isPathWithin, normalizeFolderPath } from "./path-scope.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Where an env profile applies automatically:
 * - "global": every session.
 * - "project": sessions whose cwd is one of `folders` or below one of them.
 * A profile with no scope (created before scopes existed) is "unassigned":
 * it is never applied automatically, only when picked explicitly.
 */
export type EnvScope = "global" | "project";

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;
  /** Undefined = unassigned (legacy profile, applied only when chosen explicitly). */
  scope?: EnvScope;
  /** Project folders (absolute, normalized). Only meaningful when scope === "project". */
  folders?: string[];

  createdAt: number;
  updatedAt: number;
}

/** Fields that can be updated via the update API */
export interface EnvUpdateFields {
  name?: string;
  variables?: Record<string, string>;
  scope?: EnvScope;
  folders?: string[];
}

/** Scope placement accepted at creation. Omitting `scope` creates an unassigned profile. */
export interface EnvPlacement {
  scope?: EnvScope;
  folders?: string[];
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const ENVS_DIR = join(COMPANION_HOME, "envs");
/** Env profiles hold secrets: owner-only directory and files. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Create the envs dir if needed and tighten the modes of the dir and of every
 * profile already in it. Profiles written by older versions were created with
 * the default umask (often world-readable), so each write repairs them.
 */
function ensureDirForWrite(): void {
  mkdirSync(ENVS_DIR, { recursive: true, mode: DIR_MODE });
  try { chmodSync(ENVS_DIR, DIR_MODE); } catch { /* best effort */ }
  try {
    for (const file of readdirSync(ENVS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try { chmodSync(join(ENVS_DIR, file), FILE_MODE); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

/** Validate that a slug contains only safe characters (prevents path traversal) */
function validateSlug(slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Invalid slug: must contain only lowercase alphanumeric characters and hyphens");
  }
}

function filePath(slug: string): string {
  validateSlug(slug);
  return join(ENVS_DIR, `${slug}.json`);
}

function writeEnvFile(env: CompanionEnv): void {
  const path = filePath(env.slug);
  writeFileSync(path, JSON.stringify(env, null, 2), { encoding: "utf-8", mode: FILE_MODE });
  // `mode` only applies when the file is created; fix pre-existing files too.
  chmodSync(path, FILE_MODE);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validate a scope/folders pair and return the normalized placement to store.
 * Global profiles never keep folders; project profiles need at least one.
 */
function normalizePlacement(scope: EnvScope | undefined, folders: string[] | undefined): EnvPlacement {
  if (scope === undefined) return {};
  if (scope !== "global" && scope !== "project") throw new Error("Invalid environment scope");
  if (scope === "global") return { scope };
  const normalized = dedupeFolders(folders ?? []);
  if (normalized.length === 0) {
    throw new Error("Select at least one project folder for a project environment");
  }
  return { scope, folders: normalized };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export function listEnvs(): CompanionEnv[] {
  if (!existsSync(ENVS_DIR)) return [];
  try {
    const files = readdirSync(ENVS_DIR).filter((f) => f.endsWith(".json"));
    const envs: CompanionEnv[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(ENVS_DIR, file), "utf-8");
        envs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    envs.sort((a, b) => a.name.localeCompare(b.name));
    return envs;
  } catch {
    return [];
  }
}

export function getEnv(slug: string): CompanionEnv | null {
  try {
    const raw = readFileSync(filePath(slug), "utf-8");
    return JSON.parse(raw) as CompanionEnv;
  } catch {
    return null;
  }
}

export function createEnv(
  name: string,
  variables: Record<string, string> = {},
  placement: EnvPlacement = {},
): CompanionEnv {
  if (!name || !name.trim()) throw new Error("Environment name is required");
  const slug = slugify(name.trim());
  if (!slug) throw new Error("Environment name must contain alphanumeric characters");
  const normalizedPlacement = normalizePlacement(placement.scope, placement.folders);

  ensureDirForWrite();
  if (existsSync(filePath(slug))) {
    throw new Error(`An environment with a similar name already exists ("${slug}")`);
  }

  const now = Date.now();
  const env: CompanionEnv = {
    name: name.trim(),
    slug,
    variables,
    ...normalizedPlacement,
    createdAt: now,
    updatedAt: now,
  };

  writeEnvFile(env);
  return env;
}

export function updateEnv(
  slug: string,
  updates: EnvUpdateFields,
): CompanionEnv | null {
  const existing = getEnv(slug);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newSlug = slugify(newName);
  if (!newSlug) throw new Error("Environment name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different env
  if (newSlug !== slug && existsSync(filePath(newSlug))) {
    throw new Error(`An environment with a similar name already exists ("${newSlug}")`);
  }

  // Scope: an explicit update wins; otherwise keep what is stored (including
  // "unassigned"). Folders alone may be updated on a project profile.
  const scopeTouched = updates.scope !== undefined || updates.folders !== undefined;
  const placement = scopeTouched
    ? normalizePlacement(updates.scope ?? existing.scope, updates.folders ?? existing.folders)
    : { scope: existing.scope, folders: existing.folders };

  const env: CompanionEnv = {
    name: newName,
    slug: newSlug,
    variables: updates.variables ?? existing.variables,
    ...(placement.scope ? { scope: placement.scope } : {}),
    ...(placement.scope === "project" && placement.folders ? { folders: placement.folders } : {}),
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  ensureDirForWrite();
  // If slug changed, delete old file
  if (newSlug !== slug) {
    try { unlinkSync(filePath(slug)); } catch { /* ok */ }
  }

  writeEnvFile(env);
  return env;
}

export function deleteEnv(slug: string): boolean {
  if (!existsSync(filePath(slug))) return false;
  try {
    unlinkSync(filePath(slug));
    return true;
  } catch {
    return false;
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolvedEnvProfiles {
  /** Profiles in application order (later ones override earlier ones). */
  profiles: CompanionEnv[];
  /** Merged variables of `profiles`. */
  variables: Record<string, string>;
  /** True when an explicit slug was requested but no such profile exists. */
  missingExplicit: boolean;
}

/** Length of the deepest folder of `env` that contains one of `paths`, or -1. */
function matchSpecificity(env: CompanionEnv, paths: string[]): number {
  let best = -1;
  for (const folder of env.folders ?? []) {
    if (paths.some((p) => isPathWithin(p, folder))) {
      best = Math.max(best, normalizeFolderPath(folder).length);
    }
  }
  return best;
}

/**
 * Pick the env profiles that apply to a session and merge them, in order:
 *   1. global profiles (by name),
 *   2. project profiles matching one of `paths`, least to most specific folder,
 *   3. the explicitly chosen profile (`explicitSlug`), whatever its scope.
 * Unassigned profiles are only ever applied through `explicitSlug`.
 *
 * `paths` holds the session cwd plus, for worktree sessions, the main repo
 * root (worktrees live under ~/.companion/worktrees, outside the project).
 */
export function resolveEnvProfiles(opts: { paths: string[]; explicitSlug?: string }): ResolvedEnvProfiles {
  const paths = opts.paths.filter(Boolean);
  const all = listEnvs().filter((e) => e.slug !== opts.explicitSlug);

  const globals = all.filter((e) => e.scope === "global");
  const projects = all
    .filter((e) => e.scope === "project")
    .map((env) => ({ env, specificity: matchSpecificity(env, paths) }))
    .filter((m) => m.specificity >= 0)
    .sort((a, b) => a.specificity - b.specificity || a.env.name.localeCompare(b.env.name))
    .map((m) => m.env);

  const profiles = [...globals, ...projects];
  let missingExplicit = false;
  if (opts.explicitSlug) {
    const explicit = getEnv(opts.explicitSlug);
    if (explicit) profiles.push(explicit);
    else missingExplicit = true;
  }

  const variables: Record<string, string> = {};
  for (const profile of profiles) Object.assign(variables, profile.variables);
  return { profiles, variables, missingExplicit };
}
