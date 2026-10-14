import { useCallback, useEffect, useId, useState } from "react";
import { api, type BrainNote, type BrainNoteStatus } from "../api.js";
import { FIELD } from "./BrainForm.js";
import { BrainAddSource } from "./BrainAddSource.js";

const BUTTON = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";

/** The filters of the tab, by note status ("discarded" is what Dismiss does). */
const FILTERS: { status: BrainNoteStatus; label: string }[] = [
  { status: "pending", label: "Waiting" },
  { status: "accepted", label: "Accepted" },
  { status: "rejected", label: "Rejected" },
  { status: "discarded", label: "Dismissed" },
];

const KIND_TEXT: Record<string, string> = {
  new_fact: "New fact",
  correction: "Correction",
  contradiction: "Contradiction",
  question: "Question",
  source_pointer: "Source",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** One note: what it says, what kind, who wrote it and when, its sources; Dismiss for a waiting note. */
function NoteItem({ note, busy, onDismiss }: { note: BrainNote; busy: boolean; onDismiss?: (reason: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const target = note.pages?.length ? note.pages.join(", ") : note.new_page_hint ? `new page ${note.new_page_hint}` : "";
  return (
    <li className="p-2 rounded-md border border-cc-border space-y-1">
      <p className="text-[11px] text-cc-muted">
        <span className="font-semibold text-cc-fg">{KIND_TEXT[note.kind] ?? note.kind}</span>
        {` · ${note.author} · ${when(note.received_at)}`}
        {target ? ` · ${target}` : ""}
      </p>
      {note.statement ? (
        <p className="text-[12px] whitespace-pre-wrap break-words">{note.statement}</p>
      ) : (
        <p className="text-[12px] text-cc-muted italic">Text erased.</p>
      )}
      {note.sources && note.sources.length > 0 && (
        <p className="text-[11px] text-cc-muted break-all">Sources: {note.sources.join(", ")}</p>
      )}
      {note.status !== "pending" && note.status_reason && (
        <p className="text-[11px] text-cc-muted">
          {note.status === "discarded" ? "Dismissed" : note.status[0].toUpperCase() + note.status.slice(1)}
          {note.status_by ? ` by ${note.status_by}` : ""}{note.status_changed_at ? ` on ${when(note.status_changed_at)}` : ""}: {note.status_reason}
        </p>
      )}
      {onDismiss && (asking ? (
        <form
          aria-label="Dismiss note"
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onDismiss(reason.trim()).then((ok) => { if (ok) setAsking(false); });
          }}
        >
          <label htmlFor={reasonId} className="text-[11px] text-cc-muted">Reason (optional)</label>
          <input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} className={`${FIELD} max-w-xs`} />
          <button type="submit" disabled={busy} className={BUTTON}>Dismiss note</button>
          <button type="button" onClick={() => setAsking(false)} className="text-[12px] text-cc-muted hover:underline cursor-pointer">Cancel</button>
        </form>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className={BUTTON}>Dismiss…</button>
      ))}
    </li>
  );
}

/**
 * The Inbox tab of an embedded brain: the notes sessions recorded (and the
 * sources added here), by status. A waiting note can be dismissed, with an
 * optional reason: its text is erased, the record stays. "Add source" gives
 * the brain something new to read. The consolidation (its own tab) turns
 * the waiting notes into pages.
 */
export function BrainInbox({ slug, onChanged }: { slug: string; onChanged?: () => void }) {
  const [status, setStatus] = useState<BrainNoteStatus>("pending");
  const [notes, setNotes] = useState<BrainNote[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (s: BrainNoteStatus) => {
    setBusy(true);
    setError("");
    try {
      const r = await api.brainInbox(slug, s);
      setNotes(r.notes);
      setCounts(r.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [slug]);

  useEffect(() => { void load(status); }, [load, status]);

  const dismiss = async (id: string, reason: string): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await api.dismissBrainNote(slug, id, reason || undefined);
      onChanged?.();
      await load(status);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return false;
    }
  };

  return (
    <section aria-label="Inbox" className="space-y-2">
      <p className="text-[11px] text-cc-muted">
        Notes recorded by sessions (new facts, corrections, sources). They never change the wiki by themselves: a consolidation reviews them first.
      </p>
      {adding ? (
        <BrainAddSource slug={slug} onCancel={() => setAdding(false)} onAdded={() => { onChanged?.(); if (status === "pending") void load(status); else setStatus("pending"); }} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={BUTTON}>Add source…</button>
      )}
      <div role="group" aria-label="Show notes" className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.status}
            type="button"
            aria-pressed={status === f.status}
            onClick={() => setStatus(f.status)}
            className={`px-2 py-0.5 rounded-md border text-[12px] cursor-pointer ${status === f.status ? "border-cc-primary bg-cc-active" : "border-cc-border hover:bg-cc-hover"}`}
          >
            {f.label}{counts[f.status] ? ` (${counts[f.status]})` : ""}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
      {!notes && busy && <p className="text-[12px] text-cc-muted">Loading notes…</p>}
      {notes && (notes.length === 0 ? (
        <p className="text-[12px] text-cc-muted">{status === "pending" ? "No notes waiting." : "No notes here."}</p>
      ) : (
        <ul className="space-y-1.5">
          {notes.map((n) => (
            <NoteItem key={n.note_id} note={n} busy={busy} onDismiss={n.status === "pending" ? (reason) => dismiss(n.note_id, reason) : undefined} />
          ))}
        </ul>
      ))}
    </section>
  );
}
