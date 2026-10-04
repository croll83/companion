/**
 * Time helpers for chat messages: the small "14:05" under a bubble, the
 * tooltip with the full date, and the "Today" / "Yesterday" day separators.
 *
 * Everything is computed IN A TIME ZONE — the user's global setting, or the
 * viewing device's zone when the setting is "" (Automatic). Calendar days are
 * read through Intl's formatToParts, never through Date's local/UTC getters,
 * so a message sent at 00:30 in Rome lands on the Rome day even when the
 * browser (or the test runner) lives elsewhere.
 *
 * Formatters are expensive to build and a long chat formats hundreds of
 * messages, so every Intl.DateTimeFormat is cached by locale + zone + kind.
 */

import type { ChatMessage } from "../types.js";

type FormatterKind = "time" | "full" | "day-key" | "label" | "label-year";

const FORMATTER_OPTIONS: Record<FormatterKind, Intl.DateTimeFormatOptions> = {
  time: { hour: "2-digit", minute: "2-digit" },
  // Not dateStyle/timeStyle: those can't carry timeZoneName, and without the
  // zone abbreviation/offset ("CEST" vs "CET") the two 02:30s of the repeated
  // DST-end hour would read the same.
  full: {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  },
  // en-CA would give YYYY-MM-DD directly, but formatToParts is explicit about
  // which number is which and does not depend on a locale's field order.
  "day-key": { year: "numeric", month: "2-digit", day: "2-digit" },
  label: { weekday: "long", day: "numeric", month: "long" },
  "label-year": { weekday: "long", day: "numeric", month: "long", year: "numeric" },
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(kind: FormatterKind, timeZone: string, locale?: string): Intl.DateTimeFormat {
  // The day key must not depend on the locale (digits, calendar): pin it.
  const effectiveLocale = kind === "day-key" ? "en-US" : locale;
  const cacheKey = `${kind}|${timeZone}|${effectiveLocale ?? ""}`;
  let formatter = formatterCache.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(effectiveLocale, {
      ...FORMATTER_OPTIONS[kind],
      ...(kind === "day-key" ? { calendar: "gregory", numberingSystem: "latn" } : {}),
      timeZone,
    });
    formatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

// Every bubble resolves the zone on every render (and the feed re-renders on
// each streaming delta), so neither lookup may build a formatter per call.
const DEVICE_ZONE_TTL_MS = 60_000;
let deviceZoneCache: { zone: string; at: number } | null = null;
const zoneValidityCache = new Map<string, boolean>();

/**
 * The viewing device's IANA zone (what "Automatic" means). Re-read at most
 * once a minute, so a laptop that changes zone catches up without a reload.
 */
export function getDeviceTimeZone(): string {
  const now = Date.now();
  if (!deviceZoneCache || Math.abs(now - deviceZoneCache.at) > DEVICE_ZONE_TTL_MS) {
    deviceZoneCache = { zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", at: now };
  }
  return deviceZoneCache.zone;
}

/** True when `zone` is an IANA zone this runtime understands. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  let valid = zoneValidityCache.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    zoneValidityCache.set(zone, valid);
  }
  return valid;
}

/**
 * Zone to render in: the setting when it is a zone this browser knows,
 * otherwise the device zone ("" = Automatic, or a zone an older browser lacks).
 */
export function resolveTimeZone(setting?: string | null): string {
  const trimmed = setting?.trim() ?? "";
  return trimmed && isValidTimeZone(trimmed) ? trimmed : getDeviceTimeZone();
}

/** Every IANA zone the browser knows, or [] when Intl can't enumerate them. */
export function listTimeZones(): string[] {
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supportedValuesOf !== "function") return [];
  try {
    return supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

/**
 * Whether a message carries a real send time. Messages rebuilt from old
 * history entries that were never stamped get a placeholder timestamp (so
 * sorting still works) and `timestampUnknown`; those must show no time.
 */
export function hasKnownTimestamp(message: Pick<ChatMessage, "timestamp" | "timestampUnknown">): boolean {
  return !message.timestampUnknown && Number.isFinite(message.timestamp) && message.timestamp > 0;
}

/** "14:05" (or "2:05 PM") in the given zone, browser locale by default. */
export function formatMessageTime(ts: number, timeZone: string, locale?: string): string {
  return getFormatter("time", timeZone, locale).format(ts);
}

/**
 * Full date + time + zone, for the tooltip:
 * "Sunday, 4 October 2026 at 14:05:09 CEST (Europe/Rome)". The short zone name
 * (or GMT offset) tells apart the two occurrences of a repeated DST hour.
 */
export function formatMessageTooltip(ts: number, timeZone: string, locale?: string): string {
  return `${getFormatter("full", timeZone, locale).format(ts)} (${timeZone})`;
}

/** Calendar day of `ts` in `timeZone`, as "YYYY-MM-DD". */
export function dayKey(ts: number, timeZone: string): string {
  const parts = getFormatter("day-key", timeZone).formatToParts(ts);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The calendar day before a "YYYY-MM-DD" key. Pure date arithmetic on the
 * key itself (no zone involved: the key is already a local calendar date),
 * done on a UTC-anchored Date so DST can't shift it by an hour.
 */
function previousDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Separator label for the day of `ts`, as seen in `timeZone`:
 * "Today", "Yesterday", or weekday + day + month — with the year only when it
 * differs from the current year in that zone.
 */
export function formatDayLabel(ts: number, timeZone: string, now: number = Date.now(), locale?: string): string {
  const key = dayKey(ts, timeZone);
  const todayKey = dayKey(now, timeZone);
  if (key === todayKey) return "Today";
  if (key === previousDayKey(todayKey)) return "Yesterday";
  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4);
  return getFormatter(sameYear ? "label" : "label-year", timeZone, locale).format(ts);
}
