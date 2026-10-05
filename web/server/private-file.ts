import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Owner-only files for state that holds secrets (env profiles, agents with
 * env values and webhook secrets, wake-ups, settings with API tokens, Linear
 * OAuth credentials). Older versions wrote them with the default umask,
 * often world-readable in a group-writable directory, so every write also
 * repairs the mode of what is already there.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create `dir` owner-only and tighten its mode if it already existed. With
 * `fileSuffix`, also tighten every file in it ending with that suffix.
 * Mode fixes are best effort: a failure never blocks the write that follows.
 */
export function ensurePrivateDir(dir: string, opts: { fileSuffix?: string } = {}): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try { chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* best effort */ }
  if (opts.fileSuffix === undefined) return;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(opts.fileSuffix)) continue;
      try { chmodSync(join(dir, file), PRIVATE_FILE_MODE); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

/**
 * Write `content` to `path` readable by its owner only. `mode` applies only
 * when the file is created, so an existing file's mode is fixed as well.
 */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}
