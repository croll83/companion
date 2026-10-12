import { useEffect, useState } from "react";
import { api } from "../api.js";

type Status = { kind: "idle" } | { kind: "confirm" } | { kind: "busy" } | { kind: "done" } | { kind: "error"; message: string };

/** How long the "Reloaded" confirmation stays before the button comes back. */
const DONE_MS = 4_000;

/**
 * Force-reload the session's CLI: stop the process and start it again on the
 * same conversation (`--resume` for Claude, thread resume for Codex), so the
 * context is kept. Useful when a session looks stuck or disconnected.
 *
 * A forced reload interrupts a turn in progress, so it asks for confirmation
 * first. Works the same for Claude Code and Codex sessions.
 */
export function SessionReload({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (no https / permission): leave the label unchanged */
    }
  }

  // A different session in focus starts from a clean state.
  useEffect(() => setStatus({ kind: "idle" }), [sessionId]);

  useEffect(() => {
    if (status.kind !== "done") return;
    const timer = setTimeout(() => setStatus({ kind: "idle" }), DONE_MS);
    return () => clearTimeout(timer);
  }, [status.kind]);

  async function reload() {
    setStatus({ kind: "busy" });
    try {
      await api.relaunchSession(sessionId, { force: true });
      setStatus({ kind: "done" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section aria-label="Reload session" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      {status.kind === "confirm" ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-cc-fg">
            Restart the CLI on this conversation? A turn in progress is interrupted; the context is kept.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reload}
              className="px-2.5 py-1 text-[11px] rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover cursor-pointer"
            >
              Reload now
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: "idle" })}
              className="px-2.5 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Session</h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={copyId}
              aria-label="Copy session ID"
              className="text-[11px] px-2 py-0.5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
            >
              {copied ? "Copied" : "Copy ID"}
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: "confirm" })}
              disabled={status.kind === "busy"}
              className="text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status.kind === "busy" ? "Reloading..." : "Reload"}
            </button>
          </div>
        </div>
      )}
      {status.kind === "done" && (
        <p role="status" className="mt-1 text-[11px] text-cc-success">Reloaded: the CLI is starting on the same conversation.</p>
      )}
      {status.kind === "error" && (
        <p role="alert" className="mt-1 text-[11px] text-cc-error">{status.message}</p>
      )}
    </section>
  );
}
