import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** The default state directory, and where older versions always wrote some files. */
export const LEGACY_COMPANION_HOME = join(homedir(), ".companion");

/**
 * Base directory for all Companion configuration and state.
 * Defaults to ~/.companion/ for self-hosted installs.
 * Override with the COMPANION_HOME env var to relocate it.
 */
export const COMPANION_HOME =
  process.env.COMPANION_HOME || LEGACY_COMPANION_HOME;

/**
 * Where `relPath` lived before its module honoured COMPANION_HOME (some stores
 * always wrote under ~/.companion). Returns null when that is the same place
 * as the current location, so callers only fall back when the two differ.
 * Read-only fallback: new writes always go under COMPANION_HOME.
 */
export function legacyStatePath(relPath: string, home: string = COMPANION_HOME): string | null {
  const legacy = join(LEGACY_COMPANION_HOME, relPath);
  return resolve(legacy) === resolve(join(home, relPath)) ? null : legacy;
}
