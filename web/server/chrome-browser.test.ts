import { describe, expect, it, vi } from "vitest";
import {
  applyChromePreference,
  isSamePlatform,
  parseChromeBrowsers,
  pickChromeBrowser,
  type ChromeBrowser,
} from "./chrome-browser.js";

/**
 * Picking the Claude in Chrome browser of a session (two browsers on the
 * account: a Linux one on this machine and a Mac). Shapes follow the CLI's
 * get_chrome_browsers / select_chrome_browser control requests (2.1.293).
 */

const linux: ChromeBrowser = { device_id: "dev-linux", name: "Chrome (Linux)", os_platform: "linux", current: false };
const mac: ChromeBrowser = { device_id: "dev-mac", name: "Chrome (Mac)", os_platform: "macOS", current: true };

describe("isSamePlatform", () => {
  it("matches the browser OS against the server OS", () => {
    expect(isSamePlatform("linux", "linux")).toBe(true);
    expect(isSamePlatform("Linux x86_64", "linux")).toBe(true);
    expect(isSamePlatform("macOS", "darwin")).toBe(true);
    expect(isSamePlatform("darwin", "darwin")).toBe(true);
    expect(isSamePlatform("Windows", "win32")).toBe(true);
    expect(isSamePlatform("macOS", "linux")).toBe(false);
    expect(isSamePlatform(undefined, "linux")).toBe(false);
    expect(isSamePlatform("freebsd", "freebsd")).toBe(true);
  });
});

describe("pickChromeBrowser", () => {
  it("prefers the browser chosen in Settings when connected", () => {
    expect(pickChromeBrowser([linux, mac], "dev-mac", "linux")).toBe(mac);
  });

  // Without a choice (or when the chosen one is offline): this machine's browser.
  it("falls back to the browser on this machine's OS", () => {
    expect(pickChromeBrowser([mac, linux], "", "linux")).toBe(linux);
    expect(pickChromeBrowser([mac, linux], "dev-gone", "linux")).toBe(linux);
  });

  it("prefers the current one among several local browsers", () => {
    const linux2 = { ...linux, device_id: "dev-linux-2", current: true };
    expect(pickChromeBrowser([linux, linux2], undefined, "linux")).toBe(linux2);
  });

  it("picks nothing when no browser runs on this OS", () => {
    expect(pickChromeBrowser([mac], undefined, "linux")).toBeNull();
    expect(pickChromeBrowser([], undefined, "linux")).toBeNull();
  });
});

describe("parseChromeBrowsers", () => {
  it("keeps well-formed entries only", () => {
    expect(parseChromeBrowsers({
      browsers: [
        { device_id: "a", name: "A", os_platform: "linux", current: true },
        { device_id: "b" },
        { name: "no id" },
        null,
      ],
    })).toEqual([
      { device_id: "a", name: "A", os_platform: "linux", current: true },
      { device_id: "b", name: "b", current: false },
    ]);
    expect(parseChromeBrowsers({})).toEqual([]);
    expect(parseChromeBrowsers(null)).toEqual([]);
  });
});

describe("applyChromePreference", () => {
  const platform = process.platform;
  const local = { ...linux, os_platform: platform === "darwin" ? "macOS" : platform };

  it("selects the preferred browser when it is not the current one", async () => {
    const control = { getChromeBrowsers: vi.fn(async () => [local, { ...mac, os_platform: "other" }]), selectChromeBrowser: vi.fn(async () => {}) };
    const res = await applyChromePreference(control, "");
    expect(control.selectChromeBrowser).toHaveBeenCalledWith("dev-linux");
    expect(res).toEqual({ ok: true, selected: { ...local, current: true }, changed: true });
  });

  // No request when it already drives the right browser.
  it("does nothing when the preferred browser is already current", async () => {
    const control = { getChromeBrowsers: vi.fn(async () => [{ ...local, current: true }]), selectChromeBrowser: vi.fn() };
    expect(await applyChromePreference(control, "")).toMatchObject({ ok: true, changed: false });
    expect(control.selectChromeBrowser).not.toHaveBeenCalled();
  });

  it("reports failures (server not connected, nothing to pick, select refused)", async () => {
    const notConnected = { getChromeBrowsers: vi.fn(async () => { throw new Error("not connected"); }), selectChromeBrowser: vi.fn() };
    expect(await applyChromePreference(notConnected, "")).toEqual({ ok: false, error: "not connected" });

    const none = { getChromeBrowsers: vi.fn(async () => []), selectChromeBrowser: vi.fn() };
    expect(await applyChromePreference(none, "")).toEqual({ ok: false, error: "No browser connected to Claude in Chrome" });

    const remoteOnly = { getChromeBrowsers: vi.fn(async () => [{ ...mac, os_platform: "elsewhere" }]), selectChromeBrowser: vi.fn() };
    expect(await applyChromePreference(remoteOnly, "")).toMatchObject({ ok: false, error: expect.stringMatching(/this machine/) });

    const refused = { getChromeBrowsers: vi.fn(async () => [local]), selectChromeBrowser: vi.fn(async () => { throw "nope"; }) };
    expect(await applyChromePreference(refused, "")).toEqual({ ok: false, error: "nope" });
  });
});
