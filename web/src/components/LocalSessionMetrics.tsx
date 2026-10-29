import { useCallback, useEffect, useState } from "react";
import { api, type LocalSessionMetricsView } from "../api.js";
import { effortLabel } from "../utils/backends.js";

/** How often the numbers are read again while the panel is open. */
const REFRESH_MS = 5_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[11px] text-cc-muted">{label}</dt>
      <dd className="text-[11px] text-cc-fg tabular-nums font-medium truncate">{value}</dd>
    </div>
  );
}

/**
 * The context panel's "Usage" for a session on a local provider, instead of
 * the Anthropic cost and limits (a local model costs nothing): the
 * provider's state, the session's reasoning level, and what the provider's
 * Companion LLM proxy measured for this session (tools/llm-proxy): tokens
 * in/out, requests, time to first token, duration and speed of the last
 * answer. Also which credentials the CLI sent the proxy (kinds, never
 * values), to check that no Anthropic token leaves. The proxy keeps the
 * numbers in memory: they reset when it restarts.
 */
export function LocalSessionMetrics({ sessionId, preview }: { sessionId: string; preview?: LocalSessionMetricsView }) {
  const [view, setView] = useState<LocalSessionMetricsView | null>(preview ?? null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setView(await api.getLocalSessionMetrics(sessionId));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  useEffect(() => {
    // The Playground shows a fixed preview: nothing to fetch.
    if (preview) return;
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load, preview]);

  if (!view) {
    return error ? <p className="px-4 py-2.5 text-[11px] text-cc-error">Local metrics unavailable: {error}</p> : null;
  }
  const m = view.metrics;
  const status = view.provider.missing ? "deleted" : view.provider.health?.status ?? "unknown";
  return (
    <div className="shrink-0 px-4 py-2.5 space-y-2" aria-label="Local provider usage">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-cc-muted uppercase tracking-wider">Local provider</span>
        <span
          className={`text-[10px] font-medium px-1.5 rounded-full leading-[16px] ${
            status === "online" ? "text-cc-success bg-cc-success/10" : status === "unknown" ? "text-cc-muted bg-cc-hover" : "text-cc-error bg-cc-error/10"
          }`}
        >
          {status}
        </span>
      </div>
      <dl className="space-y-1">
        <Row label="Provider" value={view.provider.name ?? view.provider.id} />
        <Row label="Model" value={view.model} />
        <Row label="Reasoning" value={view.effort ? view.effortLabel ?? effortLabel(view.effort) : "—"} />
        {view.provider.contextWindow ? <Row label="Context window" value={formatTokens(view.provider.contextWindow)} /> : null}
      </dl>
      {m ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 border-t border-cc-border">
          <Row label="Input" value={formatTokens(m.inputTokens)} />
          <Row label="Output" value={formatTokens(m.outputTokens)} />
          <Row label="Requests" value={String(m.requests)} />
          <Row label="Errors" value={String(m.errors)} />
          <Row label="Last TTFT" value={formatMs(m.last?.ttftMs)} />
          <Row label="Last answer" value={formatMs(m.last?.durationMs)} />
          {m.last?.outputTokensPerSec !== undefined && <Row label="Speed" value={`${m.last.outputTokensPerSec} tok/s`} />}
          {m.cacheReadTokens > 0 && <Row label="Cached" value={formatTokens(m.cacheReadTokens)} />}
        </dl>
      ) : view.metricsError ? (
        <p className="text-[11px] text-cc-muted">The proxy&apos;s numbers are unavailable: {view.metricsError}</p>
      ) : (
        <p className="text-[11px] text-cc-muted">No request yet. Costs do not apply: the model runs on your provider.</p>
      )}
      {m && m.authSeen.length > 0 && (
        <p className="text-[10px] text-cc-muted break-words">
          Credentials the proxy received from the CLI (dropped before the model server): {m.authSeen.join(", ")}
        </p>
      )}
    </div>
  );
}
