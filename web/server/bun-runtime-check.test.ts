import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MIN_BUN_VERSION,
  evaluateBunVersion,
  getRuntimeBunVersion,
  checkBunRuntime,
  warnIfBunOutdated,
} from "./bun-runtime-check.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("evaluateBunVersion", () => {
  // The minimum is the first Bun release free of oven-sh/bun#32743.
  it("uses 1.4.0 as the minimum", () => {
    expect(MIN_BUN_VERSION).toBe("1.4.0");
    expect(evaluateBunVersion("1.4.0").minimum).toBe("1.4.0");
  });

  // 1.3.9 is the version that actually shipped the subprocess-stream bug:
  // it must be flagged as outdated.
  it("flags 1.3.9 as outdated", () => {
    expect(evaluateBunVersion("1.3.9")).toEqual({
      version: "1.3.9",
      minimum: "1.4.0",
      ok: false,
      reason: "outdated",
    });
  });

  // Older majors/minors must be outdated too, including a patch number that
  // is numerically larger than the minimum's (1.3.10 vs 1.4.0).
  it.each(["1.0.0", "1.2.23", "1.3.10", "0.9.9"])("flags %s as outdated", (v) => {
    expect(evaluateBunVersion(v)).toMatchObject({ ok: false, reason: "outdated" });
  });

  // The boundary itself and anything newer is fine.
  it.each(["1.4.0", "1.4.2", "1.5.0", "2.0.0", "1.10.0"])("accepts %s", (v) => {
    expect(evaluateBunVersion(v)).toMatchObject({ version: v, ok: true, reason: "ok" });
  });

  // Canary / prerelease builds report strings like "1.4.2-canary.20261003.1".
  // Only the core version is compared, so a 1.4.x canary is ok while a 1.3.x
  // canary is still outdated.
  it("compares canary/prerelease strings by their core version", () => {
    expect(evaluateBunVersion("1.4.2-canary.20261003.1")).toMatchObject({
      version: "1.4.2-canary.20261003.1",
      ok: true,
      reason: "ok",
    });
    expect(evaluateBunVersion("1.4.0-canary.1")).toMatchObject({ ok: true, reason: "ok" });
    expect(evaluateBunVersion("1.3.10-canary.20260901.3")).toMatchObject({ ok: false, reason: "outdated" });
    expect(evaluateBunVersion("1.4.1+a1b2c3d")).toMatchObject({ ok: true, reason: "ok" });
  });

  // A leading "v" and surrounding whitespace are tolerated.
  it("tolerates a leading v and whitespace", () => {
    expect(evaluateBunVersion(" v1.3.9 ")).toMatchObject({ version: "v1.3.9", ok: false });
  });

  // Unparseable versions must NOT nag the user: ok=true with reason "unknown".
  // Covers garbage, partial versions, empty strings and missing values.
  it.each([
    ["garbage", "not-a-version", "not-a-version"],
    ["two-part version", "1.4", "1.4"],
    ["empty string", "", null],
    ["null", null, null],
    ["undefined", undefined, null],
  ])("reports %s as unknown but ok", (_label, input, expectedVersion) => {
    expect(evaluateBunVersion(input)).toEqual({
      version: expectedVersion,
      minimum: "1.4.0",
      ok: true,
      reason: "unknown",
    });
  });
});

describe("getRuntimeBunVersion / checkBunRuntime", () => {
  // Vitest runs on Node, where the Bun global doesn't exist: the check must
  // degrade to "unknown" instead of throwing.
  it("returns null / unknown when not running on Bun", () => {
    vi.stubGlobal("Bun", undefined);
    expect(getRuntimeBunVersion()).toBeNull();
    expect(checkBunRuntime()).toMatchObject({ version: null, ok: true, reason: "unknown" });
  });

  // When the Bun global is present, its version string is what gets checked.
  it("reads Bun.version from the runtime", () => {
    vi.stubGlobal("Bun", { version: "1.3.9" });
    expect(getRuntimeBunVersion()).toBe("1.3.9");
    expect(checkBunRuntime()).toMatchObject({ version: "1.3.9", ok: false, reason: "outdated" });

    vi.stubGlobal("Bun", { version: "1.4.2" });
    expect(checkBunRuntime()).toMatchObject({ version: "1.4.2", ok: true });
  });
});

describe("warnIfBunOutdated", () => {
  // Startup warning: logged exactly once when outdated, with the version, the
  // upstream bug reference and the fix (bun upgrade + restart).
  it("logs a single clear warning when Bun is outdated", () => {
    const log = vi.fn();
    const result = warnIfBunOutdated(evaluateBunVersion("1.3.9"), log);
    expect(result.ok).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = log.mock.calls[0][0] as string;
    expect(msg).toContain("Bun 1.3.9");
    expect(msg).toContain("1.4.0");
    expect(msg).toContain("oven-sh/bun#32743");
    expect(msg).toContain("bun upgrade");
    expect(msg).toContain("the-companion restart");
  });

  // Nothing is logged for ok or unknown versions.
  it("stays silent when Bun is ok or the version is unknown", () => {
    const log = vi.fn();
    warnIfBunOutdated(evaluateBunVersion("1.4.2"), log);
    warnIfBunOutdated(evaluateBunVersion("garbage"), log);
    expect(log).not.toHaveBeenCalled();
  });

  // Default arguments: checks the live runtime and logs via console.warn.
  it("defaults to the live runtime and console.warn", () => {
    vi.stubGlobal("Bun", { version: "1.2.0" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = warnIfBunOutdated();
      expect(result).toMatchObject({ version: "1.2.0", ok: false });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
