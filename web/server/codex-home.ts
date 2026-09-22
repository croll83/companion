import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMPANION_HOME } from "./paths.js";

export const DEFAULT_COMPANION_CODEX_HOME = join(
  COMPANION_HOME,
  "codex-home",
);

export function getLegacyCodexHome(): string {
  return join(homedir(), ".codex");
}

export function resolveCompanionCodexHome(explicitCodexHome?: string): string {
  // Intentionally do NOT fall back to process.env.CODEX_HOME here.
  // That env var points to the user's global Codex home (~/.codex), which
  // would break per-session isolation by nesting session dirs inside it.
  return resolve(explicitCodexHome || DEFAULT_COMPANION_CODEX_HOME);
}

export function resolveCompanionCodexSessionHome(
  sessionId: string,
  explicitCodexHome?: string,
): string {
  return join(resolveCompanionCodexHome(explicitCodexHome), sessionId);
}

/**
 * When the credentials in a Codex auth.json were last rotated, as epoch ms.
 *
 * Used to pick the surviving copy when a session home still holds a real
 * auth.json instead of the shared symlink. Falls back to 0 so an unreadable or
 * tokenless file never wins over one we can actually parse.
 */
export function authRefreshedAt(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { last_refresh?: unknown };
    const ts = typeof parsed.last_refresh === "string" ? Date.parse(parsed.last_refresh) : NaN;
    return Number.isNaN(ts) ? 0 : ts;
  } catch {
    return 0;
  }
}
