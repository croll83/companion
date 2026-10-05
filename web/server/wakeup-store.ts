import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * When a wake-up fires: once at an instant, or on a 5-field cron expression.
 * `at` is either an ISO date-time with an offset/Z or a local date-time
 * ("YYYY-MM-DDTHH:mm") read in the global timeZone setting. Cron expressions
 * run in that zone too.
 */
export type WakeupSchedule = { at: string } | { cron: string };

/**
 * Where a wake-up stands. A recurring one stays "pending" while armed; its
 * last skip (if any) is in `lastResult`.
 *  - pending:   armed, waiting for its time (or for the current turn to end)
 *  - delivered: one-shot, message handed to the session
 *  - skipped:   one-shot whose session was archived or deleted when it fired
 *  - missed:    one-shot whose time passed while the server was down for 24 h or more
 */
export type WakeupStatus = "pending" | "delivered" | "skipped" | "missed";

/** A message scheduled into an existing session ("wake-up"). */
export interface SessionWakeup {
  id: string;
  /** Companion session the message is delivered to. */
  sessionId: string;
  /** Text delivered as a user message (prefixed so the agent knows it is scheduled). */
  message: string;
  schedule: WakeupSchedule;
  createdAt: number;
  /** "user" (UI/API) or "session:<id>" when a session scheduled it. */
  createdBy: string;
  /** Last time it was delivered (ms). */
  lastFiredAt?: number;
  /** Next planned fire time (ms), when armed. For a one-shot: its instant. */
  nextRunAt?: number;
  /** False once a one-shot is spent (delivered, skipped or missed). */
  enabled: boolean;
  status: WakeupStatus;
  /** Why the last firing did not deliver (skipped, missed, failed), for the UI. */
  lastResult?: string;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * One JSON file per wake-up under COMPANION_HOME/wakeups/ (0600 files in a
 * 0700 dir: messages can carry anything the user typed).
 */
export class WakeupStore {
  private dir: string;

  constructor(dir: string = join(COMPANION_HOME, "wakeups")) {
    this.dir = dir;
  }

  get directory(): string {
    return this.dir;
  }

  private path(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid wake-up id "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  list(): SessionWakeup[] {
    if (!existsSync(this.dir)) return [];
    const out: SessionWakeup[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, file), "utf-8")) as SessionWakeup;
        if (parsed && typeof parsed.id === "string" && typeof parsed.sessionId === "string") out.push(parsed);
      } catch {
        console.warn(`[wakeup-store] Skipping unreadable wake-up file ${file}`);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): SessionWakeup | null {
    try {
      return JSON.parse(readFileSync(this.path(id), "utf-8")) as SessionWakeup;
    } catch {
      return null;
    }
  }

  save(wakeup: SessionWakeup): void {
    mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    try { chmodSync(this.dir, DIR_MODE); } catch { /* best effort */ }
    const path = this.path(wakeup.id);
    writeFileSync(path, JSON.stringify(wakeup, null, 2), { encoding: "utf-8", mode: FILE_MODE });
    chmodSync(path, FILE_MODE);
  }

  remove(id: string): boolean {
    try {
      unlinkSync(this.path(id));
      return true;
    } catch {
      return false;
    }
  }
}
