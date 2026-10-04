import { describe, it, expect, afterEach, vi } from "vitest";
import {
  dayKey,
  formatDayLabel,
  formatMessageTime,
  formatMessageTooltip,
  getDeviceTimeZone,
  hasKnownTimestamp,
  isValidTimeZone,
  listTimeZones,
  resolveTimeZone,
} from "./message-time.js";

// All assertions pass an explicit zone (and, for text, an explicit locale), so
// they hold whatever zone/locale the machine running the tests is in.
const ROME = "Europe/Rome";
const UTC = "UTC";
const iso = (s: string) => Date.parse(s);

describe("resolveTimeZone — setting vs Automatic", () => {
  // "" is Automatic: the viewing device's own zone.
  it("uses the device zone when the setting is empty or missing", () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(getDeviceTimeZone()).toBe(device);
    expect(resolveTimeZone("")).toBe(device);
    expect(resolveTimeZone(undefined)).toBe(device);
    expect(resolveTimeZone(null)).toBe(device);
  });

  // An explicit zone overrides the device, whatever the device is.
  it("uses the configured zone when it is valid", () => {
    expect(resolveTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimeZone(" Europe/Rome ")).toBe(ROME);
  });

  // A zone this browser does not know must not crash rendering: fall back.
  it("falls back to the device zone for an unknown zone", () => {
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(getDeviceTimeZone());
  });

  // The device zone is cached (bubbles resolve it on every render) but
  // re-read after a minute, so a device that changes zone catches up.
  it("re-reads the device zone after the cache expires", () => {
    // Fake only Date: the default fake-timer set also swaps Intl.DateTimeFormat
    // for a wrapper, which would bypass the resolvedOptions spy below.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000_000_000);
      const first = getDeviceTimeZone();
      const other = first === "Asia/Tokyo" ? "Europe/Rome" : "Asia/Tokyo";
      // The device moves to another zone…
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
        timeZone: other,
      } as Intl.ResolvedDateTimeFormatOptions);
      // …within the minute the cached zone is still served,
      vi.setSystemTime(1_000_000_000_000 + 30_000);
      expect(getDeviceTimeZone()).toBe(first);
      // and after it the new zone is picked up.
      vi.setSystemTime(1_000_000_000_000 + 61_000);
      expect(getDeviceTimeZone()).toBe(other);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("isValidTimeZone only accepts real zones (not the empty string)", () => {
    expect(isValidTimeZone(ROME)).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("nope/nope")).toBe(false);
  });
});

describe("dayKey — calendar day in the chosen zone", () => {
  // 22:30 UTC on 14 June is already 00:30 on 15 June in Rome (CEST, UTC+2):
  // the same instant belongs to different calendar days depending on the zone.
  it("puts the same instant on different days in UTC and Europe/Rome", () => {
    const ts = iso("2026-06-14T22:30:00Z");
    expect(dayKey(ts, UTC)).toBe("2026-06-14");
    expect(dayKey(ts, ROME)).toBe("2026-06-15");
  });

  // Spring forward, 2026-03-29: Rome skips 02:00→03:00 (at 01:00 UTC), so that
  // day is 23 hours long. Its first and last minutes must still map to it.
  it("handles the 2026-03-29 DST start in Europe/Rome", () => {
    expect(dayKey(iso("2026-03-28T22:59:00Z"), ROME)).toBe("2026-03-28"); // 23:59 CET
    expect(dayKey(iso("2026-03-28T23:00:00Z"), ROME)).toBe("2026-03-29"); // 00:00 CET
    expect(dayKey(iso("2026-03-29T21:59:00Z"), ROME)).toBe("2026-03-29"); // 23:59 CEST
    expect(dayKey(iso("2026-03-29T22:00:00Z"), ROME)).toBe("2026-03-30"); // 00:00 CEST
    // Wall clock jumps from 01:59 to 03:00.
    expect(formatMessageTime(iso("2026-03-29T00:59:00Z"), ROME, "en-GB")).toBe("01:59");
    expect(formatMessageTime(iso("2026-03-29T01:00:00Z"), ROME, "en-GB")).toBe("03:00");
  });

  // Fall back, 2026-10-25: Rome repeats 02:00–03:00 (at 01:00 UTC), so that day
  // is 25 hours long; both 02:30s are on the 25th.
  it("handles the 2026-10-25 DST end in Europe/Rome", () => {
    expect(dayKey(iso("2026-10-24T21:59:00Z"), ROME)).toBe("2026-10-24"); // 23:59 CEST
    expect(dayKey(iso("2026-10-24T22:00:00Z"), ROME)).toBe("2026-10-25"); // 00:00 CEST
    expect(dayKey(iso("2026-10-25T22:59:00Z"), ROME)).toBe("2026-10-25"); // 23:59 CET
    expect(dayKey(iso("2026-10-25T23:00:00Z"), ROME)).toBe("2026-10-26"); // 00:00 CET
    expect(formatMessageTime(iso("2026-10-25T00:30:00Z"), ROME, "en-GB")).toBe("02:30"); // CEST
    expect(formatMessageTime(iso("2026-10-25T01:30:00Z"), ROME, "en-GB")).toBe("02:30"); // CET
  });
});

