import { useRef, useState } from "react";
import { api } from "../api.js";
import { LocalProvidersSettings } from "./LocalProvidersSettings.js";

/** The guide: architecture, the proxy's install, settings, limits. */
export const LOCAL_LLM_DOC_URL = "https://github.com/croll83/companion/blob/main/docs/local-llm.md";

/**
 * Settings → Providers → "Enable local LLM": off for everyone by default.
 * On, it shows the local providers (Companion LLM proxies next to a vLLM
 * server) and the "Local" choice appears where sessions and agents are
 * created. Off again, no new local session can start; sessions already on a
 * provider keep running. Saved at once; a refused save rolls back.
 */
export function LocalLlmSettings({ enabled, onChange: setEnabled }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const req = useRef(0);

  async function toggle() {
    const next = !enabled;
    const id = ++req.current;
    setEnabled(next);
    setError("");
    setSaving(true);
    try {
      const res = await api.updateSettings({ localLlmEnabled: next });
      if (id === req.current && typeof res?.localLlmEnabled === "boolean") setEnabled(res.localLlmEnabled);
    } catch (err) {
      if (id !== req.current) return;
      setEnabled(!next);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === req.current) setSaving(false);
    }
  }

  return (
    <div className="pt-3 border-t border-cc-border space-y-3">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-describedby="local-llm-help"
        onClick={() => void toggle()}
        disabled={saving}
        className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:cursor-wait"
      >
        <span>Enable local LLM</span>
        <span className={`text-xs font-medium ${enabled ? "text-cc-success" : "text-cc-muted"}`}>{enabled ? "On" : "Off"}</span>
      </button>
      <p id="local-llm-help" className="text-xs text-cc-muted px-1">
        Run Claude Code sessions on your own model (vLLM) through the Companion LLM proxy, instead of the Anthropic
        account.{" "}
        <a href={LOCAL_LLM_DOC_URL} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
          How it works
        </a>
      </p>
      {error && <p className="text-xs text-cc-error px-1" role="alert">{error}</p>}
      {enabled && <LocalProvidersSettings />}
    </div>
  );
}
