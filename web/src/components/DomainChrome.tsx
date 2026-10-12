import { useCallback, useEffect, useId, useState } from "react";
import { api, type ConnectedBrowser, type DomainPatch, type DomainSummary } from "../api.js";
import { Toggle } from "./DomainToggle.js";

/**
 * Claude in Chrome for one domain (Claude Code only): start its Claude
 * sessions with Chrome on, and which browser they drive.
 */
export function DomainChrome({
  domain,
  busy,
  onUpdate,
}: {
  domain: DomainSummary;
  busy: boolean;
  onUpdate: (patch: DomainPatch) => Promise<void>;
}) {
  return (
    <section aria-label="Claude in Chrome">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Claude in Chrome</h3>
      <div className="mt-1 flex items-center gap-2 text-[12px]">
        <Toggle label="Claude in Chrome" checked={domain.chrome} disabled={busy} onChange={(on) => void onUpdate({ chrome: on })} />
        <span>Start Claude sessions with Chrome on</span>
        <span className="text-[10px] text-cc-muted">Requires Claude Code (Codex sessions are not affected)</span>
      </div>
      {domain.chrome && <ChromeBrowserPicker domain={domain} busy={busy} onUpdate={onUpdate} />}
    </section>
  );
}

const MANUAL = "__manual__";

/**
 * Which browser a domain's Chrome sessions drive. "Prefer local browser"
 * (default) drives the browser on Companion's own machine, falling back to a
 * remote one (so a VPS session can drive the user's Mac). The connected
 * browsers come from a short isolated Claude query; when that list can't be
 * fetched, the user can still prefer local or type a browser deviceId by hand.
 * Claude Code only — Codex is unaffected.
 */
function ChromeBrowserPicker({
  domain,
  busy,
  onUpdate,
}: {
  domain: DomainSummary;
  busy: boolean;
  onUpdate: (patch: DomainPatch) => Promise<void>;
}) {
  const [browsers, setBrowsers] = useState<ConnectedBrowser[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const selectId = useId();
  const manualId = useId();

  const pref = domain.chromeBrowser || "local";
  const known = pref === "local" || browsers.some((b) => b.deviceId === pref);
  // Show the manual deviceId field when the user asked for it, or when the
  // saved value is a deviceId not in the list (list unfetched, browser offline).
  const [manualMode, setManualMode] = useState(false);
  const [manual, setManual] = useState(pref !== "local" ? pref : "");
  const manualOpen = manualMode || !known;

  const load = useCallback((force?: boolean) => {
    setLoading(true);
    setNote("");
    api.listChromeBrowsers(force)
      .then((res) => {
        setBrowsers(res.browsers);
        if (res.error) setNote(res.error);
        else if (res.browsers.length === 0) setNote("No browser is connected to Claude in Chrome right now.");
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyManual = () => {
    const id = manual.trim();
    if (id && id !== pref) void onUpdate({ chromeBrowser: id });
  };

  return (
    <div className="mt-2 pl-10 space-y-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-[11px] text-cc-muted">Browser to drive</label>
        <select
          id={selectId}
          value={manualOpen ? MANUAL : pref}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === MANUAL) { setManualMode(true); setManual(pref === "local" ? "" : pref); }
            else { setManualMode(false); setManual(""); void onUpdate({ chromeBrowser: e.target.value }); }
          }}
          className="px-1.5 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary"
        >
          <option value="local">Prefer local browser</option>
          {browsers.map((b) => (
            <option key={b.deviceId} value={b.deviceId}>
              {b.name}{b.osPlatform ? ` (${b.osPlatform})` : ""} · {b.isLocal ? "local" : "remote"}
            </option>
          ))}
          <option value={MANUAL}>Enter a deviceId…</option>
        </select>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={busy || loading}
          className="px-2 py-0.5 rounded-md text-[11px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-wait"
        >
          {loading ? "Detecting…" : "Detect browsers"}
        </button>
      </div>
      {manualOpen && (
        <div className="flex items-center gap-2">
          <label htmlFor={manualId} className="text-[11px] text-cc-muted">Browser deviceId</label>
          <input
            id={manualId}
            value={manual}
            disabled={busy}
            onChange={(e) => setManual(e.target.value)}
            onBlur={applyManual}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyManual(); } }}
            placeholder="deviceId from the list"
            className="w-48 px-2 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
      )}
      <p className="text-[10px] text-cc-muted leading-snug">
        "Prefer local browser" drives the browser on this machine, or a remote one (e.g. your Mac) when Companion runs on a
        server and no local browser is connected.
      </p>
      {note && <p role="status" className="text-[10px] text-cc-muted">{note}</p>}
    </div>
  );
}
