import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Wake-ups end to end inside the scheduler: real croner (driven by fake
 * timers), a real store in a temp dir, and stand-ins for the launcher and
 * the delivery path (session-delivery.test.ts covers delivery itself).
 */

const settings = vi.hoisted(() => ({ timeZone: "UTC" }));
vi.mock("./settings-manager.js", () => ({ getSettings: () => settings }));

import { MAX_PENDING_BY_SESSIONS, WakeupScheduler, wakeupMessageText } from "./wakeup-scheduler.js";
import { WakeupStore, type SessionWakeup } from "./wakeup-store.js";
import { companionBus } from "./event-bus.js";
import type { DeliveryResult } from "./session-delivery.js";

const NOW = new Date("2026-10-05T10:00:00Z");
const HOUR = 60 * 60 * 1000;

let root: string;
let store: WakeupStore;
let sessions: Map<string, { archived?: boolean }>;
let busy: Set<string>;
let deliver: ReturnType<typeof vi.fn<(sessionId: string, content: string) => DeliveryResult>>;
let scheduler: WakeupScheduler;

function newScheduler(): WakeupScheduler {
  return new WakeupScheduler({
    store,
    getSession: (id) => sessions.get(id),
    isBusy: (id) => busy.has(id),
    deliver,
  });
}

function created(result: ReturnType<WakeupScheduler["create"]>): SessionWakeup {
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.wakeup;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  settings.timeZone = "UTC";
  root = mkdtempSync(join(tmpdir(), "wakeup-scheduler-test-"));
  store = new WakeupStore(join(root, "wakeups"));
  sessions = new Map([["s1", {}]]);
  busy = new Set();
  deliver = vi.fn((): DeliveryResult => ({ ok: true, delivery: "sent" }));
  scheduler = newScheduler();
  scheduler.startAll();
});

