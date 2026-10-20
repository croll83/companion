import { useStore } from "../store.js";
import { effortLabel } from "./backends.js";
import type { SdkSessionInfo } from "../types.js";

/**
 * A session on a local provider (Claude Code pointed at a Companion LLM proxy,
 * see server/local-spawn.ts), or undefined for an Anthropic or Codex one.
 * Such a session hides what only the Anthropic API has (cost and usage
 * limits, ultracode, Claude's effort levels, the refusal fallback chain,
 * WebSearch) and never changes model or provider.
 */
export function useLocalSession(sessionId: string | null | undefined): SdkSessionInfo["local"] {
  return useStore((s) => (sessionId ? s.sdkSessions?.find((x) => x.sessionId === sessionId)?.local : undefined));
}

/** "Local · Lab/my-model" */
export function localSessionLabel(local: NonNullable<SdkSessionInfo["local"]>): string {
  return `Local · ${local.providerName}/${local.model}`;
}

/**
 * Name of a reasoning level on a local provider: the model level the proxy
 * maps this Claude Code effort value to (e.g. low → "off"), as the proxy
 * publishes it; else the effort's own label.
 */
export function localEffortLabel(labels: Record<string, string> | undefined, level: string): string {
  const name = labels?.[level];
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : effortLabel(level);
}
