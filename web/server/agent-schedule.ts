import { Cron } from "croner";
import type { AgentConfig } from "./agent-types.js";
import { getSettings } from "./settings-manager.js";

/**
 * Agent schedule rules, shared by the API (validation on create/update) and
 * the executor (arming timers), so both agree on what a schedule means:
 *  - recurring: a 5-field cron expression (minute precision). A seconds field
 *    (6 or 7 fields) is rejected — croner would otherwise read the first
 *    field as seconds and fire 60x more often than the user meant.
 *  - one-shot: a local date-time "YYYY-MM-DDTHH:mm[:ss]" (what the editor's
 *    datetime-local input produces). An explicit offset/Z is honoured.
 *  - both run in the global timeZone setting; "" means the server's zone.
 */

type ScheduleTrigger = NonNullable<NonNullable<AgentConfig["triggers"]>["schedule"]>;

const ONE_SHOT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NICKNAME_PATTERN = /^@(yearly|annually|monthly|weekly|daily|hourly)$/i;

/** IANA zone schedules run in, or undefined for the server's local zone. */
export function scheduleTimeZone(): string | undefined {
  return getSettings().timeZone?.trim() || undefined;
}

/** Human label of the zone schedules run in (for messages and the UI). */
export function scheduleTimeZoneLabel(timezone = scheduleTimeZone()): string {
  return timezone ?? `server local time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^CronPattern: /, "");
}

/**
 * Build a croner instance for the schedule without arming it (paused, no
 * callback). Throws a user-readable Error when the schedule or zone is invalid.
 */
function parseSchedule(schedule: ScheduleTrigger, timezone: string | undefined): Cron {
  const cron = buildCron(schedule, timezone);
  try {
    // croner only resolves the zone when computing a run time.
    cron.nextRun();
  } catch (err) {
    throw new Error(`Cannot schedule in time zone "${timezone}": ${describeError(err)}`);
  }
  return cron;
}

function buildCron(schedule: ScheduleTrigger, timezone: string | undefined): Cron {
  const expression = schedule.expression.trim();
  if (!expression) throw new Error("Schedule expression is empty");
  if (schedule.recurring) {
    const fields = expression.split(/\s+/).length;
    if (!NICKNAME_PATTERN.test(expression) && fields > 5) {
      throw new Error(
        `Invalid cron expression "${expression}": schedules use 5 fields (minute hour day-of-month month day-of-week); a seconds field is not supported`,
      );
    }
    try {
      return new Cron(expression, { mode: "5-part", paused: true, timezone });
    } catch (err) {
      throw new Error(`Invalid cron expression "${expression}": ${describeError(err)}`);
    }
  }
  if (!ONE_SHOT_PATTERN.test(expression)) {
    throw new Error(`Invalid one-time date "${expression}": expected YYYY-MM-DDTHH:mm`);
  }
  try {
    return new Cron(expression, { paused: true, timezone });
  } catch (err) {
    throw new Error(`Invalid one-time date "${expression}": ${describeError(err)}`);
  }
}

/**
 * Validate an agent's schedule trigger. Returns an error message, or null if
 * it is fine. Disabled or absent schedules are not checked. With `rejectPast`,
 * a one-shot date that has already passed is an error too.
 */
export function validateSchedule(
  schedule: ScheduleTrigger | undefined,
  opts: { rejectPast?: boolean; timezone?: string } = {},
): string | null {
  if (!schedule?.enabled) return null;
  if (typeof schedule.expression !== "string") return "Schedule expression is required";
  const timezone = "timezone" in opts ? opts.timezone : scheduleTimeZone();
  try {
    const cron = parseSchedule(schedule, timezone);
    if (!schedule.recurring && opts.rejectPast && !cron.nextRun()) {
      return `The one-time date ${schedule.expression.trim()} (${scheduleTimeZoneLabel(timezone)}) is in the past`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * When the schedule fires next, or null if a one-shot date is in the past.
 * Throws (user-readable) for an invalid schedule.
 */
export function nextScheduledRun(schedule: ScheduleTrigger, timezone: string | undefined): Date | null {
  return parseSchedule(schedule, timezone).nextRun();
}

/**
 * Smallest gap between two runs of a repeating schedule that a session may
 * set through its `companion` MCP tools (agents and wake-ups). Each agent
 * run is a new CLI process and each wake-up a new turn: without a floor, a
 * handful of per-minute schedules could start hundreds of CLIs.
 */
export const MCP_MIN_CRON_INTERVAL_MINUTES = 15;

/** How many upcoming runs are compared; enough to catch "0-1 9 * * *"-style bursts. */
const INTERVAL_SAMPLE_RUNS = 100;

/**
 * True when two consecutive upcoming runs of the 5-field cron `expression`
 * are less than `minutes` apart. An invalid expression is not judged here
 * (validateSchedule reports it) and returns false.
 */
export function cronRunsMoreOftenThan(expression: string, minutes: number, timezone = scheduleTimeZone()): boolean {
  let runs: Date[];
  try {
    runs = buildCron({ enabled: true, expression, recurring: true }, timezone).nextRuns(INTERVAL_SAMPLE_RUNS);
  } catch {
    return false;
  }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < minutes * 60_000) return true;
  }
  return false;
}
