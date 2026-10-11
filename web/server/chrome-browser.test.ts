import { describe, expect, it, vi } from "vitest";
import {
  applyChromePreference,
  parseConnectedBrowsers,
  pickLocalBrowser,
  resolveChromeTarget,
  type ConnectedBrowser,
} from "./chrome-browser.js";

/**
 * Picking the Claude in Chrome browser of a session. Two browsers are on the
 * account: a Linux one on Companion's machine (isLocal) and the user's Mac
 * reached through the relay (remote). Shapes follow the
 * `list_connected_browsers` MCP tool.
 */

const linux: ConnectedBrowser = { deviceId: "dev-linux", name: "Chrome (Linux)", osPlatform: "Linux", isLocal: true, inUse: false };
const mac: ConnectedBrowser = { deviceId: "dev-mac", name: "Chrome (Mac)", osPlatform: "macOS", isLocal: false, inUse: true };

describe("pickLocalBrowser", () => {
  it("prefers the local browser", () => {
    // Validates that the on-machine browser wins even when a remote one is listed first.
    expect(pickLocalBrowser([mac, linux])).toBe(linux);
  });

  it("falls back to the first remote browser when none is local", () => {
    // The VPS case: Companion has no local browser, so it drives the user's remote one.
    expect(pickLocalBrowser([mac])).toBe(mac);
  });

  it("returns null when nothing is connected", () => {
    expect(pickLocalBrowser([])).toBeNull();
  });
});

describe("resolveChromeTarget", () => {
  it('resolves "local" to the local browser deviceId', () => {
    expect(resolveChromeTarget("local", [mac, linux])).toBe("dev-linux");
  });

  it("returns a specific deviceId as-is, without needing the list", () => {
    // A chosen deviceId is selected directly; selecting fails later if offline.
    expect(resolveChromeTarget("dev-mac", [])).toBe("dev-mac");
  });

  it('treats undefined/empty like "local"', () => {
    expect(resolveChromeTarget(undefined, [mac])).toBe("dev-mac");
    expect(resolveChromeTarget("local", [])).toBeNull();
  });
});

describe("parseConnectedBrowsers", () => {
  it("accepts both the camelCase tool shape and a snake_case fallback, dropping id-less entries", () => {
    expect(parseConnectedBrowsers([
      { deviceId: "a", name: "A", osPlatform: "Linux", isLocal: true, inUse: true },
      { device_id: "b", is_local: false, in_use: false },
      { name: "no id" },
      null,
    ])).toEqual([
      { deviceId: "a", name: "A", osPlatform: "Linux", isLocal: true, inUse: true },
      { deviceId: "b", name: "b", isLocal: false, inUse: false },
    ]);
  });

  it("reads an array wrapped in { browsers: [...] }, and tolerates junk", () => {
    expect(parseConnectedBrowsers({ browsers: [{ deviceId: "x", name: "X" }] }))
      .toEqual([{ deviceId: "x", name: "X", isLocal: false, inUse: false }]);
    expect(parseConnectedBrowsers({})).toEqual([]);
    expect(parseConnectedBrowsers(null)).toEqual([]);
  });
});

describe("applyChromePreference", () => {
  it("selects the resolved local browser (no list needed is the specific-id case)", async () => {
    const control = { selectChromeBrowser: vi.fn(async () => {}) };
    const fetchBrowsers = vi.fn(async () => ({ browsers: [mac, linux] }));
    const res = await applyChromePreference(control, "local", fetchBrowsers);
    expect(fetchBrowsers).toHaveBeenCalledOnce();
    expect(control.selectChromeBrowser).toHaveBeenCalledWith("dev-linux");
    expect(res).toEqual({ ok: true, deviceId: "dev-linux" });
  });

  it("selects a specific deviceId without fetching the list", async () => {
    const control = { selectChromeBrowser: vi.fn(async () => {}) };
    const fetchBrowsers = vi.fn(async () => ({ browsers: [] }));
    const res = await applyChromePreference(control, "dev-mac", fetchBrowsers);
    expect(fetchBrowsers).not.toHaveBeenCalled();
    expect(control.selectChromeBrowser).toHaveBeenCalledWith("dev-mac");
    expect(res).toEqual({ ok: true, deviceId: "dev-mac" });
  });

  it('falls back to a remote browser for "local" when none is on this machine', async () => {
    // VPS: a "local" preference still drives the user's remote Mac.
    const control = { selectChromeBrowser: vi.fn(async () => {}) };
    const res = await applyChromePreference(control, "local", async () => ({ browsers: [mac] }));
    expect(control.selectChromeBrowser).toHaveBeenCalledWith("dev-mac");
    expect(res).toEqual({ ok: true, deviceId: "dev-mac" });
  });

  it("reports when nothing is connected and surfaces the fetch error", async () => {
    const control = { selectChromeBrowser: vi.fn() };
    expect(await applyChromePreference(control, "local", async () => ({ browsers: [], error: "Chrome off" })))
      .toEqual({ ok: false, error: "Chrome off" });
    expect(control.selectChromeBrowser).not.toHaveBeenCalled();
    expect(await applyChromePreference(control, "local", async () => ({ browsers: [] })))
      .toEqual({ ok: false, error: "No browser connected to Claude in Chrome" });
  });

  it("reports a refused selection", async () => {
    const control = { selectChromeBrowser: vi.fn(async () => { throw new Error("nope"); }) };
    expect(await applyChromePreference(control, "dev-mac", async () => ({ browsers: [] })))
      .toEqual({ ok: false, error: "nope" });
  });
});
