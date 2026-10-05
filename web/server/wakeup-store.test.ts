import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeupStore, type SessionWakeup } from "./wakeup-store.js";

/** The on-disk wake-up store, in a temp dir (never the real COMPANION_HOME). */

let root: string;
let store: WakeupStore;

function wakeup(overrides: Partial<SessionWakeup> = {}): SessionWakeup {
  return {
    id: "wk-1",
    sessionId: "s1",
    message: "check the deploy",
    schedule: { at: "2030-01-01T08:00" },
    createdAt: 1,
    createdBy: "user",
    enabled: true,
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wakeup-store-test-"));
  store = new WakeupStore(join(root, "wakeups"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WakeupStore", () => {
  // Messages can carry anything the user typed: files are private to the user.
  it("saves each wake-up as a 0600 file in a 0700 dir and reads it back", () => {
    store.save(wakeup());
    expect(store.get("wk-1")).toEqual(wakeup());
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.directory, "wk-1.json")).mode & 0o777).toBe(0o600);
  });

  it("lists wake-ups oldest first and skips unreadable files", () => {
    store.save(wakeup({ id: "wk-b", createdAt: 20 }));
    store.save(wakeup({ id: "wk-a", createdAt: 10 }));
    writeFileSync(join(store.directory, "broken.json"), "{not json");
    writeFileSync(join(store.directory, "notes.txt"), "ignored");
    expect(store.list().map((w) => w.id)).toEqual(["wk-a", "wk-b"]);
  });

  it("returns nothing before the directory exists", () => {
    expect(store.list()).toEqual([]);
    expect(store.get("wk-1")).toBeNull();
  });

  // Ids reach the store from URLs: never let one escape the directory.
  it("refuses ids that are not plain names", () => {
    expect(store.get("../settings")).toBeNull();
    expect(store.remove("../settings")).toBe(false);
    expect(() => store.save(wakeup({ id: "../x" }))).toThrow(/Invalid wake-up id/);
  });

  it("removes a wake-up", () => {
    store.save(wakeup());
    expect(store.remove("wk-1")).toBe(true);
    expect(store.remove("wk-1")).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
