import { describe, it, expect, vi, beforeEach } from "vitest";

// Settings are mocked so tests control the global timeZone setting without
// reading the real ~/.companion/settings.json. croner is NOT mocked: these
// tests pin down what the real scheduler accepts.
const mockSettings = vi.hoisted(() => ({ timeZone: "" }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ timeZone: mockSettings.timeZone }),
}));

import { nextScheduledRun, scheduleTimeZone, scheduleTimeZoneLabel, validateSchedule } from "./agent-schedule.js";

const recurring = (expression: string) => ({ enabled: true, expression, recurring: true });
const oneShot = (expression: string) => ({ enabled: true, expression, recurring: false });

beforeEach(() => {
  mockSettings.timeZone = "";
});

describe("scheduleTimeZone", () => {
  it("is the global timeZone setting, or undefined (server local) when empty", () => {
    expect(scheduleTimeZone()).toBeUndefined();
    mockSettings.timeZone = "Europe/Rome";
    expect(scheduleTimeZone()).toBe("Europe/Rome");
  });

  it("labels the server zone explicitly when no zone is set", () => {
    expect(scheduleTimeZoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(scheduleTimeZoneLabel(undefined)).toMatch(/^server local time \(.+\)$/);
  });
});

describe("validateSchedule", () => {
  it("accepts 5-field cron expressions and nicknames", () => {
    expect(validateSchedule(recurring("0 8 * * 1-5"))).toBeNull();
    expect(validateSchedule(recurring("*/30 * * * *"))).toBeNull();
    expect(validateSchedule(recurring("@daily"))).toBeNull();
  });

  it("rejects a seconds field (6 or 7 fields) with an explicit message", () => {
    // croner would read the first field as seconds and fire far more often.
    expect(validateSchedule(recurring("0 0 8 * * *"))).toMatch(/5 fields .*a seconds field is not supported/);
    expect(validateSchedule(recurring("0 0 8 * * * 2030"))).toMatch(/a seconds field is not supported/);
  });

  it("rejects malformed cron expressions with croner's reason", () => {
    expect(validateSchedule(recurring("61 * * * *"))).toBe('Invalid cron expression "61 * * * *": Invalid value for minute: 61');
    expect(validateSchedule(recurring("* * *"))).toMatch(/^Invalid cron expression "\* \* \*"/);
    expect(validateSchedule(recurring("   "))).toBe("Schedule expression is empty");
  });

  it("ignores disabled or absent schedules", () => {
    expect(validateSchedule(undefined)).toBeNull();
    expect(validateSchedule({ enabled: false, expression: "garbage", recurring: true })).toBeNull();
  });

  it("requires a string expression", () => {
    expect(validateSchedule({ enabled: true, expression: 5 as unknown as string, recurring: true })).toBe("Schedule expression is required");
  });

  it("accepts a future one-time date and rejects other strings", () => {
    expect(validateSchedule(oneShot("2999-01-05T10:00"))).toBeNull();
    expect(validateSchedule(oneShot("tomorrow"))).toBe('Invalid one-time date "tomorrow": expected YYYY-MM-DDTHH:mm');
    expect(validateSchedule(oneShot("2999-13-45T10:00"))).toMatch(/^Invalid one-time date "2999-13-45T10:00"/);
  });

  it("reports a past one-time date only when asked to", () => {
    expect(validateSchedule(oneShot("2020-01-05T10:00"))).toBeNull();
    expect(validateSchedule(oneShot("2020-01-05T10:00"), { rejectPast: true, timezone: "Europe/Rome" }))
      .toBe("The one-time date 2020-01-05T10:00 (Europe/Rome) is in the past");
  });

  it("validates against an invalid configured time zone", () => {
    expect(validateSchedule(recurring("0 8 * * *"), { timezone: "Mars/Base" })).toMatch(/^Cannot schedule in time zone "Mars\/Base"/);
  });
});

describe("nextScheduledRun", () => {
  it("reads a one-time date as wall-clock time in the configured zone", () => {
    // 10:00 in Rome (UTC+1 in January) vs New York (UTC-5).
    expect(nextScheduledRun(oneShot("2999-01-05T10:00"), "Europe/Rome")?.toISOString()).toBe("2999-01-05T09:00:00.000Z");
    expect(nextScheduledRun(oneShot("2999-01-05T10:00"), "America/New_York")?.toISOString()).toBe("2999-01-05T15:00:00.000Z");
  });

  it("honours an explicit offset in the date", () => {
    expect(nextScheduledRun(oneShot("2999-01-05T10:00:00Z"), "America/New_York")?.toISOString()).toBe("2999-01-05T10:00:00.000Z");
  });

  it("returns null for a past one-time date and the next minute-aligned run for cron", () => {
    expect(nextScheduledRun(oneShot("2020-01-05T10:00"), undefined)).toBeNull();
    const next = nextScheduledRun(recurring("*/15 * * * *"), "UTC");
    expect(next).toBeInstanceOf(Date);
    expect(next!.getUTCSeconds()).toBe(0);
    expect(next!.getUTCMinutes() % 15).toBe(0);
  });

  it("throws a readable error for an invalid schedule", () => {
    expect(() => nextScheduledRun(recurring("nope"), undefined)).toThrow(/^Invalid cron expression "nope"/);
  });
});
