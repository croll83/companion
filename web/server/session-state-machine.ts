// Formal session state machine for the Companion server.
// Centralizes session phase definitions and validates transitions.

import { metricsCollector } from "./metrics-collector.js";
import { log } from "./logger.js";

/**
 * The formal phases a session can be in.
 *
 * - starting:            CLI process spawned, WS not yet connected
 * - initializing:        CLI WS connected, awaiting system.init
 * - ready:               Idle, awaiting user input
 * - streaming:           Claude generating output (stream_event / assistant)
 * - awaiting_permission: Tool call pending user approval
 * - compacting:          Context window compaction in progress
 * - reconnecting:        CLI socket dropped, within grace period
 * - terminated:          Process exited or killed
 */
export type SessionPhase =
  | "starting"
  | "initializing"
  | "ready"
  | "streaming"
  | "awaiting_permission"
  | "compacting"
  | "reconnecting"
  | "terminated";

/** Payload emitted on every successful state transition. */
export interface SessionTransitionEvent {
  sessionId: string;
  from: SessionPhase;
  to: SessionPhase;
  trigger: string;
  timestamp: number;
}

/**
 * Defines which (from -> to) transitions are valid.
 * Any transition not listed here will be blocked with a warning.
 *
 * Two rules keep this table honest, both learned from production:
 *
 * 1. `starting` is reachable from EVERY live phase. A relaunch can be requested
 *    at any moment (model/effort change, Reconnect, relaunch-on-send). When the
 *    table only allowed it from `terminated`, the process really was replaced
 *    but the phase stayed on the old value, so the UI sat on "CLI disconnected"
 *    forever (104 blocked relaunches in one production log, 2026-09-22).
 *
 * 2. `awaiting_permission` is reachable from every phase where the CLI is alive.
 *    It is the phase the idle-kill watchdog treats as protected; if a session
 *    cannot ENTER it, it stays in `ready` — the only killable phase — and a
 *    session waiting on the user's approval can be reclaimed out from under
 *    them (35 blocked in the same log).
 */
export const VALID_TRANSITIONS: ReadonlyMap<
  SessionPhase,
  ReadonlySet<SessionPhase>
> = new Map([
  [
    "starting",
    new Set<SessionPhase>(["initializing", "streaming", "reconnecting", "terminated"]),
  ],
  [
    "initializing",
    new Set<SessionPhase>(["ready", "streaming", "reconnecting", "terminated", "starting"]),
  ],
  [
    "ready",
    new Set<SessionPhase>([
      "streaming",
      "awaiting_permission",
      "compacting",
      "reconnecting",
      "terminated",
      "starting",
    ]),
  ],
  [
    "streaming",
    new Set<SessionPhase>([
      "ready",
      "initializing",
      "awaiting_permission",
      "compacting",
      "reconnecting",
      "terminated",
      "starting",
    ]),
  ],
  [
    "awaiting_permission",
    new Set<SessionPhase>(["streaming", "ready", "reconnecting", "terminated", "starting"]),
  ],
  [
    "compacting",
    new Set<SessionPhase>([
      "ready",
      "streaming",
      "reconnecting",
      "terminated",
      "starting",
    ]),
  ],
  [
    "reconnecting",
    new Set<SessionPhase>(["initializing", "starting", "ready", "streaming", "terminated"]),
  ],
  ["terminated", new Set<SessionPhase>(["starting"])],
]);

type TransitionListener = (event: SessionTransitionEvent) => void;

export class SessionStateMachine {
  private _phase: SessionPhase;
  private readonly _sessionId: string;
  private _listeners: TransitionListener[] = [];

  constructor(sessionId: string, initialPhase: SessionPhase = "starting") {
    this._sessionId = sessionId;
    this._phase = initialPhase;
  }

  get phase(): SessionPhase {
    return this._phase;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Attempt a state transition.
   * Returns true if successful (or same-state no-op), false if blocked.
   * Invalid transitions are logged but never throw.
   */
  /**
   * Transition that must succeed, for callers where a silent no-op corrupts the
   * session (relaunch bookkeeping, user sends).
   *
   * `transition` returns false and nearly every caller uses it as a statement,
   * so a rejected transition used to vanish into a warning while the phase and
   * the real process drifted apart. This records it as an error instead.
   */
  mustTransition(to: SessionPhase, trigger: string): boolean {
    if (this.transition(to, trigger)) return true;
    metricsCollector.recordError("required_state_transition_blocked");
    log.error("state-machine", "REQUIRED transition blocked — session phase now lies", {
      sessionId: this._sessionId,
      from: this._phase,
      to,
      trigger,
    });
    return false;
  }

  transition(to: SessionPhase, trigger: string): boolean {
    if (this._phase === to) return true;

    const allowed = VALID_TRANSITIONS.get(this._phase);
    if (!allowed || !allowed.has(to)) {
      metricsCollector.recordError("invalid_state_transition");
      log.warn("state-machine", "Blocked invalid transition", {
        sessionId: this._sessionId,
        from: this._phase,
        to,
        trigger,
      });
      return false;
    }

    const event: SessionTransitionEvent = {
      sessionId: this._sessionId,
      from: this._phase,
      to,
      trigger,
      timestamp: Date.now(),
    };

    this._phase = to;

    // Snapshot listeners so additions/removals during iteration are safe
    const snapshot = this._listeners.slice();
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        console.error(
          `[state-machine] Listener error for ${this._sessionId}:`,
          err,
        );
      }
    }

    return true;
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onTransition(listener: TransitionListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Force-set state without validation or listener notification.
   * Used for restoring state from disk.
   */
  forceState(phase: SessionPhase): void {
    this._phase = phase;
  }

  // -- Guard methods --

  /** True only when session is idle and ready for a new user message. */
  canAcceptUserMessage(): boolean {
    return this._phase === "ready";
  }

  /** True only when a permission request is pending. */
  canRespondToPermission(): boolean {
    return this._phase === "awaiting_permission";
  }

  /** True when the CLI socket is expected to be reachable. */
  canSendToCLI(): boolean {
    return (
      this._phase !== "terminated" &&
      this._phase !== "reconnecting" &&
      this._phase !== "starting"
    );
  }

  /** True when the session has not terminated. */
  isActive(): boolean {
    return this._phase !== "terminated";
  }

  /** True only when the session is idle (ready). */
  isIdle(): boolean {
    return this._phase === "ready";
  }
}
