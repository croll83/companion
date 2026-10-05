import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CliLauncher, ForkSource } from "./cli-launcher.js";
import type { BackendType } from "./session-types.js";
import { claudeTranscriptExists } from "./claude-session-history.js";
import { resolveCompanionCodexSessionHome } from "./codex-home.js";

/** Deepest directory level searched under a Codex home's sessions/ (YYYY/MM/DD). */
const ROLLOUT_SEARCH_DEPTH = 4;
/** `rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl` */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

/**
 * Find a Codex thread's rollout file in a CODEX_HOME. Codex writes them as
 * `sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`.
 */
export function findCodexRolloutPath(codexHome: string, threadId: string): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && ROLLOUT_NAME.exec(entry.name)?.[1] === threadId) {
        return join(dir, entry.name);
      }
    }
    if (depth >= ROLLOUT_SEARCH_DEPTH) return null;
    // Newest first: recent dates are the likely place.
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const name of dirs) {
      const found = walk(join(dir, name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(join(codexHome, "sessions"), 1);
}

export type ForkSourceResult =
  | { ok: true; source: ForkSource; cwd: string }
  | { ok: false; error: string };

/**
 * Check that a session can be forked by a new `backendType` session and
 * describe it for the launcher. Fails with a user-readable reason when the
 * source is gone, on the other backend, has no conversation yet, or its
 * transcript (Claude) / rollout (Codex) is no longer on disk. The fork runs
 * in the source's folder, which must still exist.
 */
export function resolveForkSource(
  launcher: Pick<CliLauncher, "getSession">,
  sourceSessionId: string | undefined,
  backendType: BackendType,
  opts: { codexHome?: string; claudeProjectsRoot?: string } = {},
): ForkSourceResult {
  if (!sourceSessionId) return { ok: false, error: "No source session to fork is set" };
  const info = launcher.getSession(sourceSessionId);
  if (!info) return { ok: false, error: `Source session ${sourceSessionId} no longer exists` };
  const sourceBackend = info.backendType ?? "claude";
  if (sourceBackend !== backendType) {
    return {
      ok: false,
      error: `Source session ${sourceSessionId} is a ${sourceBackend === "codex" ? "Codex" : "Claude Code"} session; a ${backendType === "codex" ? "Codex" : "Claude Code"} agent cannot fork it`,
    };
  }
  if (!info.cliSessionId) {
    return { ok: false, error: `Source session ${sourceSessionId} has no conversation to fork yet` };
  }
  if (!existsSync(info.cwd)) {
    return { ok: false, error: `The folder of source session ${sourceSessionId} (${info.cwd}) no longer exists` };
  }

  if (backendType === "codex") {
    const home = resolveCompanionCodexSessionHome(sourceSessionId, opts.codexHome);
    const rolloutPath = findCodexRolloutPath(home, info.cliSessionId);
    if (!rolloutPath) {
      return {
        ok: false,
        error: `The conversation of source session ${sourceSessionId} can no longer be resumed: Codex thread ${info.cliSessionId} has no rollout in ${home}`,
      };
    }
    return { ok: true, cwd: info.cwd, source: { sessionId: sourceSessionId, cliSessionId: info.cliSessionId, rolloutPath } };
  }

  if (!claudeTranscriptExists(info.cliSessionId, opts.claudeProjectsRoot)) {
    return {
      ok: false,
      error: `The conversation of source session ${sourceSessionId} can no longer be resumed: Claude transcript ${info.cliSessionId} is not on disk`,
    };
  }
  return { ok: true, cwd: info.cwd, source: { sessionId: sourceSessionId, cliSessionId: info.cliSessionId } };
}
