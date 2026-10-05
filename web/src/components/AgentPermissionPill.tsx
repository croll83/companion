import { useEffect, useRef, useState } from "react";
import { getAgentModesForBackend } from "../utils/backends.js";

const PILL = "flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors";

/**
 * Permissions control of the agent editors.
 *
 * Claude agents always run with full permissions (bypassPermissions): a run
 * is unattended, so any mode that asks for approval would just block. That is
 * shown as a fixed badge instead of a picker whose choice would be ignored.
 * For Codex the choice is real but it is the sandbox, not approvals (Codex
 * never asks in agent runs): Full Auto → danger-full-access, Supervised →
 * workspace-write.
 */
export function AgentPermissionPill({
  backendType,
  permissionMode,
  onChange,
}: {
  backendType: "claude" | "codex";
  permissionMode: string;
  onChange: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (backendType === "claude") {
    return (
      <span
        className={`${PILL} text-cc-muted cursor-default`}
        title="Agent runs are unattended, so Claude runs with bypassPermissions: no approval prompts. Limit what it can do with Allowed tools."
        data-testid="claude-full-permissions"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60" aria-hidden="true">
          <path d="M8 1l6 2.5v4C14 11 11.5 14 8 15 4.5 14 2 11 2 7.5v-4L8 1z" />
        </svg>
        Full permissions
      </span>
    );
  }

  const modes = getAgentModesForBackend("codex");
  const selected = modes.find((m) => m.value === permissionMode) || modes[0];
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Codex sandbox for agent runs"
        className={`${PILL} cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover`}
      >
        <span>{selected?.label}</span>
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
          {modes.map((m) => (
            <button
              type="button"
              key={m.value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${m.value === permissionMode ? "text-cc-primary font-medium" : "text-cc-fg"}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