afterEach(() => {
  scheduler.destroy();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe("creating wake-ups", () => {
  // Every input mistake comes back as a 400 with the reason; the session
  // must exist and not be archived.
  it("validates the request", () => {
    const base = { sessionId: "s1", message: "hi", at: "2026-10-05T12:00" };
    expect(scheduler.create({ ...base, sessionId: "nope" })).toMatchObject({ ok: false, status: 404 });
    sessions.set("old", { archived: true });
    expect(scheduler.create({ ...base, sessionId: "old" })).toMatchObject({ ok: false, status: 409 });
    expect(scheduler.create({ ...base, message: "  " })).toMatchObject({ ok: false, status: 400, error: "message is required" });
    expect(scheduler.create({ ...base, message: "x".repeat(70_000) })).toMatchObject({ ok: false, status: 400 });
    expect(scheduler.create({ ...base, cron: "0 9 * * *" })).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one/) });
    expect(scheduler.create({ sessionId: "s1", message: "hi" })).toMatchObject({ ok: false, error: expect.stringMatching(/exactly one/) });
    expect(scheduler.create({ ...base, at: 5 })).toMatchObject({ ok: false, error: "at must be a string" });
    expect(scheduler.create({ ...base, at: "2026-10-05T09:00" })).toMatchObject({ ok: false, error: expect.stringMatching(/is in the past/) });
    expect(scheduler.create({ sessionId: "s1", message: "hi", cron: "0 0 9 * * *" })).toMatchObject({ ok: false, error: expect.stringMatching(/seconds field/) });
    expect(scheduler.create({ ...base, createdBy: "admin" })).toMatchObject({ ok: false, error: expect.stringMatching(/createdBy/) });
    expect(store.list()).toEqual([]);
  });

  // A local date-time is read in the global timeZone setting.
  it("stores a one-shot with its instant and who set it", () => {
    settings.timeZone = "Europe/Rome";
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", at: "2026-10-05T14:30", createdBy: "session:s1" }));
    expect(w).toMatchObject({
      sessionId: "s1",
      schedule: { at: "2026-10-05T14:30" },
      createdBy: "session:s1",
      enabled: true,
      status: "pending",
      nextRunAt: Date.parse("2026-10-05T12:30:00Z"),
    });
    expect(w.id).toMatch(/^wk-[0-9a-f]{12}$/);
    expect(store.get(w.id)).toEqual(w);
    expect(scheduler.listForSession("s1")).toEqual([w]);
  });

  it("caps the pending wake-ups of one session", () => {
    for (let i = 0; i < 50; i++) created(scheduler.create({ sessionId: "s1", message: `m${i}`, cron: "0 9 * * *" }));
    expect(scheduler.create({ sessionId: "s1", message: "one more", cron: "0 9 * * *" })).toMatchObject({ ok: false, status: 409 });
  });

  // Sessions (the companion MCP tools) may have at most 50 pending wake-ups
  // across ALL sessions; the user's own wake-ups do not count and are never
  // refused by this cap. Spent or cancelled ones free their slot.
  it("caps the pending wake-ups created by sessions, all sessions together", () => {
    for (const id of ["a", "b"]) sessions.set(id, {});
    created(scheduler.create({ sessionId: "s1", message: "user", cron: "0 9 * * *" }));
    const first = created(scheduler.create({ sessionId: "a", message: "a0", cron: "0 9 * * *", createdBy: "session:a" }));
    for (let i = 1; i < MAX_PENDING_BY_SESSIONS; i++) {
      const sid = i % 2 ? "a" : "b";
      created(scheduler.create({ sessionId: sid, message: `m${i}`, cron: "0 9 * * *", createdBy: `session:${sid}` }));
    }
    const over = scheduler.create({ sessionId: "b", message: "over", cron: "0 9 * * *", createdBy: "session:b" });
    expect(over).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/already have 50 pending wake-ups/) });
    created(scheduler.create({ sessionId: "b", message: "the user can", cron: "0 9 * * *" }));

    expect(scheduler.cancel("a", first.id)).toBe(true);
    created(scheduler.create({ sessionId: "b", message: "fits again", cron: "0 9 * * *", createdBy: "session:b" }));
  });

  // Review finding: 50 per-minute wake-ups would force ~50 turns a minute.
  // Repeating wake-ups set by sessions must be 15+ minutes apart; one-shots
  // (the way to poll more often) and the user's own are not limited.
  it("refuses repeating wake-ups under 15 minutes from sessions", () => {
    const tight = scheduler.create({ sessionId: "s1", message: "poll", cron: "*/5 * * * *", createdBy: "session:s1" });
    expect(tight).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/at least 15 minutes apart.*one-time wake-up/) });
    created(scheduler.create({ sessionId: "s1", message: "poll", cron: "*/15 * * * *", createdBy: "session:s1" }));
    created(scheduler.create({ sessionId: "s1", message: "soon", at: "2026-10-05T10:01", createdBy: "session:s1" }));
    created(scheduler.create({ sessionId: "s1", message: "user poll", cron: "* * * * *" }));
  });
});

