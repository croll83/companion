import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// log-timestamps patches console at import time and records that in a global
// flag. Each test re-imports a fresh copy, with console methods replaced by
// spies, and the real console + flag are restored afterwards so nothing leaks
// into other test files.
const METHODS = ["log", "info", "warn", "error", "debug"] as const;
type Method = (typeof METHODS)[number];
const g = globalThis as { __companionLogStamped?: boolean };

const STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

let originals: Record<Method, (...a: unknown[]) => void>;
let spies: Record<Method, ReturnType<typeof vi.fn>>;
let savedFlag: boolean | undefined;
let savedFormat: string | undefined;

async function load() {
  vi.resetModules();
  return import("./log-timestamps.js");
}

beforeEach(() => {
  originals = {} as typeof originals;
  spies = {} as typeof spies;
  for (const m of METHODS) {
    originals[m] = console[m];
    spies[m] = vi.fn();
    console[m] = spies[m] as never;
  }
  savedFlag = g.__companionLogStamped;
  delete g.__companionLogStamped;
  savedFormat = process.env.COMPANION_LOG_FORMAT;
  delete process.env.COMPANION_LOG_FORMAT;
});

afterEach(() => {
  for (const m of METHODS) console[m] = originals[m] as never;
  if (savedFlag === undefined) delete g.__companionLogStamped;
  else g.__companionLogStamped = savedFlag;
  if (savedFormat === undefined) delete process.env.COMPANION_LOG_FORMAT;
  else process.env.COMPANION_LOG_FORMAT = savedFormat;
});

describe("stamp", () => {
  it("formats local time to the millisecond with zero padding", async () => {
    const { stamp } = await load();
    // Local-time constructor so the expectation is timezone-independent.
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe("2026-01-02 03:04:05.006");
    expect(stamp(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12-31 23:59:59.999");
  });

  it("defaults to the current time", async () => {
    const { stamp } = await load();
    vi.useFakeTimers();
    try {
      const now = new Date(2026, 9, 3, 14, 7, 8, 90);
      vi.setSystemTime(now);
      expect(stamp()).toBe("2026-10-03 14:07:08.090");
    } finally { vi.useRealTimers(); }
  });
});

describe("console patching", () => {
  it("prefixes every console method with a timestamp, passing args through", async () => {
    await load();
    expect(g.__companionLogStamped).toBe(true);
    for (const m of METHODS) {
      expect(console[m]).not.toBe(spies[m]);           // replaced by the wrapper
      console[m]("hello", { n: 1 });
      expect(spies[m]).toHaveBeenCalledTimes(1);
      const [ts, ...rest] = spies[m].mock.calls[0];
      expect(ts).toMatch(STAMP_RE);
      expect(rest).toEqual(["hello", { n: 1 }]);
    }
  });

  it("does not double-stamp when the module is evaluated twice", async () => {
    // Guards against two copies (e.g. re-import / HMR) each wrapping console,
    // which would print two timestamps per line.
    await load();
    const wrapped = console.log;
    await load();
    expect(console.log).toBe(wrapped);
    console.log("once");
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.log.mock.calls[0]).toHaveLength(2); // one stamp + the message
  });

  it("leaves console untouched with COMPANION_LOG_FORMAT=json (NDJSON lines must stay parseable)", async () => {
    process.env.COMPANION_LOG_FORMAT = "json";
    await load();
    expect(g.__companionLogStamped).toBeUndefined();
    for (const m of METHODS) expect(console[m]).toBe(spies[m]);
    console.log('{"ts":1}');
    expect(spies.log).toHaveBeenCalledWith('{"ts":1}');
  });
});
