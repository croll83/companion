import { getConnection } from "./linear-connections.js";
import { getSettings } from "./settings-manager.js";
import type { DomainLinearLink } from "./domain-store.js";

/**
 * Which Linear transition rule applies to an issue of a session: the
 * session's domain rule when the domain has one for that issue's
 * workspace/team, else the connection's own setting (the only place rules
 * lived before domains had them), else the legacy settings.json fields.
 *
 * Keeping the connection as the fallback IS the migration: nothing is copied,
 * an existing install behaves exactly as before until a domain sets its own
 * rule. Backend-agnostic: the same rules apply to Claude Code and Codex
 * sessions, they only depend on the session's domain and its linked issue.
 *
 * No Linear API calls here (safe to use from the session orchestrator).
 */

export type TransitionKind = "start" | "archive";

export interface EffectiveTransitionRule {
  /** The rule's switch; it only does something with a stateId too (see isConfigured). */
  enabled: boolean;
  stateId: string;
  stateName: string;
  source: "domain" | "connection" | "settings";
}

export interface TransitionContext {
  /** The Linear link of the session's domain, if any. */
  link?: DomainLinearLink;
  /** The connection the issue was fetched with ("legacy" = settings.json key). */
  connectionId: string;
  /** The issue's team, when known: a domain rule only fits states of its own team. */
  teamId?: string;
}

/** Whether a domain link's rules can apply to an issue (same workspace and, when known, same team). */
export function linkCovers(link: DomainLinearLink | undefined, connectionId: string, teamId?: string): link is DomainLinearLink {
  if (!link || link.connectionId !== connectionId) return false;
  return !teamId || teamId === link.teamId;
}

export function resolveTransitionRule(kind: TransitionKind, ctx: TransitionContext): EffectiveTransitionRule {
  const key = kind === "start" ? "autoTransition" : "archiveTransition";
  const own = linkCovers(ctx.link, ctx.connectionId, ctx.teamId) ? ctx.link[key] : undefined;
  if (own) {
    return { enabled: own.enabled, stateId: own.stateId, stateName: own.stateName, source: "domain" };
  }
  const conn = ctx.connectionId !== "legacy" ? getConnection(ctx.connectionId) : null;
  if (conn) {
    const stateId = (kind === "start" ? conn.autoTransitionStateId : conn.archiveTransitionStateId).trim();
    const enabled = kind === "start" ? conn.autoTransition : conn.archiveTransition;
    return {
      enabled,
      stateId,
      stateName: kind === "start" ? conn.autoTransitionStateName : conn.archiveTransitionStateName,
      source: "connection",
    };
  }
  const s = getSettings();
  const stateId = (kind === "start" ? s.linearAutoTransitionStateId : s.linearArchiveTransitionStateId).trim();
  const enabled = kind === "start" ? s.linearAutoTransition : s.linearArchiveTransition;
  return {
    enabled,
    stateId,
    stateName: kind === "start" ? s.linearAutoTransitionStateName : s.linearArchiveTransitionStateName,
    source: "settings",
  };
}

/** A rule that would actually move the issue. */
export function isConfigured(rule: EffectiveTransitionRule): boolean {
  return rule.enabled && !!rule.stateId;
}
