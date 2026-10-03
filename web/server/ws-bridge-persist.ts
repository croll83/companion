import type { BrowserIncomingMessage } from "./session-types.js";
import type { Session } from "./ws-bridge-types.js";
import type { SessionStore, PersistedSession } from "./session-store.js";

// ─── Persistence Pipeline ───────────────────────────────────────────────────
// Extracted from WsBridge to consolidate history append + disk persistence
// into explicit, testable functions.

export const MESSAGE_HISTORY_LIMIT = 2000;

/**
 * How many messages a browser gets on connect.
 *
 * The full 2000-message history was replayed to every socket on every refresh.
 * Sending the tail keeps the visible conversation instant and lets the client
 * pull older pages on demand, which matters most on phones.
 */
export const HISTORY_PAGE_SIZE = 200;

/** The newest `size` messages plus where they sit in the full history. */
export function historyTail<T>(history: T[], size: number = HISTORY_PAGE_SIZE) {
  const startIndex = Math.max(0, history.length - size);
  return { messages: history.slice(startIndex), startIndex, total: history.length };
}

/** An older page ending just before `beforeIndex`. */
export function historyPage<T>(history: T[], beforeIndex: number, size: number = HISTORY_PAGE_SIZE) {
  const end = Math.max(0, Math.min(beforeIndex, history.length));
  const startIndex = Math.max(0, end - size);
  return { messages: history.slice(startIndex, end), startIndex, total: history.length };
}

/**
 * Append a message to session history with cap enforcement, then persist to disk.
 * Consolidates the common appendHistory + persistSession pattern into one call,
 * eliminating the risk of appending without persisting.
 */
export function appendAndPersist(
  session: Session,
  msg: BrowserIncomingMessage,
  store: SessionStore | null,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  appendHistory(session, msg, historyLimit);
  persistSession(session, store);
}

/**
 * Append a message to session history with cap enforcement.
 * Trims oldest messages when the history exceeds the limit.
 */
export function appendHistory(
  session: Session,
  msg: BrowserIncomingMessage,
  historyLimit: number = MESSAGE_HISTORY_LIMIT,
): void {
  session.messageHistory.push(msg);
  if (session.messageHistory.length > historyLimit) {
    session.messageHistory.splice(0, session.messageHistory.length - historyLimit);
  }
}

/**
 * Persist session state to disk (debounced via SessionStore).
 * No-op if no store is attached.
 */
export function persistSession(session: Session, store: SessionStore | null): void {
  if (!store) return;
  store.save(serializeForStore(session));
}

/**
 * Serialize a Session into the shape expected by SessionStore.save().
 * Converts Maps to arrays and selects the persisted fields.
 */
export function serializeForStore(session: Session): PersistedSession {
  return {
    id: session.id,
    state: session.state,
    messageHistory: session.messageHistory,
    pendingMessages: session.pendingMessages,
    pendingPermissions: Array.from(session.pendingPermissions.entries()),
    eventBuffer: session.eventBuffer,
    nextEventSeq: session.nextEventSeq,
    lastAckSeq: session.lastAckSeq,
    processedClientMessageIds: session.processedClientMessageIds,
  };
}
