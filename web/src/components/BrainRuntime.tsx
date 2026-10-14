import { useCallback, useEffect, useState } from "react";
import type { BrainInfo, BrainRuntimeInfo } from "../api.js";

type ProcessAction = "start" | "stop" | "restart";

const STATE_TEXT: Record<BrainRuntimeInfo["state"], string> = {
  running: "Running",
  starting: "Starting…",
  unhealthy: "Not answering its health checks",
  backoff: "Restarting after a crash",
  failed: "Stopped after repeated failures",
  stopped: "Stopped",
};

function stateColor(state: BrainRuntimeInfo["state"]): string {
  if (state === "running") return "bg-cc-success";
  if (state === "failed") return "bg-cc-error";
  if (state === "stopped") return "bg-cc-muted";
  return "bg-cc-warning";
}

/**
 * The process of an EMBEDDED brain (run by Companion, brain-supervisor.ts):
 * its state, why it fails and what to do, Start / Stop / Restart, and for
 * troubleshooting the details (process id, the child's own port, which
 * sessions never use) and the last lines of its log, loaded on demand (and
 * at once when the brain failed).
 */
export function BrainRuntime({
  brain,
  busy,
  onAction,
  loadLogs,
}: {
  brain: BrainInfo;
  busy: boolean;
  onAction: (action: ProcessAction) => Promise<boolean>;
  /** The last log lines; null when they could not be read (the page shows the error). */
  loadLogs: () => Promise<string[] | null>;
}) {
  const rt: BrainRuntimeInfo = brain.runtime ?? { state: "stopped", crashes: 0 };
  const [logs, setLogs] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const running = rt.state !== "stopped" && rt.state !== "failed";

  const showLogs = useCallback(async () => {
    setLoading(true);
    setLogs(await loadLogs());
    setLoading(false);
  }, [loadLogs]);

  useEffect(() => {
    if (rt.state === "failed") void showLogs();
    // Only when the state changes: a reload of the same failure keeps the lines shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.state]);

  const button = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

  return (
    <section aria-label="Brain process" className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Brain process</h3>
      <div className="flex items-center gap-2 text-[12px]">
        <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${stateColor(rt.state)}`} />
        <span>
          {STATE_TEXT[rt.state]}
          {rt.crashes > 0 && rt.state !== "running" ? ` · ${rt.crashes} crash${rt.crashes === 1 ? "" : "es"} in 10 minutes` : ""}
        </span>
      </div>
      {rt.cause && (
        <div role="alert" className="p-2 rounded-lg border border-cc-error/30 bg-cc-error/5 text-[12px] space-y-0.5">
          <p>{rt.cause}</p>
          {rt.action && <p className="text-cc-muted">{rt.action}</p>}
        </div>
      )}
      <div className="flex gap-2">
        {!running && (
          <button type="button" disabled={busy} onClick={() => void onAction("start")} className={button}>
            Start
          </button>
        )}
        {running && (
          <button type="button" disabled={busy} onClick={() => void onAction("stop")} className={button}>
            Stop
          </button>
        )}
        <button type="button" disabled={busy || rt.state === "stopped"} onClick={() => void onAction("restart")} className={button}>
          Restart
        </button>
      </div>
      <details className="rounded-md border border-cc-border px-2 py-1.5">
        <summary className="text-[12px] text-cc-muted cursor-pointer">Troubleshooting</summary>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-cc-muted">
          <dt>Wiki folder</dt>
          <dd className="font-mono-code break-all">{brain.embedded?.wikiDir}</dd>
          <dt>Process</dt>
          <dd>{rt.pid ? `pid ${rt.pid}` : "none"}{rt.lastExitCode !== undefined && rt.lastExitCode !== null ? ` · last exit code ${rt.lastExitCode}` : ""}</dd>
          <dt>Own port</dt>
          <dd>{rt.port ? `${rt.port} (sessions use Companion's port instead)` : "none"}</dd>
        </dl>
        <div className="mt-1.5 flex gap-2">
          <button type="button" disabled={loading} onClick={() => void showLogs()} className={button}>
            {loading ? "Loading…" : logs ? "Reload log" : "Show log"}
          </button>
        </div>
        {logs && (
          logs.length > 0 ? (
            <pre aria-label="Brain log" className="mt-1.5 max-h-64 overflow-auto rounded-md bg-cc-code-bg text-cc-code-fg p-2 text-[10px] font-mono-code whitespace-pre-wrap break-all">
              {logs.join("\n")}
            </pre>
          ) : (
            <p className="mt-1.5 text-[11px] text-cc-muted">The log is empty.</p>
          )
        )}
      </details>
    </section>
  );
}
