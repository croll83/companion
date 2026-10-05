import { Cron } from "croner";
import { randomBytes } from "node:crypto";
import type { DeliveryResult } from "./session-delivery.js";
import { companionBus } from "./event-bus.js";
import { nextScheduledRun, scheduleTimeZone, validateSchedule } from "./agent-schedule.js";
import { WakeupStore, type SessionWakeup, type WakeupSchedule } from "./wakeup-store.js";

/** A one-shot missed by less than this while the server was down still fires at startup. */
const MISSED_GRACE_MS = 24 * 60 * 60 * 1000;
/** While a turn is running, re-check deferred wake-ups this often (a result also re-checks). */
const DEFER_POLL_MS = 30_000;
/** Deliver anyway after waiting this long for a turn to end (the CLI then queues or steers it). */
const MAX_DEFER_MS = 30 * 60 * 1000;
/** Spent wake-ups (delivered, skipped, missed) are dropped this long after their last event. */
const SPENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Armed wake-ups allowed per session. */
const MAX_PENDING_PER_SESSION = 50;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const CREATED_BY_PATTERN = /^(user|session:[A-Za-z0-9_-]+)$/;

export interface WakeupSchedulerDeps {
  /** The launcher's view of a session (undefined once deleted). */
  getSession(sessionId: string): { archived?: boolean } | undefined;
  /** Deliver a user message, relaunching a dead CLI (see deliverUserMessage). */
  deliver(sessionId: string, content: string): DeliveryResult;
  /** True while a turn runs in the session's live CLI (see isTurnBusy). */
  isBusy(sessionId: string): boolean;
  store?: WakeupStore;
  now?: () => number;
}

export interface CreateWakeupInput {
  sessionId: string;
  message: unknown;
  /** ISO date-time or local "YYYY-MM-DDTHH:mm" (global timeZone setting). */
  at?: unknown;
  /** 5-field cron expression (global timeZone setting). */
  cron?: unknown;
  createdBy?: unknown;
}

export type CreateWakeupResult =
  | { ok: true; wakeup: SessionWakeup }
  | { ok: false; status: 400 | 404 | 409; error: string };

function isOneShot(schedule: WakeupSchedule): schedule is { at: string } {
  return "at" in schedule;
}

/** The text actually delivered: tells the agent this turn is a scheduled wake-up. */
export function wakeupMessageText(wakeup: SessionWakeup): string {
  const set = new Date(wakeup.createdAt).toISOString();
  const repeat = isOneShot(wakeup.schedule) ? "" : `, repeats "${wakeup.schedule.cron}"`;
  return `[scheduled wake-up ${wakeup.id}, set ${set} by ${wakeup.createdBy}${repeat}]\n\n${wakeup.message}`;
}

/**
 * Scheduled messages into existing sessions ("wake-ups").
 *
 * A wake-up keeps the session's whole context: it is delivered as a user
 * message into the same session. A dead CLI is relaunched on its saved
 * conversation first; a running turn is never interrupted (the message waits
 * for the turn's result). Timers use croner in the global timeZone setting
 * and are restored at startup; a one-shot whose time passed while the server
 * was down fires once if it is less than 24 h late, otherwise it is marked
 * missed. Works the same for Claude Code and Codex sessions.
 */
export class WakeupScheduler {
  private store: WakeupStore;
  private deps: WakeupSchedulerDeps;
  private now: () => number;
  private timers = new Map<string, Cron>();
  /** Wake-ups due but held back by a running turn: id → when they first came due. */
  private deferred = new Map<string, number>();
  private deferTimer: ReturnType<typeof setInterval> | null = null;
  private onResult = ({ sessionId }: { sessionId: string }) => this.retryDeferred(sessionId);
  private started = false;

  constructor(deps: WakeupSchedulerDeps) {
    this.deps = deps;
    this.store = deps.store ?? new WakeupStore();
    this.now = deps.now ?? Date.now;
  }

  /** Restore every armed wake-up from disk. Called once at server startup. */
  startAll(): void {
    if (!this.started) {
      this.started = true;
      companionBus.on("message:result", this.onResult);
    }
    let armed = 0;
    for (const wakeup of this.store.list()) {
      if (this.pruneSpent(wakeup)) continue;
      if (!wakeup.enabled) continue;
      if (this.arm(wakeup, { startup: true })) armed++;
    }
    if (armed > 0) console.log(`[wakeups] Restored ${armed} wake-up(s)`);
  }

  /** Re-arm every wake-up, e.g. after the global timeZone setting changed. */
  rescheduleAll(): void {
    for (const wakeup of this.store.list()) {
      // Already due and waiting for a turn to end: nothing to re-arm.
      if (!wakeup.enabled || this.deferred.has(wakeup.id)) continue;
      if (isOneShot(wakeup.schedule)) {
        // A local date-time names a different instant in the new zone.
        const next = this.oneShotInstant(wakeup.schedule.at);
        if (next !== null) wakeup.nextRunAt = next;
      }
      this.arm(wakeup, { startup: false });
    }
  }

