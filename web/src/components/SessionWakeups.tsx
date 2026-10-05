import { useCallback, useEffect, useState } from "react";
import { api, type SessionWakeup } from "../api.js";
import { useStore } from "../store.js";

/** How often the list is refreshed while shown (a wake-up may fire meanwhile). */
const REFRESH_MS = 60_000;

function formatWhen(ms: number | undefined, timeZone: string): string {
  if (!ms) return "not scheduled";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

function scheduleLabel(wakeup: SessionWakeup, timeZone: string): string {
  if ("cron" in wakeup.schedule) {
    return `Repeats ${wakeup.schedule.cron} · next ${formatWhen(wakeup.nextRunAt, timeZone)}`;
  }
  return formatWhen(wakeup.nextRunAt, timeZone);
}

/**
 * Scheduled messages ("wake-ups") into this session: when they fire, the
 * text is sent as a user message with its full context — a dead CLI is
 * relaunched on its conversation first, a running turn is never interrupted.
 * Lists pending ones (with cancel), reports skipped/missed ones, and can
 * schedule a new one. Works the same for Claude Code and Codex sessions.
 */
export function SessionWakeups({ sessionId }: { sessionId: string }) {
  const timeZone = useStore((s) => s.timeZone);
  const [wakeups, setWakeups] = useState<SessionWakeup[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [at, setAt] = useState("");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.listSessionWakeups(sessionId)
      .then(({ wakeups: list }) => setWakeups(list))
      .catch(() => { /* keep the last list; the next refresh retries */ });
  }, [sessionId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function schedule(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.createSessionWakeup(sessionId, repeat ? { message, cron } : { message, at });
      setMessage("");
      setAt("");
      setFormOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.cancelSessionWakeup(sessionId, id);
    } catch {
      /* already gone: the refresh shows the truth */
    }
    load();
  }

  const pending = wakeups.filter((w) => w.enabled);
  const problems = wakeups.filter((w) => !w.enabled && (w.status === "skipped" || w.status === "missed"));
  const canSubmit = !saving && message.trim() !== "" && (repeat ? cron.trim() !== "" : at !== "");

  return (
    <section aria-label="Wake-ups" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Wake-ups</h3>
        <button
          type="button"
          onClick={() => { setFormOpen((open) => !open); setError(""); }}
          aria-expanded={formOpen}
          className="text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer"
        >
          {formOpen ? "Close" : "Schedule"}
        </button>
      </div>

      {pending.length > 0 && (
        <ul className="mt-1.5 space-y-1" aria-label="Pending wake-ups">
          {pending.map((w) => (
            <li key={w.id} className="flex items-start gap-2 text-[11px]">
              <div className="min-w-0 flex-1">
                <div className="text-cc-fg font-medium">{scheduleLabel(w, timeZone)}</div>
                <div className="text-cc-muted truncate" title={w.message}>{w.message}</div>
                {w.lastResult && <div className="text-cc-warning">{w.lastResult}</div>}
              </div>
              <button
                type="button"
                onClick={() => remove(w.id)}
                aria-label={`Cancel wake-up ${w.id}`}
                className="shrink-0 px-1.5 py-0.5 rounded text-cc-muted hover:text-cc-error hover:bg-cc-hover cursor-pointer"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        <ul className="mt-1.5 space-y-1" aria-label="Wake-ups that did not run">
          {problems.map((w) => (
            <li key={w.id} className="flex items-start gap-2 text-[11px]">
              <div className="min-w-0 flex-1 text-cc-warning">
                <span className="text-cc-muted truncate block" title={w.message}>{w.message}</span>
                {w.lastResult ?? (w.status === "missed" ? "Missed" : "Skipped")}
              </div>
              <button
                type="button"
                onClick={() => remove(w.id)}
                aria-label={`Dismiss wake-up ${w.id}`}
                className="shrink-0 px-1.5 py-0.5 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}

      {formOpen && (
        <form onSubmit={schedule} className="mt-2 space-y-2" aria-label="Schedule a wake-up">
          <label className="block text-[11px] text-cc-muted">
            Message
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              className="mt-0.5 w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs resize-none focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
          </label>
          <fieldset className="flex items-center gap-3 text-[11px] text-cc-fg">
            <legend className="sr-only">When</legend>
            <label className="flex items-center gap-1">
              <input type="radio" name={`wakeup-when-${sessionId}`} checked={!repeat} onChange={() => setRepeat(false)} />
              Once
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name={`wakeup-when-${sessionId}`} checked={repeat} onChange={() => setRepeat(true)} />
              Repeat (cron)
            </label>
          </fieldset>
          {repeat ? (
            <label className="block text-[11px] text-cc-muted">
              Cron expression
              <input
                type="text"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className="mt-0.5 w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
              />
            </label>
          ) : (
            <label className="block text-[11px] text-cc-muted">
              Time
              <input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                className="mt-0.5 w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
              />
            </label>
          )}
          <p className="text-[10px] text-cc-muted">
            {timeZone
              ? `Times are in ${timeZone} (the time zone set in Settings).`
              : "Times are in the server's local time zone. Pick a time zone in Settings to pin it."}
          </p>
          {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-2.5 py-1 text-[11px] rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
          >
            {saving ? "Scheduling..." : "Schedule wake-up"}
          </button>
        </form>
      )}
    </section>
  );
}
