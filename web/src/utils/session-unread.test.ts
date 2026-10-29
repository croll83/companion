// @vitest-environment jsdom
/**
 * The browser's side of unread sessions. What counts: a result is "seen"
 * only for the session on screen with the page visible and the window
 * focused; any other result marks the session unread and raises one toast;
 * the server's list (sidebar poll) wins, except for the session on screen,
 * which is read instead; coming back to a session marks it read and tells
 * the server. The API is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ markSessionRead: vi.fn(async () => ({ ok: true })) }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { useStore } from "../store.js";
import {
  isViewingSession,
  markViewedSessionRead,
  noteSessionResult,
  sessionTitle,
  syncUnreadFromServer,
} from "./session-unread.js";

let focused = true;

function onScreen(sessionId: string | null) {
  window.location.hash = sessionId ? `#/session/${sessionId}` : "#/";
}

beforeEach(() => {
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  useStore.setState({ unreadSessions: new Set(), resultToasts: [], sessionNames: new Map(), sdkSessions: [] });
  mockApi.markSessionRead.mockClear();
  onScreen(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("isViewingSession", () => {
  it("needs the session on screen, the page visible and the window focused", () => {
    onScreen("s1");
    expect(isViewingSession("s1")).toBe(true);
    expect(isViewingSession("s2")).toBe(false);
    focused = false;
    expect(isViewingSession("s1")).toBe(false);
    focused = true;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    expect(isViewingSession("s1")).toBe(false);
  });
});

describe("noteSessionResult", () => {
  it("a result for another session makes it unread and raises a toast", () => {
    onScreen("s1");
    noteSessionResult("s2");
    expect(useStore.getState().unreadSessions.has("s2")).toBe(true);
    expect(useStore.getState().resultToasts.map((t) => t.sessionId)).toEqual(["s2"]);
    expect(mockApi.markSessionRead).not.toHaveBeenCalled();
  });

  it("a result for the session on screen is read at once, without a toast", async () => {
    onScreen("s1");
    noteSessionResult("s1");
    await flush();
    expect(useStore.getState().unreadSessions.has("s1")).toBe(false);
    expect(useStore.getState().resultToasts).toEqual([]);
    expect(mockApi.markSessionRead).toHaveBeenCalledWith("s1");
  });

  // Working in another app with Companion visible: the result is not seen yet.
  it("a result while the window is not focused stays unread", () => {
    onScreen("s1");
    focused = false;
    noteSessionResult("s1");
    expect(useStore.getState().unreadSessions.has("s1")).toBe(true);
  });
});

describe("syncUnreadFromServer", () => {
  it("takes the server's list but reads the session on screen", async () => {
    onScreen("s1");
    useStore.setState({ unreadSessions: new Set(["old"]) });
    syncUnreadFromServer([{ sessionId: "s1", unread: true }, { sessionId: "s2", unread: true }, { sessionId: "s3", unread: false }]);
    await flush();
    expect([...useStore.getState().unreadSessions]).toEqual(["s2"]);
    expect(mockApi.markSessionRead).toHaveBeenCalledWith("s1");
  });
});

describe("markViewedSessionRead", () => {
  it("marks the session on screen read when it was unread, and nothing otherwise", async () => {
    useStore.setState({ unreadSessions: new Set(["s1"]) });
    markViewedSessionRead();
    onScreen("s2");
    markViewedSessionRead();
    await flush();
    expect(mockApi.markSessionRead).not.toHaveBeenCalled();
    onScreen("s1");
    markViewedSessionRead();
    await flush();
    expect(useStore.getState().unreadSessions.has("s1")).toBe(false);
    expect(mockApi.markSessionRead).toHaveBeenCalledWith("s1");
  });

  it("a failed request to the server is ignored", async () => {
    mockApi.markSessionRead.mockRejectedValueOnce(new Error("offline"));
    useStore.setState({ unreadSessions: new Set(["s1"]) });
    onScreen("s1");
    markViewedSessionRead();
    await flush();
    expect(useStore.getState().unreadSessions.has("s1")).toBe(false);
  });
});

describe("sessionTitle", () => {
  it("uses the session's name, then the server's, then a short id", () => {
    useStore.setState({
      sessionNames: new Map([["s1", "Fix the login"]]),
      sdkSessions: [{ sessionId: "s2", name: "From server", state: "connected", cwd: "/", createdAt: 0 }],
    });
    expect(sessionTitle("s1")).toBe("Fix the login");
    expect(sessionTitle("s2")).toBe("From server");
    expect(sessionTitle("abcdef1234")).toBe("Session abcdef12");
  });
});