  listForSession(sessionId: string): SessionWakeup[] {
    return this.store.list().filter((w) => w.sessionId === sessionId);
  }

  create(input: CreateWakeupInput): CreateWakeupResult {
    const session = this.deps.getSession(input.sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    if (session.archived) return { ok: false, status: 409, error: "Session is archived" };

    if (typeof input.message !== "string" || !input.message.trim()) {
      return { ok: false, status: 400, error: "message is required" };
    }
    if (input.message.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, status: 400, error: `message exceeds ${MAX_MESSAGE_LENGTH / 1024} KB` };
    }
    const createdBy = input.createdBy === undefined ? "user" : input.createdBy;
    if (typeof createdBy !== "string" || !CREATED_BY_PATTERN.test(createdBy)) {
      return { ok: false, status: 400, error: 'createdBy must be "user" or "session:<id>"' };
    }

    const hasAt = input.at !== undefined && input.at !== null && input.at !== "";
    const hasCron = input.cron !== undefined && input.cron !== null && input.cron !== "";
    if (hasAt === hasCron) {
      return { ok: false, status: 400, error: "Give exactly one of at (date-time) or cron (expression)" };
    }
    const expression = hasAt ? input.at : input.cron;
    if (typeof expression !== "string") {
      return { ok: false, status: 400, error: `${hasAt ? "at" : "cron"} must be a string` };
    }
    const invalid = validateSchedule(
      { enabled: true, expression, recurring: hasCron },
      { rejectPast: true },
    );
    if (invalid) return { ok: false, status: 400, error: invalid };

    const pending = this.listForSession(input.sessionId).filter((w) => w.enabled).length;
    if (pending >= MAX_PENDING_PER_SESSION) {
      return { ok: false, status: 409, error: `This session already has ${MAX_PENDING_PER_SESSION} pending wake-ups` };
    }

    const wakeup: SessionWakeup = {
      id: `wk-${randomBytes(6).toString("hex")}`,
      sessionId: input.sessionId,
      message: input.message,
      schedule: hasAt ? { at: expression.trim() } : { cron: expression.trim() },
      createdAt: this.now(),
      createdBy,
      enabled: true,
      status: "pending",
    };
    if (hasAt) wakeup.nextRunAt = this.oneShotInstant(expression.trim()) ?? undefined;
    this.arm(wakeup, { startup: false });
    console.log(`[wakeups] Created ${wakeup.id} for session ${wakeup.sessionId} (${hasAt ? `at ${expression}` : `cron "${expression}"`}) by ${createdBy}`);
    return { ok: true, wakeup };
  }

  /** Cancel (and forget) a wake-up of the session. */
  cancel(sessionId: string, id: string): boolean {
    const wakeup = this.store.get(id);
    if (!wakeup || wakeup.sessionId !== sessionId) return false;
    this.disarm(id);
    return this.store.remove(id);
  }

  /** The session was deleted: its wake-ups can never be delivered. */
  handleSessionDeleted(sessionId: string): void {
    for (const wakeup of this.listForSession(sessionId)) {
      this.disarm(wakeup.id);
      this.store.remove(wakeup.id);
    }
  }

  /** Stop all timers (shutdown, tests). */
  destroy(): void {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
    this.deferred.clear();
    this.stopDeferPoll();
    if (this.started) companionBus.off("message:result", this.onResult);
    this.started = false;
  }

  // ── Arming ────────────────────────────────────────────────────────────────

  /** Arm (or re-arm) a wake-up and persist it. Returns false if it could not be armed. */
  private arm(wakeup: SessionWakeup, opts: { startup: boolean }): boolean {
    this.disarm(wakeup.id);
    const timezone = scheduleTimeZone();
    try {
      if (!isOneShot(wakeup.schedule)) {
        const timer = new Cron(wakeup.schedule.cron, { mode: "5-part", timezone }, () => this.fire(wakeup.id));
        this.timers.set(wakeup.id, timer);
        wakeup.nextRunAt = timer.nextRun()?.getTime();
        this.store.save(wakeup);
        return true;
      }
      const target = wakeup.nextRunAt ?? this.oneShotInstant(wakeup.schedule.at);
      if (target === null || target === undefined) throw new Error(`Cannot read the date "${wakeup.schedule.at}"`);
      wakeup.nextRunAt = target;
      if (target > this.now()) {
        this.timers.set(wakeup.id, new Cron(new Date(target), () => this.fire(wakeup.id)));
        this.store.save(wakeup);
        return true;
      }
      if (opts.startup && this.now() - target < MISSED_GRACE_MS) {
        // Late but within the grace window: fire once, right after startup.
        this.store.save(wakeup);
        setTimeout(() => this.fire(wakeup.id), 0);
        return true;
      }
      this.spend(wakeup, "missed", `Missed: the server was not running at ${new Date(target).toISOString()}`);
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wakeup.lastResult = `Not armed: ${message}`;
      this.store.save(wakeup);
      console.warn(`[wakeups] Could not arm ${wakeup.id}: ${message}`);
      return false;
    }
  }