describe("firing", () => {
  // The delivered text tells the agent it is a scheduled wake-up; a spent
  // one-shot is kept (status delivered) so the UI can say what happened.
  it("delivers a one-shot at its time with the wake-up prefix", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "check the deploy", at: "2026-10-05T11:00:00Z" }));

    vi.advanceTimersByTime(HOUR - 1000);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);

    expect(deliver).toHaveBeenCalledWith(
      "s1",
      `[scheduled wake-up ${w.id}, set 2026-10-05T10:00:00.000Z by user]\n\ncheck the deploy`,
    );
    expect(store.get(w.id)).toMatchObject({ enabled: false, status: "delivered", lastFiredAt: expect.any(Number) });
  });

  it("delivers a cron wake-up on every occurrence and keeps it pending", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "standup", cron: "0 * * * *" }));
    expect(w.nextRunAt).toBe(Date.parse("2026-10-05T11:00:00Z"));

    vi.advanceTimersByTime(2 * HOUR + 1000);

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][1]).toContain(`repeats "0 * * * *"`);
    expect(store.get(w.id)).toMatchObject({ enabled: true, status: "pending", nextRunAt: Date.parse("2026-10-05T13:00:00Z") });
  });

  // A running turn is never interrupted: the message waits for the turn's
  // result (or, failing that, a periodic re-check).
  it("holds a wake-up while a turn runs and delivers it on the turn's result", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "later", at: "2026-10-05T10:30:00Z" }));
    busy.add("s1");

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.get(w.id)?.status).toBe("pending");

    companionBus.emit("message:result", { sessionId: "other", message: { type: "result" } as never });
    expect(deliver).not.toHaveBeenCalled();
    companionBus.emit("message:result", { sessionId: "s1", message: { type: "result" } as never });
    expect(deliver).not.toHaveBeenCalled(); // still busy

    busy.delete("s1");
    companionBus.emit("message:result", { sessionId: "s1", message: { type: "result" } as never });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.get(w.id)?.status).toBe("delivered");
  });

  // A time zone change must not turn a wake-up that is already due (waiting
  // for the turn to end) into a "missed" one.
  it("keeps a held wake-up across a time zone change", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "later", at: "2026-10-05T10:30:00Z" }));
    busy.add("s1");
    vi.advanceTimersByTime(31 * 60 * 1000);

    settings.timeZone = "Europe/Rome";
    scheduler.rescheduleAll();
    expect(store.get(w.id)?.status).toBe("pending");

    busy.delete("s1");
    companionBus.emit("message:result", { sessionId: "s1", message: { type: "result" } as never });
    expect(store.get(w.id)?.status).toBe("delivered");
  });

  it("re-checks held wake-ups periodically and gives up waiting after 30 minutes", () => {
    created(scheduler.create({ sessionId: "s1", message: "later", at: "2026-10-05T10:30:00Z" }));
    busy.add("s1");
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // Archived or deleted sessions: the wake-up is skipped, with the reason.
  it("skips a one-shot whose session was archived", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", at: "2026-10-05T10:30:00Z" }));
    sessions.set("s1", { archived: true });

    vi.advanceTimersByTime(31 * 60 * 1000);

    expect(deliver).not.toHaveBeenCalled();
    expect(store.get(w.id)).toMatchObject({ enabled: false, status: "skipped", lastResult: expect.stringContaining("the session is archived") });
  });

  it("keeps a recurring wake-up armed while its session is archived, and stops it once the session is gone", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", cron: "0 * * * *" }));
    sessions.set("s1", { archived: true });
    vi.advanceTimersByTime(HOUR + 1000);
    expect(store.get(w.id)).toMatchObject({ enabled: true, status: "pending", lastResult: expect.stringContaining("archived") });

    sessions.delete("s1");
    vi.advanceTimersByTime(HOUR);
    expect(store.get(w.id)).toMatchObject({ enabled: false, status: "skipped", lastResult: expect.stringContaining("no longer exists") });
    vi.advanceTimersByTime(HOUR);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("skips when the delivery itself is refused", () => {
    deliver.mockReturnValue({ ok: false, status: 409, error: "Session is archived" });
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", at: "2026-10-05T10:30:00Z" }));
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(store.get(w.id)).toMatchObject({ status: "skipped", lastResult: expect.stringContaining("session is archived") });
  });
});

