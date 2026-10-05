import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Returns true when Codex has a plausible auth source:
 * - explicit OpenAI auth env vars, or
 * - a `codex login` auth file at ~/.codex/auth.json.
 */
export function hasCodexAuth(envVars?: Record<string, string>): boolean {
  if (
    !!envVars?.OPENAI_API_KEY
    || !!envVars?.CODEX_API_KEY
  ) {
    return true;
  }

  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const candidates = [
    join(home, ".codex", "auth.json"),
  ];

  return candidates.some((p) => existsSync(p));
}
