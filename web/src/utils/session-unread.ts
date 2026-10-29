import { useStore } from "../store.js";
import type { SdkSessionInfo } from "../types.js";
import { parseHash } from "./routing.js";

/**
 * The browser's side of "unread" sessions (the server keeps the truth,
 * server/session-unread.ts):
 *
 *  - a session counts as seen only when it is the one on screen, the page
 *    is visible and the window has the focus: a result arriving while the
 *    user works in another app stays unread until they come back;
 *  - a result for any other session marks it unread at once (without
 *    waiting for the sidebar's poll) and shows a "result ready" toast;
 *  - the sidebar's poll brings the server's list, which also covers results
 *    that arrived with no browser open and reads done on another device.
 */

/** Whether the user is looking at `sessionId` right now. */
export function isViewingSession(sessionId: string): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  const route = parseHash(window.location.hash);
  return route.page === "session" && route.sessionId === sessionId;
}

/**
 * The user saw `sessionId`: clear it here and tell the server (best effort).
 * The API module is loaded on demand: ws.ts calls this module, and pulling
 * the API (with analytics) into the socket layer is not wanted.
 */
export function markSessionRead(sessionId: string): void {
  useStore.getState().setSessionUnread(sessionId, false);
  import("../api.js").then(({ api }) => api.markSessionRead(sessionId)).catch(() => {});
}

/** A turn of `sessionId` ended (its `result` arrived). */
export function noteSessionResult(sessionId: string): void {
  if (isViewingSession(sessionId)) {
    markSessionRead(sessionId);
    return;
  }
  const store = useStore.getState();
  store.setSessionUnread(sessionId, true);
  store.pushResultToast(sessionId);
}

/** Take the server's unread list from the sidebar's poll; the session on screen is read instead. */
export function syncUnreadFromServer(list: Pick<SdkSessionInfo, "sessionId" | "unread">[]): void {
  const unread: string[] = [];
  for (const s of list) {
    if (!s.unread) continue;
    if (isViewingSession(s.sessionId)) markSessionRead(s.sessionId);
    else unread.push(s.sessionId);
  }
  useStore.getState().setUnreadSessions(unread);
}

/** Mark the session on screen read, if it is unread (route change, focus, page shown). */
export function markViewedSessionRead(): void {
  const route = parseHash(window.location.hash);
  if (route.page !== "session") return;
  if (useStore.getState().unreadSessions.has(route.sessionId) && isViewingSession(route.sessionId)) {
    markSessionRead(route.sessionId);
  }
}

/** The session's title as the user knows it. */
export function sessionTitle(sessionId: string): string {
  const store = useStore.getState();
  return store.sessionNames.get(sessionId)
    || store.sdkSessions.find((s) => s.sessionId === sessionId)?.name
    || `Session ${sessionId.slice(0, 8)}`;
}