describe("restart", () => {
  function saved(overrides: Partial<SessionWakeup>): SessionWakeup {
    const w: SessionWakeup = {
      id: "wk-saved",
      sessionId: "s1",
      message: "from before the restart",
      schedule: { at: "2026-10-05T09:00:00Z" },
      createdAt: NOW.getTime() - 2 * HOUR,
      createdBy: "user",
      enabled: true,
      status: "pending",
      ...overrides,
    };
    store.save(w);
    return w;
  }

  function restart(): void {
    scheduler.destroy();
    scheduler = newScheduler();
    scheduler.startAll();
  }

  // Missed by an hour (< 24 h) while the server was down: fire once now.
  it("fires a one-shot missed by less than 24 hours once at startup", () => {
    saved({ nextRunAt: NOW.getTime() - HOUR });
    restart();
    vi.advanceTimersByTime(0);

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.get("wk-saved")?.status).toBe("delivered");

    restart();
    vi.advanceTimersByTime(HOUR);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  // Missed by more than a day: too stale to act on; report it instead.
  it("marks a one-shot missed by 24 hours or more as missed", () => {
    saved({ nextRunAt: NOW.getTime() - 25 * HOUR, schedule: { at: "2026-10-04T09:00:00Z" } });
    restart();
    vi.advanceTimersByTime(HOUR);

    expect(deliver).not.toHaveBeenCalled();
    expect(store.get("wk-saved")).toMatchObject({ enabled: false, status: "missed", lastResult: expect.stringContaining("Missed") });
  });

  it("re-arms future one-shots and recurring wake-ups", () => {
    saved({ id: "wk-future", schedule: { at: "2026-10-05T12:00:00Z" }, nextRunAt: Date.parse("2026-10-05T12:00:00Z") });
    saved({ id: "wk-cron", schedule: { cron: "30 * * * *" } });
    restart();

    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(1); // 10:30 cron
    vi.advanceTimersByTime(90 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(3); // 11:30 cron, 12:00 one-shot
  });

  it("drops spent wake-ups a week after their last event", () => {
    saved({ id: "wk-old", enabled: false, status: "delivered", createdAt: NOW.getTime() - 9 * 24 * HOUR, lastFiredAt: NOW.getTime() - 8 * 24 * HOUR, nextRunAt: undefined });
    saved({ id: "wk-recent", enabled: false, status: "missed", createdAt: NOW.getTime() - 2 * HOUR });
    restart();
    expect(store.list().map((w) => w.id)).toEqual(["wk-recent"]);
  });

  it("reports a wake-up it cannot arm", () => {
    saved({ id: "wk-bad", schedule: { cron: "not a cron" } });
    restart();
    expect(store.get("wk-bad")?.lastResult).toMatch(/^Not armed:/);
  });
});

describe("cancel, delete and time zone", () => {
  it("cancels a wake-up of the same session only", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", at: "2026-10-05T10:30:00Z" }));
    expect(scheduler.cancel("other", w.id)).toBe(false);
    expect(scheduler.cancel("s1", w.id)).toBe(true);
    expect(scheduler.cancel("s1", "wk-unknown")).toBe(false);

    vi.advanceTimersByTime(HOUR);
    expect(deliver).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it("drops every wake-up of a deleted session", () => {
    created(scheduler.create({ sessionId: "s1", message: "a", cron: "0 * * * *" }));
    sessions.set("s2", {});
    const keep = created(scheduler.create({ sessionId: "s2", message: "b", cron: "0 * * * *" }));

    scheduler.handleSessionDeleted("s1");
    vi.advanceTimersByTime(HOUR + 1000);

    expect(store.list().map((w) => w.id)).toEqual([keep.id]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("s2");
  });

  // A local date-time names a different instant once the zone changes.
  it("re-reads local one-shot times in the new zone", () => {
    const w = created(scheduler.create({ sessionId: "s1", message: "hi", at: "2026-10-05T14:00" }));
    expect(w.nextRunAt).toBe(Date.parse("2026-10-05T14:00:00Z"));

    settings.timeZone = "Europe/Rome";
    scheduler.rescheduleAll();

    expect(store.get(w.id)?.nextRunAt).toBe(Date.parse("2026-10-05T12:00:00Z"));
    vi.advanceTimersByTime(2 * HOUR + 1000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("wakeupMessageText", () => {
  it("names the wake-up, when and by whom it was set", () => {
    expect(wakeupMessageText({
      id: "wk-1", sessionId: "s", message: "go", schedule: { at: "x" }, createdAt: 0,
      createdBy: "session:abc", enabled: true, status: "pending",
    })).toBe("[scheduled wake-up wk-1, set 1970-01-01T00:00:00.000Z by session:abc]\n\ngo");
  });
});
