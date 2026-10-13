import { GLOBAL_DOMAIN, effectiveBrainSlug, updateDomainsAtomically, type DomainInfo, type McpServerDef } from "../domain-store.js";
import { isPluginOn, type InstalledPlugin } from "../claude-plugins.js";
import {
  brainServerName,
  brainSkillDir,
  brainUrls,
  ensureBrainPlugin,
  getBrain,
  readBrainToken,
  sameUrl,
  type BrainConfig,
} from "./brain-store.js";

/**
 * How a domain's brain reaches its sessions (used by domain-runtime.ts):
 *
 *  - Claude: an HTTP server `<slug>-brain` added LAST to the generated
 *    --mcp-config (0600, so a bearer token is written there as a literal
 *    `Authorization` header), and `--plugin-dir <brain>/plugin` for its skill.
 *    Claude also receives the server's MCP instructions.
 *    An OAuth brain gets Claude's `oauth: {clientId, callbackPort?}` instead.
 *  - Codex: the same server as a `[mcp_servers.<slug>-brain]` table added LAST.
 *    Per-session CODEX_HOME folders are not private (0775), so the token is
 *    never written there: the table names an env var
 *    (`bearer_token_env_var = "COMPANION_BRAIN_<SLUG>_TOKEN"`) that is set on
 *    the Codex process. Codex does not show MCP server instructions to the
 *    model (verified on 0.161), so the skill is linked into CODEX_HOME/skills
 *    and the generated AGENTS.md names the brain. An OAuth brain gets
 *    `[mcp_servers.<slug>-brain.oauth] client_id` (codexMcpTable).
 *
 * OAuth tokens are never Companion's: each CLI signs in once from a session's
 * MCP panel (Claude mcp_authenticate, Codex mcpServer/oauth/login) and keeps
 * them in its own store, shared by all its sessions.
 *
 * A marketplace plugin serving the same MCP URL "collides" with the brain:
 * where the brain is on, the plugin is forced off (Claude) or skipped (Codex),
 * so no tool shows up twice under two names.
 */

export interface DomainBrain {
  brain: BrainConfig;
  /** `<slug>-brain`: MCP server and skill name, both CLIs. */
  serverName: string;
  mcpUrl: string;
  /** The generated plugin folder (`--plugin-dir`). */
  pluginDir: string;
  /** The skill folder inside it (linked for Codex). */
  skillDir: string;
  /** Bearer token, when the brain uses one and it is set. Never sent to the browser. */
  token?: string;
  /** The env var Codex reads the token from. */
  tokenEnvVar: string;
  /** Pre-registered OAuth client, when the brain uses OAuth. */
  oauth?: { clientId: string; callbackPort?: number };
  /** Whether the domain chose the brain itself (false: GLOBAL's default). */
  own: boolean;
}