  private disarm(id: string): void {
    this.timers.get(id)?.stop();
    this.timers.delete(id);
    this.deferred.delete(id);
    if (this.deferred.size === 0) this.stopDeferPoll();
  }

  /** The instant (ms) a one-shot "at" names in the current zone, or null if past/invalid. */
  private oneShotInstant(at: string): number | null {
    try {
      return nextScheduledRun({ enabled: true, expression: at, recurring: false }, scheduleTimeZone())?.getTime() ?? null;
    } catch {
      return null;
    }
  }

  // ── Firing ────────────────────────────────────────────────────────────────

  private fire(id: string): void {
    const wakeup = this.store.get(id);
    if (!wakeup?.enabled) return;
    const oneShot = isOneShot(wakeup.schedule);
    if (oneShot) {
      this.timers.get(id)?.stop();
      this.timers.delete(id);
    }

    const session = this.deps.getSession(wakeup.sessionId);
    if (!session || session.archived) {
      this.skip(wakeup, session ? "the session is archived" : "the session no longer exists", !session);
      return;
    }

    const dueSince = this.deferred.get(id);
    if (this.deps.isBusy(wakeup.sessionId) && (dueSince === undefined || this.now() - dueSince < MAX_DEFER_MS)) {
      // Never interrupt a running turn: wait for its result.
      if (dueSince === undefined) this.deferred.set(id, this.now());
      this.startDeferPoll();
      return;
    }
    this.deferred.delete(id);
    if (this.deferred.size === 0) this.stopDeferPoll();

    const result = this.deps.deliver(wakeup.sessionId, wakeupMessageText(wakeup));
    if (!result.ok) {
      this.skip(wakeup, result.error.toLowerCase(), result.status === 404);
      return;
    }
    wakeup.lastFiredAt = this.now();
    wakeup.lastResult = undefined;
    console.log(`[wakeups] Delivered ${wakeup.id} to session ${wakeup.sessionId} (${result.delivery})`);
    if (oneShot) {
      this.spend(wakeup, "delivered");
    } else {
      wakeup.nextRunAt = this.timers.get(id)?.nextRun()?.getTime();
      this.store.save(wakeup);
    }
  }

  /**
   * A firing whose session is archived or gone. A one-shot is spent; a
   * recurring one keeps its schedule while the session merely is archived
   * (it may come back) and stops once the session no longer exists.
   */
  private skip(wakeup: SessionWakeup, reason: string, sessionGone: boolean): void {
    const text = `Skipped at ${new Date(this.now()).toISOString()}: ${reason}`;
    console.log(`[wakeups] ${wakeup.id} (session ${wakeup.sessionId}): ${text}`);
    this.deferred.delete(wakeup.id);
    if (isOneShot(wakeup.schedule) || sessionGone) {
      this.disarm(wakeup.id);
      this.spend(wakeup, "skipped", text);
      return;
    }
    wakeup.lastResult = text;
    wakeup.nextRunAt = this.timers.get(wakeup.id)?.nextRun()?.getTime();
    this.store.save(wakeup);
  }

  private spend(wakeup: SessionWakeup, status: SessionWakeup["status"], lastResult?: string): void {
    wakeup.enabled = false;
    wakeup.status = status;
    if (lastResult !== undefined) wakeup.lastResult = lastResult;
    this.store.save(wakeup);
  }

  /** A turn ended in this session: deliver what was waiting for it. */
  private retryDeferred(sessionId: string): void {
    for (const id of [...this.deferred.keys()]) {
      const wakeup = this.store.get(id);
      if (!wakeup) {
        this.deferred.delete(id);
        continue;
      }
      if (wakeup.sessionId === sessionId) this.fire(id);
    }
  }

  private startDeferPoll(): void {
    if (this.deferTimer) return;
    this.deferTimer = setInterval(() => {
      for (const id of [...this.deferred.keys()]) this.fire(id);
    }, DEFER_POLL_MS);
  }

  private stopDeferPoll(): void {
    if (!this.deferTimer) return;
    clearInterval(this.deferTimer);
    this.deferTimer = null;
  }

  /** Drop a spent wake-up a week after its last event. Returns true if dropped. */
  private pruneSpent(wakeup: SessionWakeup): boolean {
    if (wakeup.enabled) return false;
    const last = Math.max(wakeup.createdAt, wakeup.lastFiredAt ?? 0, wakeup.nextRunAt ?? 0);
    if (this.now() - last < SPENT_RETENTION_MS) return false;
    this.store.remove(wakeup.id);
    return true;
  }
}
