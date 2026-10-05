import type { BackendType } from "./session-types.js";
import { resolveEnvProfiles } from "./env-manager.js";
import { getSettings } from "./settings-manager.js";
import { getConnection } from "./linear-connections.js";

/**
 * Everything needed to rebuild a session's CLI environment from disk.
 * Only references (slug, connection id) live on the persisted session info;
 * the values are re-read here at every spawn and relaunch, so a server restart
 * never loses them and an edited profile takes effect on the next relaunch.
 */
export interface SessionEnvContext {
  cwd: string;
  /** Main repo root of a worktree session (matches project-scoped profiles). */
  repoRoot?: string;
  backendType?: BackendType;
  /** Explicitly chosen env profile. */
  envSlug?: string;
  /** Linear connection whose API key becomes LINEAR_API_KEY. */
  linearConnectionId?: string;
  /** Env passed with the create request / agent config (highest precedence). */
  requestEnv?: Record<string, string>;
}

export interface ResolvedSessionEnv {
  env: Record<string, string>;
  /** Names of the env profiles applied, in application order (never values). */
  profileNames: string[];
}

/**
 * Build the env overlay for a CLI spawn. Precedence, lowest to highest:
 * global profiles, matching project profiles (least to most specific folder),
 * the explicit profile, the request/agent env. Then the provider token from
 * global settings fills CLAUDE_CODE_OAUTH_TOKEN (Claude) or OPENAI_API_KEY
 * (Codex) only when nothing above set it, and a Linear connection's key sets
 * LINEAR_API_KEY — the same rules session creation always used.
 */
export function resolveSessionEnv(ctx: SessionEnvContext): ResolvedSessionEnv {
  const resolved = resolveEnvProfiles({
    paths: [ctx.cwd, ...(ctx.repoRoot ? [ctx.repoRoot] : [])],
    explicitSlug: ctx.envSlug,
  });
  if (resolved.missingExplicit) {
    console.warn(`[session-env] Environment "${ctx.envSlug}" not found, ignoring`);
  }

  const env: Record<string, string> = { ...resolved.variables, ...ctx.requestEnv };

  const settings = getSettings();
  const backend = ctx.backendType ?? "claude";
  if (backend === "claude" && settings.claudeCodeOAuthToken && !("CLAUDE_CODE_OAUTH_TOKEN" in env)) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken;
  }
  if (backend === "codex" && settings.openaiApiKey && !("OPENAI_API_KEY" in env)) {
    env.OPENAI_API_KEY = settings.openaiApiKey;
  }

  if (ctx.linearConnectionId) {
    const conn = getConnection(ctx.linearConnectionId);
    if (conn?.apiKey) env.LINEAR_API_KEY = conn.apiKey;
  }

  const profileNames = resolved.profiles.map((p) => p.name);
  if (profileNames.length > 0) {
    console.log(
      `[session-env] Applying env profile(s) ${profileNames.map((n) => `"${n}"`).join(", ")} ` +
      `(${Object.keys(resolved.variables).length} vars): ${Object.keys(resolved.variables).join(", ")}`,
    );
  }
  return { env, profileNames };
}
