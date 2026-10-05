import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import { companionBus } from "./event-bus.js";
import { isTurnInFlight } from "./session-work.js";

export interface DeliveryDeps {
  launcher: Pick<CliLauncher, "getSession" | "isAlive">;
  wsBridge: Pick<WsBridge, "getSession" | "getOrCreateSession" | "injectUserMessage">;
  /**
   * Give the session a fresh auto-relaunch budget before relaunching it (the
   * orchestrator's clearAutoRelaunchCount). A deliberate message must not be
   * stranded because earlier crashes used up the budget.
   */
  resetRelaunchBudget?: (sessionId: string) => void;
}

export type DeliveryResult =
  /** "sent" = handed to a live CLI; "queued" = the CLI is dead and is being relaunched with --resume. */
  | { ok: true; delivery: "sent" | "queued" }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Deliver a user message into an existing session, alive or not.
 *
 * A live CLI gets it at once (the bridge queues it while the CLI is still
 * connecting). For a dead, non-archived session the message is queued in
 * the bridge and the session relaunched on its saved conversation (Claude
 * `--resume`, Codex `thread/resume`): the queue is flushed once the CLI is
 * back, so the full context is kept. Archived sessions are refused, like
 * the orchestrator refuses to relaunch them.
 */
export function deliverUserMessage(deps: DeliveryDeps, sessionId: string, content: string): DeliveryResult {
  const info = deps.launcher.getSession(sessionId);
  if (!info) return { ok: false, status: 404, error: "Session not found" };
  if (info.archived) return { ok: false, status: 409, error: "Session is archived" };

  // A session known to the launcher but never seen by the bridge in this
  // server's lifetime (nothing persisted yet) still needs somewhere to queue.
  if (!deps.wsBridge.getSession(sessionId)) {
    deps.wsBridge.getOrCreateSession(sessionId, info.backendType);
  }
  const alive = deps.launcher.isAlive(sessionId);
  if (!alive) deps.resetRelaunchBudget?.(sessionId);
  deps.wsBridge.injectUserMessage(sessionId, content);
  if (alive) return { ok: true, delivery: "sent" };

  // The bridge already asks for a relaunch when it sees a dead CLI, except
  // when its phase still says "starting" (a bridge session created just
  // above). Asking again is harmless: the orchestrator dedupes relaunch
  // requests per session.
  companionBus.emit("session:relaunch-needed", { sessionId });
  return { ok: true, delivery: "queued" };
}

/**
 * Is a turn running in a live, connected CLI right now? A message sent then
 * would not wait for the turn to end (Codex steers it into the running turn),
 * so scheduled messages hold back until this is false. A dead or
 * disconnected CLI is never busy: delivery queues and relaunches it.
 */
export function isTurnBusy(
  deps: { launcher: Pick<CliLauncher, "isAlive">; wsBridge: Pick<WsBridge, "getSession" | "isCliConnected"> },
  sessionId: string,
): boolean {
  if (!deps.launcher.isAlive(sessionId) || !deps.wsBridge.isCliConnected(sessionId)) return false;
  const session = deps.wsBridge.getSession(sessionId);
  return !!session && isTurnInFlight(session);
}
