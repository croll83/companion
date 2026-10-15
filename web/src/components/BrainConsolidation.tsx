import { useCallback, useEffect, useId, useState } from "react";
import {
  api,
  type AgentInfo,
  type BrainConsolidationPatch,
  type BrainConsolidationRun,
  type BrainConsolidationView,
  type BrainInfo,
} from "../api.js";
import { CLAUDE_MODELS, CODEX_MODELS, effortChoiceFor, effortLabel, latestSonnet, settleEffort, toModelOptions } from "../utils/backends.js";
import { useCodexModels } from "../utils/use-codex-models.js";
import { EffortSelect } from "./EffortSelect.js";
import { sessionHash } from "../utils/routing.js";
import { FIELD } from "./BrainForm.js";

const BUTTON = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";
const PRIMARY = "px-2.5 py-1 rounded-md text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

const STATUS_TEXT: Record<BrainConsolidationRun["status"], string> = {
  running: "Running",
  success: "Success",
  skipped: "Skipped",
  not_synced: "Not synced",
  no_commit: "No commit",
  error: "Error",
};

const STATUS_CLASS: Record<BrainConsolidationRun["status"], string> = {
  running: "text-cc-primary",
  success: "text-cc-success",
  skipped: "text-cc-muted",
  not_synced: "text-cc-warning",
  no_commit: "text-cc-warning",
  error: "text-cc-error",
};

const TRIGGER_TEXT: Record<BrainConsolidationRun["trigger"], string> = {
  schedule: "scheduled",
  manual: "by hand",
  threshold: "notes over the threshold",
  "catch-up": "catch-up at startup",
  webhook: "webhook",
  linear: "Linear",
};

function when(ms: number | undefined | null): string {
  return ms ? new Date(ms).toLocaleString() : "";
}

/** "2 min 5 s", "45 s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

/** "3 accepted, 1 rejected" from the decisions of a run; "" when none. */
export function decidedText(decided: Record<string, number> | undefined): string {
  if (!decided) return "";
  return ["accepted", "rejected", "deferred", "discarded"]
    .filter((k) => decided[k])
    .map((k) => `${decided[k]} ${k}`)
    .join(", ");
}

/** One run: status, trigger, time, duration, decisions, commit, cost, session, and why it did not succeed. */
function RunItem({ run }: { run: BrainConsolidationRun }) {
  const decided = decidedText(run.decided);
  const details = [
    run.finishedAt ? durationText(run.finishedAt - run.startedAt) : "",
    run.pending !== undefined && run.status !== "skipped" ? `${run.pending} waiting` : "",
    decided,
    run.commit ? `commit ${run.commit}` : "",
    run.lint ? (run.lint.errors || run.lint.warnings ? `wiki check: ${run.lint.errors} errors, ${run.lint.warnings} warnings` : "wiki check clean") : "",
    run.model ?? "",
    run.effort ? `${effortLabel(run.effort)} effort` : "",
    run.costUsd ? `$${run.costUsd.toFixed(2)}` : "",
    run.tokens ? `${run.tokens.input.toLocaleString()} in / ${run.tokens.output.toLocaleString()} out tokens` : "",
  ].filter(Boolean);
  return (
    <li className="p-2 rounded-md border border-cc-border space-y-0.5 text-[12px]">
      <p>
        <span className={`font-semibold ${STATUS_CLASS[run.status]}`}>{STATUS_TEXT[run.status]}</span>
        <span className="text-cc-muted">{` · ${TRIGGER_TEXT[run.trigger] ?? run.trigger} · ${when(run.startedAt)}`}</span>
      </p>
      {details.length > 0 && <p className="text-[11px] text-cc-muted">{details.join(" · ")}</p>}
      {run.error && <p className={`text-[11px] whitespace-pre-wrap break-words ${run.status === "skipped" ? "text-cc-muted" : "text-cc-error"}`}>{run.error}</p>}
      {run.sessionId && (
        <a href={sessionHash(run.sessionId)} className="text-[11px] text-cc-primary hover:underline">Open the run's session</a>
      )}
    </li>
  );
}

function RunList({ runs }: { runs: BrainConsolidationRun[] }) {
  if (runs.length === 0) return <p className="text-[12px] text-cc-muted">No run yet.</p>;
  return (
    <ul aria-label="Consolidation runs" className="space-y-1.5">
      {runs.slice(0, 20).map((r) => <RunItem key={r.id} run={r} />)}
    </ul>
  );
}

/**
 * The note under the effort picker: what the runs really use when the chosen
 * level is not one the resolved model takes ("latest Sonnet" moves with the
 * catalog), mirroring the server's resolveConsolidationEffort.
 */
function effortFallbackNote(effort: string, model: string | undefined, levels: string[], settled: { effort?: string; fallback: boolean }): string {
  if (!settled.fallback || levels.length === 0) return "";
  const runsAt = settled.effort ? `its default (${effortLabel(settled.effort)})` : "the CLI's own level";
  return `${model ?? "This model"} does not support ${effortLabel(effort)}: runs use ${runsAt}.`;
}

