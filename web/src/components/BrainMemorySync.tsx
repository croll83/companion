import { useCallback, useEffect, useId, useState } from "react";
import { api, type BrainInfo, type BrainMemorySyncDomainReport, type BrainMemorySyncPatch, type BrainMemorySyncRun, type BrainMemorySyncView } from "../api.js";
import { FIELD } from "./BrainForm.js";

const BUTTON = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";
const PRIMARY = "px-2.5 py-1 rounded-md text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 files sent, 1 deleted, 62 unchanged, 2 waiting for the next run". */
export function domainSummary(d: BrainMemorySyncDomainReport): string {
  return [
    `${plural(d.sent.length, "file")} sent`,
    d.deleted.length ? `${d.deleted.length} deleted` : "",
    `${d.unchanged} unchanged`,
    d.deferred.length ? `${d.deferred.length} waiting for the next run` : "",
    d.skipped.length ? `${d.skipped.length} skipped` : "",
    d.failed.length ? `${d.failed.length} failed` : "",
  ].filter(Boolean).join(", ");
}

function LastRun({ run }: { run: BrainMemorySyncRun }) {
  return (
    <div className="space-y-1 text-[12px]">
      <p>
        <span className={`font-semibold ${run.ok ? "text-cc-success" : "text-cc-error"}`}>{run.ok ? "Done" : "With errors"}</span>
        <span className="text-cc-muted">{` · ${run.trigger === "manual" ? "by hand" : "scheduled"} · ${new Date(run.at).toLocaleString()}`}</span>
      </p>
      {run.error && <p className="text-[11px] text-cc-error whitespace-pre-wrap break-words">{run.error}</p>}
      <ul aria-label="Memory sync by domain" className="space-y-1">
        {run.domains.map((d) => (
          <li key={d.domain} className="p-2 rounded-md border border-cc-border space-y-0.5">
            <p><strong>{d.domain}</strong>: {domainSummary(d)}</p>
            {d.redacted.length > 0 && (
              <p className="text-[11px] text-cc-muted">Keys or certificates replaced in: {d.redacted.map((r) => `${r.file} (${r.count})`).join(", ")}</p>
            )}
            {d.skipped.length > 0 && <p className="text-[11px] text-cc-muted">Skipped: {d.skipped.map((s) => `${s.file} (${s.reason})`).join(", ")}</p>}
            {d.failed.map((f) => <p key={f.file} className="text-[11px] text-cc-error break-words">{f.file}: {f.error}</p>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Schedule, files per run and, for a remote brain, the ingest API address and token, saved together. */
function Settings({ view, remote, busy, onSave }: { view: BrainMemorySyncView; remote: boolean; busy: boolean; onSave: (patch: BrainMemorySyncPatch) => void }) {
  const ids = { schedule: useId(), max: useId(), url: useId(), token: useId() };
  const [schedule, setSchedule] = useState(view.config.schedule);
  const [maxFiles, setMaxFiles] = useState(String(view.config.maxFiles));
  const [url, setUrl] = useState(view.config.ingestUrl ?? "");
  const [token, setToken] = useState("");
  return (
    <form
      aria-label="Memory sync settings"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          schedule: schedule.trim(),
          maxFiles: Number(maxFiles),
          ...(remote ? { ingestUrl: url.trim() || null } : {}),
          ...(remote && token.trim() ? { token: token.trim() } : {}),
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={ids.schedule} className="block text-[11px] text-cc-muted">Schedule (cron)</label>
          <input id={ids.schedule} value={schedule} onChange={(e) => setSchedule(e.target.value)} className={`${FIELD} font-mono-code`} />
        </div>
        <div>
          <label htmlFor={ids.max} className="block text-[11px] text-cc-muted">Files per domain and run</label>
          <input id={ids.max} type="number" min={1} max={500} value={maxFiles} onChange={(e) => setMaxFiles(e.target.value)} className={FIELD} />
        </div>
      </div>
      {remote && (
        <>
          <div>
            <label htmlFor={ids.url} className="block text-[11px] text-cc-muted">Ingest API URL (the brain server&apos;s management address)</label>
            <input id={ids.url} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://brain-host:7422" className={`${FIELD} font-mono-code`} />
          </div>
          <div>
            <label htmlFor={ids.token} className="block text-[11px] text-cc-muted">
              Token with the curator scope (optional){view.tokenConfigured ? ": saved, leave empty to keep it" : ""}
            </label>
            <input id={ids.token} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={`${FIELD} font-mono-code`} />
          </div>
        </>
      )}
      <p className="text-[10px] text-cc-muted">
        Default: every day at 03:00 (Companion&apos;s time zone), before a consolidation at dawn. Files beyond the limit wait for the next run.
      </p>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BUTTON}>Save memory sync settings</button>
        {remote && view.tokenConfigured && (
          <button type="button" disabled={busy} onClick={() => onSave({ token: null })} className="text-[12px] text-cc-error hover:underline cursor-pointer disabled:opacity-50">
            Remove token
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Memory sync of a brain: every night Companion sends the memory files of the
 * domains using this brain (new and changed ones, with what changed; a notice
 * for deleted ones) so the brain stays in line with them. Private keys and
 * certificates are replaced; a file with `brain: no` in its frontmatter is
 * skipped. Remote brains need the ingest API of their server.
 */
export function BrainMemorySync({ brain }: { brain: BrainInfo }) {
  const [view, setView] = useState<BrainMemorySyncView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const toggleId = useId();
  const remote = brain.kind === "remote";

  const load = useCallback(async () => {
    try {
      setView(await api.brainMemorySync(brain.slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [brain.slug]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<{ view: BrainMemorySyncView; message: string }>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      setView(r.view);
      setNotice(r.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = (patch: BrainMemorySyncPatch, message = "Saved.") =>
    act(async () => ({ view: await api.updateBrainMemorySync(brain.slug, patch), message }));
  const runNow = () => act(async () => {
    const r = await api.runBrainMemorySync(brain.slug);
    const sent = r.run.domains.reduce((n, d) => n + d.sent.length + d.deleted.length, 0);
    return { view: r.memorySync, message: r.run.error ?? `${plural(sent, "file")} sent.` };
  });

  return (
    <section aria-label="Domain memory" className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Domain memory</h3>
      <p className="text-[12px]">
        Every night Companion can send the memory files of the domains using this brain: new and changed files, with what changed, and a
        notice for deleted ones. The brain&apos;s consolidation turns them into pages, so sessions no longer need to write the same fact twice.
        The memory itself is only read. Private keys and certificates are replaced; a file with <code className="font-mono-code">brain: no</code> in
        its frontmatter is never sent.
      </p>
      {!view ? (
        error ? <p role="alert" className="text-[12px] text-cc-error">{error}</p> : <p className="text-[12px] text-cc-muted">Loading…</p>
      ) : (
        <>
          <p className="text-[12px] text-cc-muted">
            {view.domains.length ? `Domains: ${view.domains.map((d) => (d === "global" ? "GLOBAL" : d)).join(", ")}` : "No domain uses this brain yet."}
          </p>
          <div className="flex items-center gap-2">
            <input
              id={toggleId}
              type="checkbox"
              checked={view.config.enabled}
              disabled={busy}
              onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? "Memory sync is on." : "Memory sync is off.")}
            />
            <label htmlFor={toggleId} className="text-[12px]">Send the domains&apos; memory to this brain every night</label>
          </div>
          {remote && !view.config.ingestUrl && (
            <p className="text-[11px] text-cc-muted">A remote brain needs the ingest API URL below before it can be turned on.</p>
          )}
          <button type="button" onClick={() => void runNow()} disabled={busy || view.running || view.domains.length === 0 || (remote && !view.config.ingestUrl)} className={PRIMARY}>
            {busy || view.running ? "Sending…" : "Sync now"}
          </button>
          <Settings key={`${view.config.schedule}|${view.config.maxFiles}|${view.config.ingestUrl ?? ""}|${view.tokenConfigured}`} view={view} remote={remote} busy={busy} onSave={(p) => void save(p)} />
          {error && <p role="alert" className="text-[12px] text-cc-error whitespace-pre-wrap">{error}</p>}
          {notice && <p role="status" className="text-[12px] text-cc-muted">{notice}</p>}
          {view.lastRun ? <LastRun run={view.lastRun} /> : <p className="text-[12px] text-cc-muted">No run yet.</p>}
        </>
      )}
    </section>
  );
}
