/**
 * Bun runtime version check.
 *
 * Bun < 1.4 has a subprocess-stream bug (oven-sh/bun#32743) that can close
 * the stdout pipe of the wrong child process, so a live CLI session's stdout
 * hits EOF and the session dies mid-work.
 *
 * The auto-updater only replaces Companion's own files — it never touches the
 * Bun runtime — so a user can be on the latest Companion and still run the
 * buggy Bun. Because an update always ends with a service restart on the same
 * Bun binary, checking at startup doubles as a "post-update" check.
 *
 * Surfaced in two places:
 *   - a one-time console warning at server startup (warnIfBunOutdated)
 *   - GET /api/system/bun-runtime-check, which drives the BunRuntimeAlert banner
 *
 * We never try to upgrade Bun automatically; the banner just tells the user
 * to run `bun upgrade` and restart Companion.
 */
import { isNewerVersion } from "./update-checker.js";

/** Oldest Bun release that is not affected by oven-sh/bun#32743. */
export const MIN_BUN_VERSION = "1.4.0";

/**
 * - "ok":       the running Bun is >= MIN_BUN_VERSION
 * - "outdated": the running Bun is older than MIN_BUN_VERSION
 * - "unknown":  the version could not be read or parsed. We deliberately
 *               report ok=true in that case: nagging users about a version we
 *               can't even read would be noise, not signal.
 */
export type BunRuntimeCheckReason = "ok" | "outdated" | "unknown";

export interface BunRuntimeCheckResult {
  version: string | null;
  minimum: string;
  ok: boolean;
  reason: BunRuntimeCheckReason;
}

// "1.4.2", "v1.4.2", "1.4.2-canary.20261003.1", "1.4.2+abcdef"
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * Pure comparison of a Bun version string against MIN_BUN_VERSION.
 *
 * Prerelease / build suffixes (e.g. "-canary.20261003.1") are ignored and only
 * the major.minor.patch core is compared, so "1.4.2-canary.20261003.1" counts
 * as 1.4.2. Strict semver would rank "1.4.0-canary" below 1.4.0; we'd rather
 * not nag on such an ambiguous build than nag wrongly.
 */
export function evaluateBunVersion(version: string | null | undefined): BunRuntimeCheckResult {
  const raw = typeof version === "string" ? version.trim() : "";
  const match = VERSION_RE.exec(raw);
  if (!match) {
    return { version: raw || null, minimum: MIN_BUN_VERSION, ok: true, reason: "unknown" };
  }
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  const outdated = isNewerVersion(MIN_BUN_VERSION, core);
  return {
    version: raw,
    minimum: MIN_BUN_VERSION,
    ok: !outdated,
    reason: outdated ? "outdated" : "ok",
  };
}

/** Version of the Bun runtime executing this process, or null when not on Bun. */
export function getRuntimeBunVersion(): string | null {
  return typeof Bun !== "undefined" && typeof Bun.version === "string" ? Bun.version : null;
}

/** Check the Bun runtime this server is running on. */
export function checkBunRuntime(): BunRuntimeCheckResult {
  return evaluateBunVersion(getRuntimeBunVersion());
}

/**
 * Log a clear warning when the running Bun is too old. Called once at startup.
 * Returns the check result so callers (and tests) can inspect it.
 */
export function warnIfBunOutdated(
  result: BunRuntimeCheckResult = checkBunRuntime(),
  log: (msg: string) => void = console.warn,
): BunRuntimeCheckResult {
  if (!result.ok) {
    log(
      `[server] WARNING: running on Bun ${result.version}; Bun < ${result.minimum} has a subprocess-stream bug ` +
        `(oven-sh/bun#32743) that can drop live sessions. Companion's auto-update does not upgrade Bun. Run:\n` +
        `  bun upgrade\nthen restart Companion (service mode: the-companion restart).`,
    );
  }
  return result;
}
