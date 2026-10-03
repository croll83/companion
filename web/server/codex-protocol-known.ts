/**
 * Is a Codex app-server method part of the protocol we know?
 *
 * The adapter deliberately handles only a subset of what Codex can send. Until
 * now anything outside that subset was reported as "protocol drift" and shown
 * to the user as an error — so a perfectly normal notification we simply don't
 * act on (thread/goal/updated, thread/settings/updated, …) produced a red
 * banner on every turn, and each one had to be silenced by hand.
 *
 * Splitting the two cases removes that whole class of false alarms:
 *   - KNOWN to the protocol, unhandled  → informational, log once, stay quiet.
 *   - NOT known                         → real drift: Codex gained something
 *                                         after our snapshot; worth telling the user.
 *
 * The method lists are generated from the installed CLI's own schema — see
 * `scripts/sync-codex-known-methods.sh`.
 */
import {
  CODEX_SERVER_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
} from "./protocol/codex-known-methods.generated.js";

const NOTIFICATIONS = new Set(CODEX_SERVER_NOTIFICATIONS);
const REQUESTS = new Set(CODEX_SERVER_REQUESTS);

/** A server -> client notification the generated schema declares. */
export function isKnownServerNotification(method: string): boolean {
  return NOTIFICATIONS.has(method);
}

/** A server -> client request the generated schema declares. */
export function isKnownServerRequest(method: string): boolean {
  return REQUESTS.has(method);
}

/** Counts, for the compatibility tests (a truncated generation must not pass). */
export function knownMethodCounts(): { notifications: number; requests: number } {
  return { notifications: NOTIFICATIONS.size, requests: REQUESTS.size };
}
