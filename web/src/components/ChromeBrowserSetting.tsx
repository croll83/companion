import { useId, useState } from "react";
import { api, type ChromeBrowserInfo } from "../api.js";

/**
 * Settings field "Preferred Chrome browser": the browser that Claude sessions
 * with Claude in Chrome on (a domain setting) drive when several browsers are
 * connected to the account. Automatic = the browser running on this
 * machine's OS. The list comes from a live Chrome-enabled Claude session
 * ("Detect browsers"), since only the CLI knows the connected browsers.
 * Claude Code only: Codex has no Chrome integration.
 */
export function ChromeBrowserSetting({ value, onChange }: { value: string; onChange: (deviceId: string) => void }) {
  const [browsers, setBrowsers] = useState<ChromeBrowserInfo[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const selectId = useId();
  const helpId = useId();

  async function detect() {
    setLoading(true);
    setNote("");
    try {
      const res = await api.listChromeBrowsers();
      setBrowsers(res.browsers);
      if (res.error) setNote(res.error);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save(deviceId: string) {
    const previous = value;
    onChange(deviceId);
    setError("");
    try {
      await api.updateSettings({ preferredChromeBrowser: deviceId });
    } catch (e) {
      onChange(previous);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const known = browsers.some((b) => b.device_id === value);
  return (
    <div className="pt-3 border-t border-cc-border space-y-1.5">
      <label htmlFor={selectId} className="block text-sm font-medium">Preferred Chrome browser</label>
      <div className="flex items-center gap-2">
        <select
          id={selectId}
          value={value}
          aria-describedby={helpId}
          onChange={(e) => save(e.target.value)}
          className="flex-1 min-w-0 px-2 py-2 rounded-lg bg-cc-input-bg border border-cc-border text-sm text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary"
        >
          <option value="">Automatic: the browser on this machine</option>
          {value && !known && <option value={value}>Saved browser ({value.slice(0, 8)}…)</option>}
          {browsers.map((b) => (
            <option key={b.device_id} value={b.device_id}>
              {b.name}{b.os_platform ? ` (${b.os_platform})` : ""}{b.current ? " · in use" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={detect}
          disabled={loading}
          className="shrink-0 px-3 py-2 rounded-lg text-xs bg-cc-hover hover:bg-cc-active cursor-pointer disabled:cursor-wait"
        >
          {loading ? "Detecting..." : "Detect browsers"}
        </button>
      </div>
      <p id={helpId} className="text-xs text-cc-muted px-1">
        Claude sessions with Claude in Chrome on (set per domain) drive this browser when several are connected to your
        account. Requires Claude Code. Detecting needs a running Claude session with Chrome on.
      </p>
      {note && <p role="status" className="text-xs text-cc-muted px-1">{note}</p>}
      {error && <p role="alert" className="text-xs text-cc-error px-1">{error}</p>}
    </div>
  );
}
