import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { supportsUltracode } from "../utils/backends.js";

/** How long to wait for the CLI to confirm before letting the user retry. */
const CONFIRM_TIMEOUT_MS = 10_000;

/**
 * Ultracode on/off, next to the effort selector (Claude only).
 *
 * Ultracode is Claude Code's standing dynamic-workflow orchestration. Unlike
 * effort it is a runtime flag: the CLI switches it in place, no relaunch. The
 * button shows what the CLI CONFIRMED, never what was requested — a refusal
 * (model without xhigh, dynamic workflows off) arrives as an error and the
 * button stays as it was. Hidden where the CLI could not run it anyway.
 */
export function UltracodeToggle({ sessionId }: { sessionId: string }) {
  const sdkSession = useStore((s) =>
    s.sdkSessions.find((sdk) => sdk.sessionId === sessionId) || null,
  );
  const runtimeSession = useStore((s) => s.sessions.get(sessionId));
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);

  const backendType = sdkSession?.backendType ?? runtimeSession?.backend_type ?? "claude";
  const currentModel = runtimeSession?.model ?? sdkSession?.model ?? "";
  const enabled = runtimeSession?.ultracode ?? sdkSession?.ultracode ?? false;

  // Waiting for the CLI's answer. Keyed on the answer's timestamp, not on the
  // value: a refusal leaves the value as it was and would never end the wait.
  const confirmedAt = runtimeSession?.ultracodeConfirmedAt;
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setPending(false);
    if (timer.current) clearTimeout(timer.current);
  }, [confirmedAt]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (backendType !== "claude" || !cliConnected || !supportsUltracode(currentModel)) {
    return null;
  }

  function toggle() {
    if (pending) return;
    setPending(true);
    sendToSession(sessionId, { type: "set_ultracode", enabled: !enabled });
    // Never leave the button stuck if no answer comes at all.
    timer.current = setTimeout(() => setPending(false), CONFIRM_TIMEOUT_MS);
  }

  const title = pending
    ? "Ultracode: waiting for the CLI…"
    : enabled
      ? "Ultracode on — standing dynamic-workflow orchestration. Click to turn off."
      : "Ultracode off — click to enable standing dynamic-workflow orchestration.";

  return (
    <button
      onClick={toggle}
      disabled={pending}
      aria-pressed={enabled}
      aria-label="Ultracode"
      title={title}
      className={`shrink-0 flex items-center gap-1 h-8 px-2 rounded-md text-[12px] font-medium transition-colors cursor-pointer disabled:cursor-wait disabled:opacity-60 ${
        enabled
          ? "text-cc-primary bg-cc-primary/12 hover:bg-cc-primary/20"
          : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
        <path d="M9.2 1.3a.5.5 0 01.3.6L8.3 6.5h3.9a.5.5 0 01.4.8l-5.5 7.5a.5.5 0 01-.9-.4l1.2-4.9H3.6a.5.5 0 01-.4-.8l5.5-7.3a.5.5 0 01.5-.1z" />
      </svg>
      <span>Ultra</span>
    </button>
  );
}
