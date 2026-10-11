/**
 * Claude in Chrome: picking the browser a session drives.
 *
 * Several browsers can be connected to one Claude account at once — e.g. a
 * Linux browser on the same machine as Companion (isLocal:true) and the user's
 * Mac reached through the account relay (isLocal:false). When Companion runs on
 * a VPS, every connected browser is remote.
 *
 * The connected browsers are listed by the Claude in Chrome MCP tool
 * `list_connected_browsers` (see chrome-browser-probe.ts, which runs it in a
 * short isolated Claude query). `set_chrome_browser_hints` is refused over
 * stdio ("only accepted in a remote-hosted session"), so to make a live
 * session drive a given browser we use the `select_chrome_browser` control
 * request after the session's Chrome server has connected (it fails until
 * then, so the caller retries for a while).
 */

export interface ConnectedBrowser {
  deviceId: string;
  name: string;
  osPlatform?: string;
  /** True when the browser runs on the same machine as Companion. */
  isLocal: boolean;
  /** The browser Chrome actions use right now. */
  inUse: boolean;
}

export interface ConnectedBrowserList {
  browsers: ConnectedBrowser[];
  /** Set when the list could not be fetched (no browser connected, probe failed, …). */
  error?: string;
}

/** The special value meaning "the browser on Companion's machine" (see DomainInfo.chromeBrowser). */
export const LOCAL_BROWSER = "local";

/** Parse a `list_connected_browsers` result, dropping malformed entries. */
export function parseConnectedBrowsers(raw: unknown): ConnectedBrowser[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { browsers?: unknown } | null)?.browsers)
      ? (raw as { browsers: unknown[] }).browsers
      : null;
  if (!list) return [];
  return list
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .map((b) => {
      const deviceId = typeof b.deviceId === "string" ? b.deviceId : typeof b.device_id === "string" ? b.device_id : "";
      return {
        deviceId,
        name: typeof b.name === "string" && b.name.trim() ? b.name : deviceId,
        ...(typeof b.osPlatform === "string" ? { osPlatform: b.osPlatform } : typeof b.os_platform === "string" ? { osPlatform: b.os_platform } : {}),
        isLocal: b.isLocal === true || b.is_local === true,
        inUse: b.inUse === true || b.in_use === true,
      };
    })
    .filter((b) => b.deviceId);
}

/**
 * The browser to drive for the "local" preference: the one on Companion's
 * machine, else the first remote one (so a VPS session drives the user's
 * remote browser), else none.
 */
export function pickLocalBrowser(browsers: ConnectedBrowser[]): ConnectedBrowser | null {
  return browsers.find((b) => b.isLocal) ?? browsers[0] ?? null;
}

/**
 * The deviceId to select for a domain's `chromeBrowser` preference:
 *  - "local" (or empty): pickLocalBrowser over the connected list,
 *  - a specific deviceId: that id (no list needed; selecting it fails later if
 *    it is not actually connected).
 * Returns null when "local" is wanted but nothing is connected.
 */
export function resolveChromeTarget(pref: string | undefined, browsers: ConnectedBrowser[]): string | null {
  if (pref && pref !== LOCAL_BROWSER) return pref;
  return pickLocalBrowser(browsers)?.deviceId ?? null;
}

export type ChromePreferenceResult =
  | { ok: true; deviceId: string }
  | { ok: false; error: string };

/** Talks to one live Claude CLI (see ClaudeAdapter). */
export interface ChromeControl {
  selectChromeBrowser(deviceId: string): Promise<void>;
}

/**
 * Make a live session drive the browser its domain prefers. For a specific
 * deviceId no list is needed; for "local" the connected browsers are fetched
 * (cached) to find the local one, falling back to a remote one.
 */
export async function applyChromePreference(
  control: ChromeControl,
  pref: string | undefined,
  fetchBrowsers: () => Promise<ConnectedBrowserList>,
): Promise<ChromePreferenceResult> {
  let target: string | null;
  if (pref && pref !== LOCAL_BROWSER) {
    target = pref;
  } else {
    const list = await fetchBrowsers();
    target = resolveChromeTarget(LOCAL_BROWSER, list.browsers);
    if (!target) return { ok: false, error: list.error || "No browser connected to Claude in Chrome" };
  }
  try {
    await control.selectChromeBrowser(target);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, deviceId: target };
}