/** The schedule, backend, model, effort and threshold of an embedded brain, saved together. */
function Settings({ view, busy, onSave }: { view: BrainConsolidationView; busy: boolean; onSave: (patch: BrainConsolidationPatch) => void }) {
  const ids = { schedule: useId(), backend: useId(), model: useId(), threshold: useId() };
  const [schedule, setSchedule] = useState(view.config.schedule);
  const [backend, setBackend] = useState(view.config.backend);
  const [model, setModel] = useState(view.config.model ?? "");
  const [threshold, setThreshold] = useState(String(view.config.threshold));
  const [effort, setEffort] = useState(view.config.effort);
  const codexCatalog = useCodexModels(backend === "codex");
  const codexModels = codexCatalog ? toModelOptions(codexCatalog) : CODEX_MODELS;

  const models = backend === "codex" ? codexModels : CLAUDE_MODELS;
  // The saved default as the server resolved it; for an unsaved backend, the same rule here.
  const resolved = backend === view.config.backend && view.resolvedModel
    ? view.resolvedModel
    : backend === "claude" ? latestSonnet(CLAUDE_MODELS) : codexModels[0]?.value;
  const defaultLabel = backend === "claude"
    ? `Latest Sonnet (now: ${resolved ?? "none in the catalog"})`
    : `Codex's first model (now: ${resolved ?? "chosen by Codex"})`;
  // The effort is settled against the model the runs would get now.
  const runModel = model || resolved;
  const choice = effortChoiceFor(backend, runModel, codexCatalog);
  const settled = settleEffort(effort, choice.levels, choice.defaultEffort);

  return (
    <form
      aria-label="Consolidation settings"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ schedule: schedule.trim(), backend, model: model || null, effort, threshold: Number(threshold) });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={ids.schedule} className="block text-[11px] text-cc-muted">Schedule (cron)</label>
          <input id={ids.schedule} value={schedule} onChange={(e) => setSchedule(e.target.value)} className={`${FIELD} font-mono-code`} />
        </div>
        <div>
          <label htmlFor={ids.threshold} className="block text-[11px] text-cc-muted">Run early at (waiting notes)</label>
          <input id={ids.threshold} type="number" min={1} max={1000} value={threshold} onChange={(e) => setThreshold(e.target.value)} className={FIELD} />
        </div>
        <div>
          <label htmlFor={ids.backend} className="block text-[11px] text-cc-muted">Backend</label>
          <select
            id={ids.backend}
            value={backend}
            onChange={(e) => { setBackend(e.target.value as "claude" | "codex"); setModel(""); }}
            className={FIELD}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </div>
        <div>
          <label htmlFor={ids.model} className="block text-[11px] text-cc-muted">Model</label>
          <select id={ids.model} value={model} onChange={(e) => setModel(e.target.value)} className={FIELD}>
            <option value="">{defaultLabel}</option>
            {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <span aria-hidden="true" className="block text-[11px] text-cc-muted">Reasoning effort</span>
          <EffortSelect
            label="Reasoning effort"
            levels={choice.levels}
            value={effort}
            onChange={setEffort}
            unavailableNote={backend === "codex" && !codexCatalog
              ? "Effort levels unknown until Codex has run once on this machine: runs use the model's default."
              : "This model has no effort setting: the CLI picks its own."}
            note={effortFallbackNote(effort, runModel, choice.levels, settled)}
            className={FIELD}
          />
        </div>
      </div>
      <p className="text-[10px] text-cc-muted">
        Default: every day at 05:00 (Companion's time zone). A run starts early when that many notes wait and the last run is over 6 hours old,
        and at startup when notes wait and the last run is over a day old. A run with no note waiting is skipped without starting a session.
      </p>
      <button type="submit" disabled={busy} className={BUTTON}>Save consolidation settings</button>
    </form>
  );
}

