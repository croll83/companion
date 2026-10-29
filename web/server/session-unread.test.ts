import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The unread registry behind the sidebar's green dot and the domains'
 * badges. It must survive a restart (a file), turn a session unread when a
 * turn ends and read again when a browser shows it, and forget deleted
 * sessions. A corrupt file must not break the session list.
 */

vi.mock("./paths.js", () => ({ COMPANION_HOME: "/nonexistent-companion-home" }));

import { SessionUnread, trackSessionResults } from "./session-unread.js";
import { companionBus } from "./event-bus.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-unread-"));
  file = join(dir, "sub", "session-unread.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionUnread", () => {
  it("a result makes a session unread until it is read, and a newer result makes it unread again", () => {
    const u = new SessionUnread(file);
    expect(u.isUnread("s1")).toBe(false);
    u.noteResult("s1", 100);
    expect(u.isUnread("s1")).toBe(true);
    expect(u.markRead("s1", 200)).toBe(true);
    expect(u.isUnread("s1")).toBe(false);
    expect(u.markRead("s1", 250)).toBe(false);
    u.noteResult("s1", 300);
    expect(u.isUnread("s1")).toBe(true);
    // Reading a session that never delivered anything is a no-op.
    expect(u.markRead("never", 1)).toBe(false);
    expect(u.isUnread("never")).toBe(false);
  });

  it("survives a restart", () => {
    const u = new SessionUnread(file);
    u.noteResult("s1", 100);
    u.noteResult("s2", 100);
    u.markRead("s2", 200);
    const again = new SessionUnread(file);
    expect(again.isUnread("s1")).toBe(true);
    expect(again.isUnread("s2")).toBe(false);
  });

  it("forgets sessions that no longer exist, and only writes when something changed", () => {
    const u = new SessionUnread(file);
    u.noteResult("s1", 1);
    u.noteResult("gone", 1);
    u.prune(new Set(["s1"]));
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ s1: { resultAt: 1 } });
    writeFileSync(file, "untouched");
    u.prune(new Set(["s1"]));
    expect(readFileSync(file, "utf-8")).toBe("untouched");
  });

  it("starts empty on a corrupt file or bad entries", () => {
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(new SessionUnread(join(dir, "bad.json")).isUnread("s1")).toBe(false);
    writeFileSync(join(dir, "mixed.json"), JSON.stringify({ ok: { resultAt: 5 }, bad: { resultAt: "x" }, nul: null }));
    const u = new SessionUnread(join(dir, "mixed.json"));
    expect(u.isUnread("ok")).toBe(true);
    expect(u.isUnread("bad")).toBe(false);
  });

  it("keeps working in memory when the file cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, "blocker"), "a file, not a directory");
    const u = new SessionUnread(join(dir, "blocker", "x.json"));
    u.noteResult("s1", 1);
    expect(u.isUnread("s1")).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("trackSessionResults", () => {
  // Every turn end (Claude or Codex) goes through the bus's message:result.
  it("marks a session unread on message:result, until unsubscribed", () => {
    const u = new SessionUnread(file);
    const stop = trackSessionResults(u);
    try {
      companionBus.emit("message:result", { sessionId: "s1", message: { type: "result" } as never });
      expect(u.isUnread("s1")).toBe(true);
    } finally {
      stop();
    }
    companionBus.emit("message:result", { sessionId: "s2", message: { type: "result" } as never });
    expect(u.isUnread("s2")).toBe(false);
  });
});
