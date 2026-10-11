/**
 * Claude in Chrome: picking the browser a session drives when several are
 * connected to the account (here a Linux browser on this machine and a Mac).
 *
 * The CLI's `set_chrome_browser_hints` control request would be the natural
 * fit, but CLI 2.1.293 refuses it outside a remote-hosted session ("only
 * accepted in a remote-hosted session"), and Companion drives the CLI over
 * stdio. What does work locally is what the terminal's /chrome picker does:
 *  - `get_chrome_browsers` → `{ browsers: [{ device_id, name, os_platform?, current }] }`
 *  - `select_chrome_browser { device_id }` → `{ name? }`
 * Both fail while the session's Claude in Chrome server is not connected yet,
 * so the caller retries for a while after the CLI starts.
 */

export interface ChromeBrowser {
  device_id: string;
  name: string;
  os_platform?: string;
  /** The browser Chrome actions use now. */
  current: boolean;
}

/** Whether a browser's reported OS is the OS Companion runs on. */
export function isSamePlatform(osPlatform: string | undefined, platform: string = process.platform): boolean {
  const os = (osPlatform ?? "").toLowerCase();
  if (!os) return false;
  if (platform === "linux") return os.includes("linux");
  if (platform === "darwin") return os.includes("mac") || os.includes("darwin");
  if (platform === "win32") return os.includes("win");
  return os.includes(platform);
}

/**
 * The browser to use: the one chosen in Settings when it is connected, else
 * the one on this machine's OS (the current one if several), else none.
 */
export function pickChromeBrowser(
  browsers: ChromeBrowser[],
  preferred: string | undefined,
  platform: string = process.platform,
): ChromeBrowser | null {
  if (preferred) {
    const chosen = browsers.find((b) => b.device_id === preferred);
    if (chosen) return chosen;
  }
  const local = browsers.filter((b) => isSamePlatform(b.os_platform, platform));
  return local.find((b) => b.current) ?? local[0] ?? null;
}

/** Parse a get_chrome_browsers response, dropping malformed entries. */
export function parseChromeBrowsers(response: unknown): ChromeBrowser[] {
  const list = (response as { browsers?: unknown } | null)?.browsers;
  if (!Array.isArray(list)) return [];
  return list
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && typeof (b as { device_id?: unknown }).device_id === "string")
    .map((b) => ({
      device_id: b.device_id as string,
      name: typeof b.name === "string" ? b.name : (b.device_id as string),
      ...(typeof b.os_platform === "string" ? { os_platform: b.os_platform } : {}),
      current: b.current === true,
    }));
}

export type ChromePreferenceResult =
  | { ok: true; selected: ChromeBrowser; changed: boolean }
  | { ok: false; error: string };

/** Talks to one live Claude CLI (see ClaudeAdapter). */
export interface ChromeControl {
  getChromeBrowsers(): Promise<ChromeBrowser[]>;
  selectChromeBrowser(deviceId: string): Promise<void>;
}

/** Make the session use the preferred browser (no request when it already does). */
export async function applyChromePreference(control: ChromeControl, preferred: string | undefined): Promise<ChromePreferenceResult> {
  let browsers: ChromeBrowser[];
  try {
    browsers = await control.getChromeBrowsers();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const pick = pickChromeBrowser(browsers, preferred);
  if (!pick) {
    return { ok: false, error: browsers.length === 0 ? "No browser connected to Claude in Chrome" : "No connected browser runs on this machine's OS" };
  }
  if (pick.current) return { ok: true, selected: pick, changed: false };
  try {
    await control.selectChromeBrowser(pick.device_id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, selected: { ...pick, current: true }, changed: true };
}
