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
// pending, is the phase anything other than at-rest?

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
  }
}

/** Drop stale tool bookkeeping when the session comes to rest. */
export function clearWorkTracking(session: Session): void {
  session.openToolCalls.clear();
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
  return !AT_REST.has(session.stateMachine.phase);
}
