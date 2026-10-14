import { useEffect, useId, useState } from "react";
import { api, type DomainSummary, type LegacyMemoryCopyResult, type LegacyMemoryNote } from "../api.js";
import { useStore } from "../store.js";
import { Sheet } from "./Sheet.js";

/** The folder memory of a legacy Claude session, as shown in the review dialog. */
interface Review {
  dir: string;
  notes: LegacyMemoryNote[];
}

type Step =
  | { kind: "idle" }
  | { kind: "choose"; target: string }
  | { kind: "loading"; target: string }
  /** Legacy Claude session: pick the folder-memory notes to copy before migrating. */
  | { kind: "review"; target: string; review: Review | null; loadError?: string }
  | { kind: "moving"; target: string; phase: "copying" | "migrating" }
  | { kind: "done"; to: string; copy?: LegacyMemoryCopyResult; noMemory?: boolean }
  | { kind: "error"; message: string };

const DONE_MS = 5_000;

/**
 * The focused session's domain, in the session panel. A domain session can
 * move to another domain ("Change domain"): from the restart on, its memory,
 * skills, MCP servers and instructions are the new domain's (same
 * conversation, same folder). Sessions from before domains show a "legacy
 * memory" badge: they keep their folder-based memory and spawn as before
 * until they are migrated on purpose ("Migrate to domain", any domain
 * including GLOBAL).
 *
 * Migration differs by backend:
 *  - Claude Code stops reading its folder auto-memory, so a dialog lists the
 *    folder's notes and copies the chosen ones into the domain memory first
 *    (copied, never moved; a note already in the domain is never overwritten).
 *  - Codex loses nothing (its ~/.codex/AGENTS.md is part of the domain
 *    AGENTS.md, project AGENTS.md files still apply, same thread): no dialog.
 */
