// Whether a session is doing real work, for the idle-kill watchdog.
//
// The watchdog used to infer this from the phase alone: `ready` meant killable.
// That is a proxy, and a leaky one. A session can sit in `ready` while a Bash
// command, an MCP call or a delegated sub-agent runs for tens of minutes without
// emitting anything, because the phase only tracks *generation*. It can also be
// stuck in `ready` because a transition was rejected (see VALID_TRANSITIONS).
// Either way the session looks idle, the 30-minute timer expires and live work
// is SIGTERMed.
//
// So ask directly instead: is a tool call outstanding, is the user's approval
// pending, does the CLI report live background work or an unfinished turn, is
// the phase anything other than at-rest? The CLI signals are the authoritative
// ones — background_tasks_changed and session_state_changed — and they cover
// the case the rest cannot see: a turn that has ENDED while a terraform plan,
// a Docker test or a workflow it launched in the background is still running.

import type { Session } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { SessionPhase } from "./session-state-machine.js";

/** Phases in which no work can be in flight. */
const AT_REST: ReadonlySet<SessionPhase> = new Set<SessionPhase>(["ready", "terminated"]);

type MaybeContent = { message?: { content?: Array<Record<string, unknown>> } };

function contentBlocks(msg: BrowserIncomingMessage): Array<Record<string, unknown>> {
  const content = (msg as MaybeContent).message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Track outstanding tool calls from the CLI message stream.
 *
 * `assistant` blocks of type `tool_use` open one. The bridge never sees the
 * matching `tool_result` (it is not part of BrowserIncomingMessage), so they are
 * closed by `tool_use_summary`, which names the ids that finished, and swept by
 * `result` at turn end. Anything still open after a turn is stale — leaving it
 * would pin the session alive forever and defeat the watchdog entirely.
 */
export function noteWorkFromCliMessage(session: Session, msg: BrowserIncomingMessage): void {
  if (msg.type === "assistant") {
    for (const block of contentBlocks(msg)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        session.openToolCalls.add(block.id);
      }
    }
    return;
  }
  // A tool still reporting progress is alive even if its id was never opened
  // (e.g. the assistant block predates a reconnect).
  if (msg.type === "tool_progress") {
    session.openToolCalls.add(msg.tool_use_id);
    return;
  }
  if (msg.type === "tool_use_summary") {
    for (const id of msg.tool_use_ids) session.openToolCalls.delete(id);
    return;
  }
  if (msg.type === "result") {
    session.openToolCalls.clear();
    return;
  }
  // Level signal: the payload IS the live set. Replace, never pair edges — the
  // CLI's own guidance, "so a missed bookend cannot wedge a stale running"
  // task. A turn can end (result, phase ready) with these still running; that
  // is exactly the "looks idle, still has work in flight" case.
  if (msg.type === "background_tasks") {
    session.backgroundTasks = new Map(
      msg.tasks.map((t) => [t.task_id, { type: t.task_type, description: t.description, ambient: t.ambient === true }]),
    );
    return;
  }
  if (msg.type === "cli_session_state") {
    session.cliState = msg.state;
  }
}

/**
 * Drop stale bookkeeping.
 *
 * A turn coming to rest only settles its own tool calls: background tasks
 * outlive the turn by design, and clearing them here would reopen the very hole
 * this tracks. When the CLI process itself is gone ("process"), everything it
 * was running died with it.
 */
export function clearWorkTracking(session: Session, scope: "turn" | "process" = "turn"): void {
  session.openToolCalls.clear();
  if (scope === "process") {
    session.backgroundTasks.clear();
    session.cliState = undefined;
  }
}

/** Non-ambient background tasks still running: real work, not housekeeping. */
export function liveBackgroundWork(session: Session): { type: string; description: string }[] {
  return [...session.backgroundTasks.values()].filter((t) => !t.ambient);
}

/**
 * Is a TURN in flight — as opposed to background work outliving its turn?
 *
 * The two answer different questions and must not be swapped. isSessionWorking
 * asks "may the idle-kill reclaim this CLI?" and must count background tasks.
 * This asks "should a CLI we lost contact with be relaunched right now?", where
 * relaunching SIGTERMs the process — and background tasks survive only if the
 * process is left alone. Counting them here made a stdout EOF on a live CLI
 * kill the very terraform plan the background tracking exists to protect
 * (caught in review, 2026-10-03). cliState is left out too: "running" can be a
 * backgrounded agent waking the CLI, not the user's turn.
 */
export function isTurnInFlight(session: Session): boolean {
  if (session.pendingPermissions.size > 0) return true;
  if (session.openToolCalls.size > 0) return true;
  return !AT_REST.has(session.stateMachine.phase);
}

/**
 * Is the session doing something that must not be interrupted?
 *
 * Covers, in order: the user's approval is pending (their place in the task
 * would be lost); a tool call is outstanding (terminal wait, MCP, sub-agent);
 * the phase itself says work is in flight.
 */
export function isSessionWorking(session: Session): boolean {
  if (session.pendingPermissions.size > 0) return true;
  if (session.openToolCalls.size > 0) return true;
  // The CLI's own word, when it gives it: a background shell, Monitor, workflow
  // or backgrounded agent is live, or its turn is not over.
  if (liveBackgroundWork(session).length > 0) return true;
  if (session.cliState === "running" || session.cliState === "requires_action") return true;
  return !AT_REST.has(session.stateMachine.phase);
}
