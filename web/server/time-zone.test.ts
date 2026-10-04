import { describe, it, expect } from "vitest";
import { isValidTimeZoneSetting } from "./time-zone.js";

// The `timeZone` setting accepts "" (Automatic — each device's own zone) or
// any IANA zone the runtime's Intl understands. Everything else is rejected so
// it can never reach a browser, where Intl.DateTimeFormat would throw.
describe("isValidTimeZoneSetting", () => {
  it("accepts the empty string (Automatic)", () => {
    expect(isValidTimeZoneSetting("")).toBe(true);
  });

  it("accepts canonical IANA zones, UTC included", () => {
    expect(isValidTimeZoneSetting("Europe/Rome")).toBe(true);
    expect(isValidTimeZoneSetting("America/New_York")).toBe(true);
    expect(isValidTimeZoneSetting("UTC")).toBe(true);
  });

  it("rejects made-up zones and garbage", () => {
    expect(isValidTimeZoneSetting("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZoneSetting("not a zone")).toBe(false);
    // Whitespace is not trimmed here — the route trims before validating.
    expect(isValidTimeZoneSetting(" ")).toBe(false);
  });
});
