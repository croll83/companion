import { resolve } from "node:path";

/**
 * Helpers for folder-scoped resources (saved prompts, env profiles): a
 * resource scoped to a folder applies to every session whose working
 * directory is that folder or anywhere below it.
 */

/** Absolute path without trailing separators ("/" stays "/"). */
export function normalizeFolderPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "") || "/";
}

/** True when `path` equals `folder` or is nested inside it. */
export function isPathWithin(path: string, folder: string): boolean {
  const p = normalizeFolderPath(path);
  const f = normalizeFolderPath(folder);
  if (p === f) return true;
  return p.startsWith(f === "/" ? "/" : `${f}/`);
}

/** Trim, normalize and dedupe a folder list, dropping empty entries. */
export function dedupeFolders(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeFolderPath(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
