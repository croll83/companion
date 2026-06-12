import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { getEffortLevels, modelSupportsEffort, DEFAULT_EFFORT } from "../utils/backends.js";

interface EffortSwitcherProps {
  sessionId: string;
}

/** Human label for an effort level. */
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/**
 * Reasoning-effort selector. Effort is the primary depth control on fable-5 and
 * Opus 4.6+, but the Claude CLI only accepts it via the `--effort` launch flag,
 * so changing it relaunches the CLI with `--resume` (same as a model switch).
 * Hidden for models that don't support effort, for Codex, and when disconnected.
 */
export function EffortSwitcher({ sessionId }: EffortSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const sdkSession = useStore((s) =>
    s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
  );
  const runtimeSession = useStore((s) => s.sessions.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const backendType = sdkSession?.backendType ?? runtimeSession?.backend_type ?? "claude";
  const currentModel = runtimeSession?.model ?? sdkSession?.model ?? "";
  const currentEffort = runtimeSession?.effort ?? sdkSession?.effort ?? DEFAULT_EFFORT;
  const levels = getEffortLevels(currentModel);

  const handleSelect = useCallback(
    (effort: string) => {
      setOpen(false);
      if (effort === currentEffort) return;

      sendToSession(sessionId, { type: "set_effort", effort });

      // Optimistic update so the toolbar reflects the new level immediately.
      const { sdkSessions, setSdkSessions } = useStore.getState();
      setSdkSessions(
        sdkSessions.map((sdk) =>
          sdk.sessionId === sessionId ? { ...sdk, effort } : sdk,
        ),
      );
    },
    [sessionId, currentEffort],
  );

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Hide for Codex, when disconnected, or when the model doesn't support effort.
  if (backendType === "codex" || !cliConnected || !modelSupportsEffort(currentModel)) {
    return null;
  }

  const currentLabel = EFFORT_LABELS[currentEffort] ?? currentEffort;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1 h-8 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer ${
          open
            ? "text-cc-fg bg-cc-active"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
        }`}
        title={`Reasoning effort: ${currentLabel}`}
        aria-label="Set reasoning effort"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
          <path d="M8 1.5a1 1 0 011 1V3a5 5 0 013.5 8.5l-.7.7a1 1 0 01-.7.3H4.9a1 1 0 01-.7-.3l-.7-.7A5 5 0 017 3v-.5a1 1 0 011-1zM6 14a1 1 0 011-1h2a1 1 0 110 2H7a1 1 0 01-1-1z" />
        </svg>
        <span>{currentLabel}</span>
        <svg viewBox="0 0 12 12" fill="currentColor" className="w-2.5 h-2.5 opacity-50">
          <path d="M6 8L1.5 3.5h9L6 8z" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 z-50 min-w-[140px] rounded-lg border border-cc-separator bg-cc-bg shadow-lg overflow-hidden"
          role="listbox"
          aria-label="Select reasoning effort"
        >
          {levels.map((level) => (
            <button
              key={level}
              onClick={() => handleSelect(level)}
              className={`w-full flex items-center gap-2 px-3 min-h-[44px] text-[13px] transition-colors cursor-pointer ${
                level === currentEffort
                  ? "text-cc-fg bg-cc-active font-medium"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              role="option"
              aria-selected={level === currentEffort}
            >
              <span className="flex-1 text-left">{EFFORT_LABELS[level] ?? level}</span>
              {level === currentEffort && (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary shrink-0">
                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