/** Remote brains: link an agent the user already runs; its prompt and schedule stay as they are. */
function LinkAgent({ view, busy, onLink }: { view: BrainConsolidationView; busy: boolean; onLink: (agentId: string | null) => void }) {
  const id = useId();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [choice, setChoice] = useState(view.agent?.id ?? "");
  useEffect(() => {
    let live = true;
    api.listAgents().then((a) => { if (live) setAgents(a); }).catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, []);
  return (
    <form
      aria-label="Link the consolidation agent"
      className="space-y-1.5"
      onSubmit={(e) => { e.preventDefault(); onLink(choice || null); }}
    >
      <p className="text-[12px]">
        This brain's server is consolidated by an agent you run (its own prompt, schedule and push). Link it to see its runs here: Companion
        changes nothing in it.
      </p>
      <label htmlFor={id} className="block text-[11px] text-cc-muted">Consolidation agent</label>
      <div className="flex gap-2">
        <select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} className={FIELD} disabled={!agents}>
          <option value="">None</option>
          {(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button type="submit" disabled={busy || !agents || choice === (view.agent?.id ?? "")} className={BUTTON}>
          {choice ? "Link" : "Unlink"}
        </button>
      </div>
    </form>
  );
}

/**
 * The Consolidation tab. Embedded brains: turn it on (Companion creates the
 * consolidation agent from its template), schedule, backend and model
 * ("Latest Sonnet" by default, resolved at every run), threshold,
 * "Consolidate now", "Retry sync" after a run that could not reach the wiki,
 * and the last runs with their verified outcome. Remote brains: link the
 * agent that consolidates the brain where it runs, and see its runs.
 */
export function BrainConsolidation({ brain, waiting, onChanged }: { brain: BrainInfo; waiting: number; onChanged?: () => void }) {
  const [view, setView] = useState<BrainConsolidationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const embedded = brain.kind === "embedded";
  const toggleId = useId();

  const load = useCallback(async () => {
    try {
      setView(await api.brainConsolidation(brain.slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [brain.slug]);

  useEffect(() => { void load(); }, [load]);

  // While a run is in progress, follow it.
  useEffect(() => {
    if (!view?.running) return;
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [view?.running, load]);

  const act = async (fn: () => Promise<{ view: BrainConsolidationView; message: string }>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      setView(r.view);
      setNotice(r.message);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (patch: BrainConsolidationPatch, message = "Saved.") =>
    act(async () => ({ view: await api.updateBrainConsolidation(brain.slug, patch), message }));
  const runNow = () => act(async () => {
    const r = await api.runBrainConsolidation(brain.slug);
    return { view: r.consolidation, message: r.started ? "Started: the run's session appears in the sidebar." : r.run?.error ?? "Not started." };
  });
  const retrySync = () => act(async () => {
    const r = await api.syncBrainConsolidation(brain.slug);
    return { view: r.consolidation, message: r.run.status === "success" ? "Synced into the wiki." : r.run.error ?? "Not synced." };
  });

  if (!view) {
    return (
      <section aria-label="Consolidation" className="space-y-2">
        {error ? <p role="alert" className="text-[12px] text-cc-error">{error}</p> : <p className="text-[12px] text-cc-muted">Loading…</p>}
      </section>
    );
  }

  const last = view.runs[0];
  const status = [
    waiting > 0 ? `${waiting} note${waiting === 1 ? "" : "s"} waiting` : "No note waiting",
    view.lastSuccessAt ? `last consolidated ${when(view.lastSuccessAt)}` : "never consolidated",
    embedded && view.config.enabled && view.nextRunAt ? `next run ${when(view.nextRunAt)}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section aria-label="Consolidation" className="space-y-3">
      <p className="text-[11px] text-cc-muted">
        {embedded
          ? "An agent reviews the waiting notes and turns them into wiki pages, in a git clone of the wiki. Companion then brings its commit into the wiki folder and reloads the brain."
          : "Turning notes into pages happens where the brain's server runs."}
      </p>
      <p className="text-[12px]">{status}</p>

      {embedded ? (
        <>
          <div className="flex items-center gap-2">
            <input
              id={toggleId}
              type="checkbox"
              checked={view.config.enabled}
              disabled={busy}
              onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? "Consolidation is on." : "Consolidation is off.")}
            />
            <label htmlFor={toggleId} className="text-[12px]">Consolidate this brain automatically</label>
          </div>
          {view.agent ? (
            <p className="text-[11px] text-cc-muted">
              Agent <a href="#/agents" className="text-cc-primary hover:underline">{view.agent.name}</a>, in the{" "}
              {view.domain === "global" ? "GLOBAL" : view.domain} domain.
            </p>
          ) : (
            <p className="text-[11px] text-cc-muted">Turning it on creates the consolidation agent (listed in Agents).</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void runNow()} disabled={busy || view.running || !view.agent} className={PRIMARY}>
              {view.running ? "Consolidating…" : `Consolidate now${waiting > 0 ? ` (${waiting} waiting)` : ""}`}
            </button>
            {last?.status === "not_synced" && !view.running && (
              <button type="button" onClick={() => void retrySync()} disabled={busy} className={BUTTON}>Retry sync</button>
            )}
            {view.runningSessionId && (
              <a href={sessionHash(view.runningSessionId)} className="self-center text-[12px] text-cc-primary hover:underline">Open the running session</a>
            )}
          </div>
          <Settings key={`${view.config.schedule}|${view.config.backend}|${view.config.model ?? ""}|${view.config.effort}|${view.config.threshold}`} view={view} busy={busy} onSave={(p) => void save(p)} />
        </>
      ) : (
        <LinkAgent key={view.agent?.id ?? ""} view={view} busy={busy} onLink={(agentId) => void save({ agentId }, agentId ? "Linked." : "Unlinked.")} />
      )}

      {error && <p role="alert" className="text-[12px] text-cc-error whitespace-pre-wrap">{error}</p>}
      {notice && <p role="status" className="text-[12px] text-cc-muted">{notice}</p>}

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Last runs</h3>
        <RunList runs={view.runs} />
      </div>
    </section>
  );
}