/** `COMPANION_BRAIN_<SLUG>_TOKEN`, the slug upper-cased with "-" as "_". */
export function brainTokenEnvVar(slug: string): string {
  return `COMPANION_BRAIN_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;
}

/**
 * The brain of a domain (its own choice, else GLOBAL's), ready for a spawn:
 * plugin generated if missing, token read. Null when none, or when the brain
 * named no longer exists (a hand-edited registry; a deleted brain is cleared
 * from every domain).
 */
export function brainForDomain(r: { domain: DomainInfo; global: DomainInfo; isGlobal: boolean }): DomainBrain | null {
  const own = r.isGlobal ? undefined : r.domain;
  const slug = effectiveBrainSlug(own, r.global);
  if (!slug) return null;
  const brain = getBrain(slug);
  if (!brain) {
    console.warn(`[brain-runtime] Domain "${r.domain.slug}" uses brain "${slug}", which does not exist: skipped`);
    return null;
  }
  const auth = brain.remote?.auth;
  const token = auth?.mode === "bearer" ? readBrainToken(slug) : undefined;
  if (brain.remote?.auth.mode === "bearer" && !token) {
    console.warn(`[brain-runtime] Brain "${slug}" uses a bearer token but none is set: connecting without it`);
  }
  return {
    brain,
    serverName: brainServerName(slug),
    mcpUrl: brainUrls(brain).mcpUrl,
    pluginDir: ensureBrainPlugin(brain),
    skillDir: brainSkillDir(slug),
    ...(token ? { token } : {}),
    tokenEnvVar: brainTokenEnvVar(slug),
    ...(auth?.mode === "oauth" ? { oauth: { clientId: auth.clientId, ...(auth.callbackPort ? { callbackPort: auth.callbackPort } : {}) } } : {}),
    own: r.isGlobal || r.domain.brain !== undefined,
  };
}

/**
 * The brain's server in Claude's --mcp-config: the token as a literal header
 * (that file is 0600), or the pre-registered OAuth client (Claude's format,
 * verified on CLI 2.1.293).
 */
export function claudeBrainServer(b: DomainBrain): McpServerDef {
  return {
    type: "http",
    url: b.mcpUrl,
    ...(b.token ? { headers: { Authorization: `Bearer ${b.token}` } } : {}),
    ...(b.oauth ? { oauth: { ...b.oauth } } : {}),
  };
}

/**
 * The brain's server for Codex: the token as `Bearer ${VAR}`, which
 * codexMcpTable turns into `bearer_token_env_var`, never a literal value.
 */
export function codexBrainServer(b: DomainBrain): McpServerDef {
  return {
    type: "http",
    url: b.mcpUrl,
    ...(b.token ? { headers: { Authorization: `Bearer \${${b.tokenEnvVar}}` } } : {}),
    // codexMcpTable writes only the client id: Codex picks its own callback port.
    ...(b.oauth ? { oauth: { clientId: b.oauth.clientId } } : {}),
  };
}

/** Env for a Codex spawn: the token under the variable codexBrainServer names. */
export function codexBrainEnv(b: DomainBrain | null): Record<string, string> {
  return b?.token ? { [b.tokenEnvVar]: b.token } : {};
}

/** Env var names Companion gives Codex for brains (their values are tokens). */
export const BRAIN_ENV_PATTERN = "COMPANION_BRAIN_*";

/**
 * The `-c` override that keeps brain tokens out of the commands Codex runs.
 * Codex passes its own environment to shell commands (verified on 0.161: an
 * `echo $COMPANION_BRAIN_…_TOKEN` printed it), while only the Codex process
 * needs the token for the MCP header. `shell_environment_policy.exclude`
 * hides it (verified); a `-c` replaces the array, so the patterns already in
 * the session's config.toml are kept. Codex's default excludes still apply.
 */
export function codexShellExcludeOverride(configToml: string): string {
  const existing: string[] = [];
  const section = /^\[shell_environment_policy\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(configToml)?.[1] ?? "";
  const list = /^\s*exclude\s*=\s*\[([^\]]*)\]/m.exec(section)?.[1] ?? "";
  for (const m of list.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) existing.push(m[1] ?? m[2]);
  const all = [...new Set([...existing, BRAIN_ENV_PATTERN])];
  return `shell_environment_policy.exclude=[${all.map((x) => JSON.stringify(x)).join(", ")}]`;
}

/** The line of the generated AGENTS.md that tells Codex about the brain. */
export function codexBrainAgentsLine(b: DomainBrain): string {
  return `This domain's knowledge base is the brain ${b.brain.name}: use its \`${b.serverName}\` MCP tools; see the ${b.serverName} skill.`;
}

// ── Collisions ──────────────────────────────────────────────────────────────

/** Installed plugins that serve the brain's MCP URL (compared as URLs, not by name). */
export function collidingPlugins(brain: Pick<BrainConfig, "remote">, plugins: InstalledPlugin[]): InstalledPlugin[] {
  const mcpUrl = brainUrls(brain).mcpUrl;
  return plugins.filter((p) => Object.values(p.mcpServers).some((d) => sameUrl(d.url, mcpUrl)));
}

export interface AdoptResult {
  /** Domains (GLOBAL included) where the plugin was on and the brain now is. */
  adoptedIn: string[];
}

/**
 * "Adopt plugin as brain", in one registry write: for every domain where the
 * plugin is on (its own choice, GLOBAL's, or the user's settings), set the
 * domain's brain to this one and turn the plugin off. Domains where the plugin
 * is off keep their brain exactly as it was, even when GLOBAL's default changes.
 */
export function adoptPluginAsBrain(brainSlug: string, plugin: Pick<InstalledPlugin, "id" | "enabledByUser">): AdoptResult {
  const adoptedIn: string[] = [];
  updateDomainsAtomically((domains) => {
    const global = domains.find((d) => d.slug === GLOBAL_DOMAIN);
    if (!global) return;
    const before = new Map(domains.map((d) => {
      const own = d.slug === GLOBAL_DOMAIN ? undefined : d;
      return [d.slug, { pluginOn: isPluginOn(plugin, own, global), brain: effectiveBrainSlug(own, global) }];
    }));
    const globalAdopts = before.get(GLOBAL_DOMAIN)!.pluginOn;
    for (const d of domains) {
      const state = before.get(d.slug)!;
      if (state.pluginOn) {
        d.brain = brainSlug;
        d.plugins = { ...(d.plugins ?? {}), [plugin.id]: false };
        adoptedIn.push(d.slug);
      } else if (globalAdopts && d.slug !== GLOBAL_DOMAIN && d.brain === undefined) {
        // GLOBAL's default brain changes: pin what this domain had.
        d.brain = state.brain;
      }
    }
  });
  return { adoptedIn };
}
