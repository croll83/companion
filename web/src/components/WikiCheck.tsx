import { useCallback, useEffect, useState } from "react";
import { api, type BrainLintAdvice, type BrainLintFixId, type BrainLintView } from "../api.js";

const BUTTON = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

/** One problem: its sentence, the files concerned, and the fix button when there is one. */
export function AdviceItem({ advice, busy, onFix }: { advice: BrainLintAdvice; busy: boolean; onFix?: (fix: BrainLintFixId) => void }) {
  const tone = advice.level === "error" ? "text-cc-error" : "text-cc-warning";
  return (
    <li className="p-2 rounded-md border border-cc-border space-y-1">
      <p className="text-[12px]">
        <span className={`font-semibold ${tone}`}>{advice.level === "error" ? "Problem" : "Suggestion"}:</span> {advice.sentence}
      </p>
      {advice.paths.length > 0 && !(advice.paths.length === 1 && advice.sentence.includes(advice.paths[0])) && (
        <details>
          <summary className="text-[11px] text-cc-muted cursor-pointer">Files ({advice.count > advice.paths.length ? `${advice.paths.length} of ${advice.count}` : advice.paths.length})</summary>
          <ul className="mt-0.5 text-[11px] font-mono-code text-cc-muted break-all">
            {advice.paths.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </details>
      )}
      {advice.fix && onFix && (
        <button type="button" disabled={busy} onClick={() => onFix(advice.fix!.id)} className={BUTTON}>
          {advice.fix.label}
        </button>
      )}
    </li>
  );
}

/**
 * "Check the wiki" of an embedded brain: the brain's own lint as plain
 * sentences, errors first, with one-click fixes for the simple problems
 * (they only add to the wiki: a missing file, a section, a line). Runs at
 * once when `autoRun` (right after adopting a folder), else on demand.
 */
export function WikiCheck({ slug, autoRun = false, onFixed }: { slug: string; autoRun?: boolean; onFixed?: () => void }) {
  const [view, setView] = useState<BrainLintView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const run = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setView(await api.brainLint(slug));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [slug]);

  useEffect(() => { if (autoRun) void run(); }, [autoRun, run]);

  const fix = async (id: BrainLintFixId) => {
    setBusy(true);
    setError("");
    try {
      const r = await api.fixBrainLint(slug, id);
      setDone(r.done);
      setView(r.lint);
      onFixed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Wiki check" className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Wiki check</h3>
      <p className="text-[11px] text-cc-muted">
        The brain checks the wiki against its SCHEMA.md: frontmatter, tags, sources, links, the index and the log. Fixes only add to the wiki; they never delete.
      </p>
      <button type="button" onClick={() => void run()} disabled={busy} className={BUTTON}>
        {busy && !view ? "Checking…" : view ? "Check again" : "Check the wiki"}
      </button>
      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
      {done && <p role="status" className="text-[12px] text-cc-success">{done}.</p>}
      {view && (
        view.advice.length === 0 ? (
          <p className="text-[12px]">The wiki follows its rules: nothing to fix ({view.pages} pages).</p>
        ) : (
          <>
            <p className="text-[12px]">
              {view.pages} pages · {view.errors} problem{view.errors === 1 ? "" : "s"} · {view.warnings} suggestion{view.warnings === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1.5">
              {view.advice.map((a) => <AdviceItem key={a.id} advice={a} busy={busy} onFix={(id) => void fix(id)} />)}
            </ul>
          </>
        )
      )}
    </section>
  );
}