export function SessionDomain({ sessionId }: { sessionId: string }) {
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const domain = sdk?.domain || "global";
  const legacy = sdk?.legacyMemory === true || !sdk?.domain;
  const codex = sdk?.backendType === "codex";
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const selectId = useId();

  useEffect(() => setStep({ kind: "idle" }), [sessionId]);

  useEffect(() => {
    let alive = true;
    api.listDomains().then((res) => { if (alive) setDomains(res.domains); }).catch(() => {});
    return () => { alive = false; };
  }, [sessionId]);

  const doneMs = step.kind === "done" && step.copy ? DONE_MS * 2 : DONE_MS;
  useEffect(() => {
    if (step.kind !== "done") return;
    const timer = setTimeout(() => setStep({ kind: "idle" }), doneMs);
    return () => clearTimeout(timer);
  }, [step.kind, doneMs]);

  const nameOf = (slug: string) => domains.find((d) => d.slug === slug)?.name ?? (slug === "global" ? "GLOBAL" : slug);
  // A legacy session is not really in GLOBAL yet, so it can migrate there too.
  const others = legacy ? domains : domains.filter((d) => d.slug !== domain);

  /** Copy the chosen notes (if any), then migrate or move. A failed copy migrates nothing. */
  async function move(target: string, files: string[] = [], extra: { noMemory?: boolean } = {}) {
    let copy: LegacyMemoryCopyResult | undefined;
    try {
      if (files.length > 0) {
        setStep({ kind: "moving", target, phase: "copying" });
        try {
          copy = await api.copyLegacyMemory(sessionId, target, files);
        } catch (err) {
          throw new Error(`Copying the notes failed, so the session was not migrated: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      setStep({ kind: "moving", target, phase: "migrating" });
      await (legacy ? api.migrateSessionToDomain(sessionId, target) : api.changeSessionDomain(sessionId, target));
      setStep({ kind: "done", to: target, ...(copy ? { copy } : {}), ...extra });
      api.listSessions().then((list) => useStore.getState().setSdkSessions(list)).catch(() => {});
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * "Migrate and restart" on a legacy Claude session: read its folder memory
   * first. No notes (or a Codex answer) → migrate right away; else the review
   * dialog. If the notes cannot be read the dialog still opens, with the
   * error and only "Migrate without copying".
   */
  async function reviewMemory(target: string) {
    setStep({ kind: "loading", target });
    try {
      const memory = await api.getLegacyMemory(sessionId, target);
      if (memory.backend !== "claude" || memory.notes.length === 0) {
        await move(target, [], memory.backend === "claude" ? { noMemory: true } : {});
        return;
      }
      setStep({ kind: "review", target, review: { dir: memory.dir, notes: memory.notes } });
    } catch (err) {
      setStep({ kind: "review", target, review: null, loadError: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = step.kind === "moving" || step.kind === "loading";
  const showForm = step.kind === "choose" || busy || step.kind === "review";
  const formTarget = showForm ? step.target : "";
  const primaryLabel =
    step.kind === "loading" ? "Reading memory..."
    : step.kind === "moving" && step.phase === "copying" ? "Copying notes..."
    : step.kind === "moving" ? (legacy ? "Migrating..." : "Moving...")
    : (legacy ? "Migrate and restart" : "Move and restart");

  return (
    <section aria-label="Session domain" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Domain</h3>
          <p className="text-[11px] text-cc-fg flex items-center gap-1.5 min-w-0">
            <span className="truncate">{nameOf(domain)}</span>
            {legacy && (
              <span
                className="shrink-0 px-1.5 py-px rounded-full text-[10px] bg-cc-warning/15 text-cc-warning"
                title="Started before domains: it keeps its own folder-based memory and is not changed by domain settings"
              >
                legacy memory
              </span>
            )}
          </p>
        </div>
        {(step.kind === "idle" || step.kind === "done" || step.kind === "error") && others.length > 0 && (
          <button
            type="button"
            onClick={() => setStep({ kind: "choose", target: others[0].slug })}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer"
          >
            {legacy ? "Migrate to domain" : "Change domain"}
          </button>
        )}
      </div>

      {showForm && (
        <div
          className="mt-2 space-y-1.5 text-[11px]"
          role="group"
          aria-label={legacy ? "Migrate the session into a domain" : "Change the session's domain"}
        >
          <label htmlFor={selectId} className="block text-cc-muted">{legacy ? "Migrate to domain" : "Move to domain"}</label>
          <select
            id={selectId}
            value={formTarget}
            disabled={step.kind !== "choose"}
            onChange={(e) => setStep({ kind: "choose", target: e.target.value })}
            className="w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary"
          >
            {others.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </select>
          {legacy && codex ? (
            <p className="text-cc-muted">
              The CLI restarts on the same thread and folder. Nothing is lost: ~/.codex/AGENTS.md and the project
              AGENTS.md files keep applying. From then on the session also gets the memory, skills, MCP servers and
              instructions of the domain.
            </p>
          ) : legacy ? (
            <p className="text-cc-warning">
              The CLI restarts on the same conversation and folder, but from then on it reads the memory, skills, MCP
              servers and instructions of the domain: its old folder memory is no longer read. Before migrating you can
              choose which of its notes to copy into the domain memory.
            </p>
          ) : (
            <p className="text-cc-warning">
              The CLI restarts on the same conversation and folder, but from then on it reads the memory, skills, MCP servers
              and instructions of the new domain, not of {nameOf(domain)}.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => (legacy && !codex ? reviewMemory(formTarget) : move(formTarget))}
              disabled={step.kind !== "choose"}
              className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {primaryLabel}
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "idle" })}
              disabled={busy}
              className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {step.kind === "review" && (
        <MemoryReview
          domainName={nameOf(step.target)}
          review={step.review}
          loadError={step.loadError}
          onCopy={(files) => move(step.target, files)}
          onSkip={() => move(step.target)}
          onCancel={() => setStep({ kind: "idle" })}
        />
      )}

      {step.kind === "done" && (
        <div role="status" className="mt-1 text-[11px] text-cc-success space-y-0.5">
          {step.noMemory && <p>This session has no folder memory: nothing to copy.</p>}
          {step.copy && <CopyOutcome copy={step.copy} />}
          <p>Moved to {nameOf(step.to)}. The CLI is restarting.</p>
        </div>
      )}
      {step.kind === "error" && <p role="alert" className="mt-1 text-[11px] text-cc-error">{step.message}</p>}
    </section>
  );
}

function CopyOutcome({ copy }: { copy: LegacyMemoryCopyResult }) {
  const n = copy.copied.length;
  return (
    <>
      <p>Copied {n} {n === 1 ? "note" : "notes"} into the domain memory.</p>
      {copy.skipped.map((s) => (
        <p key={s.file} className="text-cc-warning">Skipped {s.file}: {s.reason}</p>
      ))}
    </>
  );
}

/**
 * The review dialog of a legacy Claude session's folder memory: every note
 * with a checkbox (checked by default, except the ones whose file is already
 * in the target domain, shown disabled), its type, description and an
 * expandable preview.
 */
function MemoryReview({
  domainName,
  review,
  loadError,
  onCopy,
  onSkip,
  onCancel,
}: {
  domainName: string;
  review: Review | null;
  loadError?: string;
  onCopy: (files: string[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((review?.notes ?? []).filter((n) => !n.existsInDomain).map((n) => n.file)),
  );
  const baseId = useId();
  const toggle = (file: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(file)) next.delete(file);
    else next.add(file);
    return next;
  });
  const count = selected.size;

  return (
    <Sheet title="Folder memory to keep" onClose={onCancel}>
      <div className="space-y-3 text-xs">
        {review ? (
          <p className="text-cc-muted">
            After the migration the session reads the memory of {domainName}, no longer its folder memory
            in <code className="break-all">{review.dir}</code>. Choose the notes to copy into the domain memory: they are
            copied (the folder is left as it is), and a note already in the domain is never overwritten.
          </p>
        ) : (
          <p role="alert" className="text-cc-error">Could not read the folder memory: {loadError}</p>
        )}
        {review && (
          <fieldset>
            <legend className="sr-only">Notes in the folder memory</legend>
            <ul className="space-y-2">
              {review.notes.map((note, i) => {
                const id = `${baseId}-${i}`;
                return (
                  <li key={note.file} className="rounded-md border border-cc-border px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <input
                        id={id}
                        type="checkbox"
                        className="mt-0.5"
                        checked={selected.has(note.file)}
                        disabled={note.existsInDomain === true}
                        onChange={() => toggle(note.file)}
                      />
                      <div className="min-w-0 flex-1">
                        <label htmlFor={id} className="font-medium text-cc-fg cursor-pointer">{note.name}</label>
                        {note.type && (
                          <span className="ml-1.5 px-1.5 py-px rounded-full text-[10px] bg-cc-hover text-cc-muted">{note.type}</span>
                        )}
                        {note.existsInDomain && (
                          <span className="ml-1.5 text-[10px] text-cc-muted">already in the domain</span>
                        )}
                        {note.description && <p className="text-cc-muted">{note.description}</p>}
                        {note.preview && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-cc-muted">Preview of {note.file}</summary>
                            <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-cc-fg bg-cc-input-bg rounded p-2">{note.preview}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {review && (
            <button
              type="button"
              onClick={() => onCopy(review.notes.filter((n) => selected.has(n.file)).map((n) => n.file))}
              disabled={count === 0}
              className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              Copy {count} {count === 1 ? "note" : "notes"} and migrate
            </button>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="px-2.5 py-1 rounded-md border border-cc-border text-cc-fg hover:bg-cc-hover cursor-pointer"
          >
            Migrate without copying
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}
