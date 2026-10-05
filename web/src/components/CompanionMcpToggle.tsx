import { useRef, useState } from "react";
import { api } from "../api.js";

/**
 * Settings switch "Companion MCP tools for sessions": whether every Claude
 * Code and Codex session gets the built-in `companion` MCP server (schedule
 * wake-ups into itself, create and manage agents). Saved at once; the server
 * reads it at each spawn, so it applies to sessions started or restarted
 * afterwards. A refused save rolls back and says why.
 */
export function CompanionMcpToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Only the latest save's answer is applied (fast double clicks).
  const req = useRef(0);

  async function toggle() {
    const next = !enabled;
    const id = ++req.current;
    onChange(next);
    setError("");
    setSaving(true);
    try {
      const res = await api.updateSettings({ companionMcpEnabled: next });
      if (id !== req.current) return;
      if (typeof res?.companionMcpEnabled === "boolean") onChange(res.companionMcpEnabled);
    } catch (err: unknown) {
      if (id !== req.current) return;
      onChange(!next);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === req.current) setSaving(false);
    }
  }

  return (
    <div className="pt-3 border-t border-cc-border">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-describedby="companion-mcp-help"
        onClick={toggle}
        disabled={saving}
        className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer disabled:cursor-wait"
      >
        <span>Companion MCP tools for sessions</span>
        <span className={`text-xs font-medium ${enabled ? "text-cc-success" : "text-cc-muted"}`}>
          {enabled ? "On" : "Off"}
        </span>
      </button>
      <p id="companion-mcp-help" className="mt-1 text-xs text-cc-muted px-1">
        Gives every Claude Code and Codex session the <code>companion</code> tools, so it can schedule wake-ups into
        itself and create, run and manage agents on its own. Applies to sessions started or restarted after the
        change.{" "}
        <a href="#/docs/guides/companion-mcp" className="text-cc-primary hover:underline">
          How it works
        </a>
      </p>
      {error && (
        <p role="alert" className="mt-1 text-xs text-cc-error px-1">{error}</p>
      )}
    </div>
  );
}
