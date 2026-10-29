import { getLocalProvider, readLocalProviderToken, type LocalProviderConfig } from "./local-providers.js";

/**
 * How a LOCAL session's Claude Code is started: the same CLI, with an
 * environment that sends its API calls to the provider's Companion LLM
 * proxy (tools/llm-proxy, running next to vLLM), which forwards them to the
 * model. Rebuilt at every spawn and relaunch from the session record
 * (provider id + model), so the provider's current settings apply and
 * nothing secret is persisted in launcher.json.
 *
 * The proxy's shared token is in the CLI's environment (ANTHROPIC_AUTH_TOKEN),
 * so the session's shell can read it: it opens the model server only.
 */

/** What a local session records (launcher.json): survives restarts and relaunches. */
export interface LocalSessionInfo {
  /** Provider id (local-providers.ts). */
  provider: string;
  /** Model id on that provider. */
  model: string;
}

/**
 * Credentials and routing that must never reach a local session from
 * Companion's own environment, an env profile, the request env or the
 * Settings token: with any of them the CLI could talk to Anthropic (or to
 * Bedrock / Vertex) or send an Anthropic credential to the proxy. They are
 * unset after everything else is applied.
 */
const CLEARED_ENV = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // Replaced by the session header below: inherited headers could carry an Authorization.
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

/**
 * Built-in tools that do not work on a local provider without help:
 * WebSearch asks the Anthropic API's server-side web search tool. The proxy
 * answers it when it has a search backend (`webSearch: true` on its
 * GET /info, stored as the provider's webSearchBackend); otherwise it stays
 * disallowed, so the model does not call a tool that can only fail.
 */
const LOCAL_DISALLOWED_TOOLS = ["WebSearch"];

export function localDisallowedTools(provider: Pick<LocalProviderConfig, "webSearchBackend">): string[] {
  return provider.webSearchBackend ? [] : [...LOCAL_DISALLOWED_TOOLS];
}

/**
 * The alias passed as `--model`: Claude Code refuses model names it does not
 * know before calling any server, so it runs on an alias that
 * ANTHROPIC_DEFAULT_*_MODEL resolves to the local model (and the proxy maps
 * whatever model a request names to the session's model anyway).
 */
export const LOCAL_MODEL_ALIAS = "sonnet";

export interface LocalSpawn {
  env: Record<string, string | undefined>;
  modelAlias: string;
  disallowedTools: string[];
  /** The provider's levels: `--effort` is passed only with one of them. */
  effortLevels: string[];
}

/**
 * Sent as ANTHROPIC_AUTH_TOKEN when the provider has no token: Claude Code
 * needs some credential, and without one it would fall back to the user's
 * Anthropic login and send that OAuth token to the proxy.
 */
export const NO_TOKEN_PLACEHOLDER = "no-token";

/** Header naming the Companion session on every request: the proxy keys its metrics by it. */
export const SESSION_HEADER = "X-Companion-Session";

/** Claude Code's default `max_tokens` for a model it does not know (CLI 2.1.303). */
const CLI_DEFAULT_MAX_OUTPUT = 32_000;

/**
 * Context window and autocompact for the provider's window. Found in Claude
 * Code 2.1.303 (strings of the binary, no documentation ships with it):
 *
 *  - a model it does not know is assumed to have a 200k window, unless
 *    CLAUDE_CODE_MAX_CONTEXT_TOKENS is set (used only for non-Claude model
 *    names): that becomes the model's window, which also drives the context
 *    meter and the "blocking" limit, and removes the "doesn't recognize the
 *    model" warning;
 *  - CLAUDE_CODE_AUTO_COMPACT_WINDOW (100k..1M, capped at the model's
 *    window) sets the autocompact window with source "env", which makes the
 *    CLI compact at its threshold instead of waiting for a prompt-too-long
 *    error. Below 100k the model window above still caps it;
 *  - the threshold is window − min(max output, 20000) − 13000: 98,072 for a
 *    131,072 window. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE can only lower it.
 *
 * `max_tokens` is the CLI's 32,000 unless the window is small: vLLM rejects a
 * request whose prompt + max_tokens exceeds the model length, so a quarter of
 * the window at most.
 */
export function contextEnv(provider: Pick<LocalProviderConfig, "contextWindow">): Record<string, string> {
  const window = provider.contextWindow;
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.min(CLI_DEFAULT_MAX_OUTPUT, Math.floor(window / 4))),
  };
}

export function buildLocalSpawn(sessionId: string, local: LocalSessionInfo): LocalSpawn | { error: string } {
  const provider = getLocalProvider(local.provider);
  if (!provider) return { error: `the local provider "${local.provider}" no longer exists: the session cannot start` };
  const env: Record<string, string | undefined> = Object.fromEntries(CLEARED_ENV.map((k) => [k, undefined]));
  Object.assign(env, {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: readLocalProviderToken(provider.id) ?? NO_TOKEN_PLACEHOLDER,
    // Lets the proxy attribute each request (metrics, logs) to this session.
    ANTHROPIC_CUSTOM_HEADERS: `${SESSION_HEADER}: ${sessionId}`,
    ANTHROPIC_DEFAULT_OPUS_MODEL: local.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: local.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: local.model,
    ANTHROPIC_SMALL_FAST_MODEL: local.model,
    // No telemetry, error reporting, update checks or other calls to
    // Anthropic from a session that is not on the Anthropic account.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...contextEnv(provider),
  });
  return { env, modelAlias: LOCAL_MODEL_ALIAS, disallowedTools: localDisallowedTools(provider), effortLevels: provider.effortLevels };
}