describe("formatMessageTime / formatMessageTooltip", () => {
  it("formats hours and minutes in the chosen zone", () => {
    const ts = iso("2026-06-14T22:30:00Z");
    expect(formatMessageTime(ts, UTC, "en-GB")).toBe("22:30");
    expect(formatMessageTime(ts, ROME, "en-GB")).toBe("00:30");
  });

  // The browser locale decides the clock style (12h vs 24h); en-US uses AM/PM.
  it("follows the locale's clock style", () => {
    expect(formatMessageTime(iso("2026-06-14T13:05:00Z"), UTC, "en-US")).toMatch(/^01:05\s?PM$/);
  });

  // The tooltip carries the full date, the time and the zone name.
  it("tooltip contains date, time and zone", () => {
    const tip = formatMessageTooltip(iso("2026-06-14T22:30:09Z"), ROME, "en-GB");
    expect(tip).toContain("2026");
    expect(tip).toContain("June");
    expect(tip).toContain("15"); // Rome day, not the UTC one
    expect(tip).toContain("00:30:09");
    expect(tip).toContain("(Europe/Rome)");
  });
});

describe("formatDayLabel — Today / Yesterday / date", () => {
  const NOW = iso("2026-10-04T10:00:00Z"); // Sunday 4 Oct 2026, 12:00 in Rome

  it("labels today and yesterday relative to the injected now", () => {
    expect(formatDayLabel(iso("2026-10-04T05:00:00Z"), ROME, NOW, "en-US")).toBe("Today");
    expect(formatDayLabel(iso("2026-10-03T05:00:00Z"), ROME, NOW, "en-US")).toBe("Yesterday");
    // Two days ago: a real date with weekday, day and month.
    const older = formatDayLabel(iso("2026-10-02T05:00:00Z"), ROME, NOW, "en-US");
    expect(older).toContain("Friday");
    expect(older).toContain("October");
    expect(older).toContain("2");
  });

  // "Today" is decided in the zone: 21:00 UTC on 15 June is 23:00 in Rome, and
  // at 23:30 UTC Rome is already on the 16th, so the message is yesterday there.
  it("decides Today/Yesterday in the chosen zone, not in UTC", () => {
    const now = iso("2026-06-15T23:30:00Z");
    const ts = iso("2026-06-15T21:00:00Z");
    expect(formatDayLabel(ts, UTC, now, "en-US")).toBe("Today");
    expect(formatDayLabel(ts, ROME, now, "en-US")).toBe("Yesterday");
  });

  // Yesterday across the 23-hour DST day: more than 24h elapsed, still yesterday.
  it("keeps Yesterday correct across the DST change", () => {
    const now = iso("2026-03-30T00:30:00Z"); // 02:30 CEST on Mon 30 March
    const ts = iso("2026-03-28T23:15:00Z"); // 00:15 CET on Sun 29 March, 25h15m earlier
    expect(formatDayLabel(ts, ROME, now, "en-US")).toBe("Yesterday");
  });

  it("shows the year only when it is not the current year", () => {
    const sameYear = formatDayLabel(iso("2026-02-14T12:00:00Z"), ROME, NOW, "en-US");
    expect(sameYear).toContain("February");
    expect(sameYear).not.toContain("2026");
    const lastYear = formatDayLabel(iso("2025-12-30T12:00:00Z"), ROME, NOW, "en-US");
    expect(lastYear).toContain("December");
    expect(lastYear).toContain("2025");
  });

  // The "current year" is also read in the zone: at 23:30 UTC on 31 Dec it is
  // already 2027 in Rome, so a 30 Dec 2026 message needs its year there only.
  it("decides the current year in the chosen zone", () => {
    const now = iso("2026-12-31T23:30:00Z");
    const ts = iso("2026-12-29T12:00:00Z");
    expect(formatDayLabel(ts, UTC, now, "en-US")).not.toContain("2026");
    expect(formatDayLabel(ts, ROME, now, "en-US")).toContain("2026");
  });

  it("defaults now to the current time", () => {
    expect(formatDayLabel(Date.now(), ROME)).toBe("Today");
  });
});

describe("hasKnownTimestamp", () => {
  // Rebuilt-from-history messages without a stored time carry a placeholder
  // timestamp plus timestampUnknown: they must not count as known.
  it("is false for flagged, zero or non-finite timestamps", () => {
    expect(hasKnownTimestamp({ timestamp: 1_700_000_000_000, timestampUnknown: true })).toBe(false);
    expect(hasKnownTimestamp({ timestamp: 0 })).toBe(false);
    expect(hasKnownTimestamp({ timestamp: Number.NaN })).toBe(false);
  });

  it("is true for a real timestamp", () => {
    expect(hasKnownTimestamp({ timestamp: 1_700_000_000_000 })).toBe(true);
  });
});

describe("listTimeZones", () => {
  const original = (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
  afterEach(() => {
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = original;
    vi.restoreAllMocks();
  });

  it("returns the IANA list when Intl supports it", () => {
    expect(listTimeZones()).toContain(ROME);
  });

  // Older browsers lack Intl.supportedValuesOf: the settings select then only
  // offers Automatic (plus the saved zone) instead of crashing.
  it("returns [] when Intl.supportedValuesOf is unavailable", () => {
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
    expect(listTimeZones()).toEqual([]);
  });

  it("returns [] when Intl.supportedValuesOf throws", () => {
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = () => {
      throw new RangeError("unsupported key");
    };
    expect(listTimeZones()).toEqual([]);
  });
});
