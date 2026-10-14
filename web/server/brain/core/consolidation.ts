// Consolidation of the inbox, driven over HTTP by a curator job (a nightly
// Companion agent, or a person by hand). The job brings the judgement and edits
// the wiki itself; this module brings what must be deterministic: which notes
// a run takes, how they are grouped by page, the record of every decision,
// and a log.md entry describing the run. The brain never writes the wiki.
//
// Flow: start a run (open notes become `batched`) → read items/notes → for
// each note record a decision (accepted | rejected | deferred | discarded) →
// finalize (undecided notes go back to `pending`) or abandon (all go back).

import type { DatabaseSync } from "node:sqlite";
import { resolvePage, type WikiSnapshot } from "./wiki.js";
import { DECISIONS, type Decision, type Inbox, type Note } from "./inbox.js";

const RUN_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;
const MAX_NOTES_PER_RUN = 200;

export interface RunNote {
  note_id: string;
  kind: string;
  statement: string;
  pages: string[];
  new_page_hint?: string;
  sources: string[];
  evidence?: string;
  author: string;
  received_at: string;
  cwd_repo?: string;
  commit?: string;
  status: string;
  decision: string | null;
  decision_reason: string | null;
}

export interface RunItem {
  item_id: string;
  /** Page slug, or the proposed slug of a new page. */
  target: string;
  target_path: string | null;
  is_new_page: boolean;
  notes: RunNote[];
}

export interface RunView {
  run_id: string;
  status: "open" | "finalized" | "abandoned";
  created_at: string;
  finalized_at: string | null;
  wiki_commit: string;
  counts: Record<string, number>;
  items: RunItem[];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Consolidation {
  private db: DatabaseSync;
  private inbox: Inbox;
  private now: () => Date;

  constructor(inbox: Inbox, now: () => Date = () => new Date()) {
    this.inbox = inbox;
    this.db = inbox.database;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cons_run (
        run_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL,
        wiki_commit TEXT NOT NULL, finalized_at TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS cons_note (
        run_id TEXT NOT NULL, note_id TEXT NOT NULL, item_id TEXT NOT NULL, target TEXT NOT NULL, is_new INTEGER NOT NULL,
        decision TEXT, decision_reason TEXT, decided_at TEXT, decided_by TEXT,
        PRIMARY KEY (run_id, note_id));
    `);
  }

  /**
   * The default run_id: today's date, or the date's own run while it is still
   * open (resumed), else the first free `<date>-2`, `<date>-3`... A second run
   * on the same day must not get back the day's finalized run.
   */
  private freeRunId(): string {
    const day = this.now().toISOString().slice(0, 10);
    const status = (id: string) => (this.db.prepare("SELECT status FROM cons_run WHERE run_id = ?").get(id) as { status: string } | undefined)?.status;
    for (let n = 1; ; n++) {
      const id = n === 1 ? day : `${day}-${n}`;
      const s = status(id);
      if (s === undefined || s === "open") return id;
    }
  }

  /** Start a run, or return it if it already exists (idempotent on an explicit run_id; default run_id: freeRunId). */
  start(runIdIn: string | undefined, wiki: WikiSnapshot): RunView {
    const runId = runIdIn?.trim() || this.freeRunId();
    if (!RUN_ID_RE.test(runId)) throw new HttpError(400, "invalid run_id (3-64 characters: letters, digits, . _ -)");
    if (this.db.prepare("SELECT run_id FROM cons_run WHERE run_id = ?").get(runId)) return this.view(runId, wiki);
    const open = this.db.prepare("SELECT run_id FROM cons_run WHERE status = 'open'").get() as { run_id: string } | undefined;
    if (open) throw new HttpError(409, `run ${open.run_id} is still open: finalize or abandon it first`);
    const notes = this.inbox.listOpenForRun(MAX_NOTES_PER_RUN);
    this.db.prepare("INSERT INTO cons_run (run_id, status, created_at, wiki_commit) VALUES (?, 'open', ?, ?)").run(runId, this.now().toISOString(), wiki.commit);
    const add = this.db.prepare("INSERT INTO cons_note (run_id, note_id, item_id, target, is_new) VALUES (?, ?, ?, ?, ?)");
    const taken: string[] = [];
    for (const n of notes) {
      // One target per note: the first page that still exists, else the proposed new slug, else the first page named.
      const existing = (n.pages ?? []).map((p) => resolvePage(wiki, p)).find(Boolean);
      const target = existing?.slug ?? n.new_page_hint ?? (n.pages ?? [])[0] ?? "(no-page)";
      const isNew = !existing;
      add.run(runId, n.note_id, `${isNew ? "new" : "page"}:${target}`, target, isNew ? 1 : 0);
      taken.push(n.note_id);
    }
    this.inbox.batch(taken, runId);
    return this.view(runId, wiki);
  }

  private run(runId: string): Record<string, any> {
    const run = this.db.prepare("SELECT * FROM cons_run WHERE run_id = ?").get(runId) as Record<string, any> | undefined;
    if (!run) throw new HttpError(404, `no run ${runId}`);
    return run;
  }

  private requireOpen(runId: string): void {
    const run = this.run(runId);
    if (run.status !== "open") throw new HttpError(409, `run ${runId} is ${run.status}`);
  }

  private runNotes(runId: string): (RunNote & { item_id: string; target: string; is_new: boolean })[] {
    const rows = this.db.prepare("SELECT * FROM cons_note WHERE run_id = ? ORDER BY item_id, note_id").all(runId) as Record<string, any>[];
    const out: (RunNote & { item_id: string; target: string; is_new: boolean })[] = [];
    for (const r of rows) {
      const n = this.inbox.get(r.note_id);
      if (!n) continue;
      out.push({ ...toRunNote(n, r.decision ?? null, r.decision_reason ?? null), item_id: r.item_id, target: r.target, is_new: r.is_new === 1 });
    }
    return out;
  }

  view(runId: string, wiki: WikiSnapshot): RunView {
    const run = this.run(runId);
    const items = new Map<string, RunItem>();
    const counts: Record<string, number> = { notes: 0, undecided: 0 };
    for (const n of this.runNotes(runId)) {
      const { item_id, target, is_new, ...note } = n;
      let it = items.get(item_id);
      if (!it) {
        const page = is_new ? undefined : resolvePage(wiki, target);
        it = { item_id, target, target_path: page?.path ?? null, is_new_page: !page, notes: [] };
        items.set(item_id, it);
      }
      it.notes.push(note);
      counts.notes++;
      if (note.decision) counts[note.decision] = (counts[note.decision] ?? 0) + 1;
      else counts.undecided++;
    }
    return {
      run_id: run.run_id,
      status: run.status,
      created_at: run.created_at,
      finalized_at: run.finalized_at ?? null,
      wiki_commit: run.wiki_commit,
      counts,
      items: [...items.values()],
    };
  }

  /** Flat rows for a for-each over the notes of a run; decision "none" = still undecided. */
  notes(runId: string, wiki: WikiSnapshot, decision?: string) {
    this.run(runId);
    return this.runNotes(runId)
      .filter((n) => (decision === undefined ? true : decision === "none" ? n.decision === null : n.decision === decision))
      .map(({ is_new, ...n }) => {
        const page = is_new ? undefined : resolvePage(wiki, n.target);
        return { ...n, is_new_page: !page, target_path: page?.path ?? null, target_title: page?.title ?? `(new page proposed: ${n.target})` };
      });
  }

  /**
   * Record the decision on one note of an open run. The inbox status changes
   * at once (discarded erases the text). A deferred note can be decided again
   * in the same run; the other decisions are final.
   */
  decide(runId: string, noteId: string, decision: string, reason: string, by: string): { note_id: string; status: string } {
    this.requireOpen(runId);
    if (!(DECISIONS as readonly string[]).includes(decision)) throw new HttpError(400, `invalid decision: ${decision} (${DECISIONS.join(", ")})`);
    const r = reason.trim();
    if (!r) throw new HttpError(400, "a reason is required (for accepted: where the fact went, e.g. the page updated)");
    const row = this.db.prepare("SELECT note_id FROM cons_note WHERE run_id = ? AND note_id = ?").get(runId, noteId);
    if (!row) throw new HttpError(404, `note ${noteId} is not part of run ${runId}`);
    const res = this.inbox.decide(noteId, decision as Decision, r, by);
    if (!res.ok) throw new HttpError(409, res.error ?? "decision not recorded");
    this.db
      .prepare("UPDATE cons_note SET decision = ?, decision_reason = ?, decided_at = ?, decided_by = ? WHERE run_id = ? AND note_id = ?")
      .run(decision, r, this.now().toISOString(), by, runId, noteId);
    return { note_id: noteId, status: this.inbox.get(noteId)!.status };
  }

  /** Close the run: undecided notes go back to pending. Returns the summary and a log.md entry. */
  finalize(runId: string, wiki: WikiSnapshot, summary?: string): { run: RunView; released: string[]; log_entry: string } {
    this.requireOpen(runId);
    const notes = this.runNotes(runId);
    const released = notes.filter((n) => n.decision === null).map((n) => n.note_id);
    this.inbox.release(released, `not decided in run ${runId}`);
    this.db.prepare("UPDATE cons_run SET status = 'finalized', finalized_at = ?, reason = ? WHERE run_id = ?").run(this.now().toISOString(), summary?.trim() || null, runId);
    const run = this.view(runId, wiki);
    return { run, released, log_entry: logEntry(run, this.now(), summary) };
  }

  /** Give every note of the run back to the inbox (decisions already recorded stay). */
  abandon(runId: string, reason: string): { released: string[] } {
    this.requireOpen(runId);
    if (!reason.trim()) throw new HttpError(400, "a reason is required");
    const ids = this.runNotes(runId)
      .filter((n) => n.decision === null)
      .map((n) => n.note_id);
    this.inbox.release(ids, `run ${runId} abandoned: ${reason.trim()}`);
    this.db.prepare("UPDATE cons_run SET status = 'abandoned', finalized_at = ?, reason = ? WHERE run_id = ?").run(this.now().toISOString(), reason.trim(), runId);
    return { released: ids };
  }

  list(limit = 20): { run_id: string; status: string; created_at: string; finalized_at: string | null }[] {
    return this.db.prepare("SELECT run_id, status, created_at, finalized_at FROM cons_run ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
  }
}

function toRunNote(n: Note, decision: string | null, reason: string | null): RunNote {
  return {
    note_id: n.note_id,
    kind: n.kind,
    statement: n.statement,
    pages: n.pages ?? [],
    new_page_hint: n.new_page_hint,
    sources: n.sources ?? [],
    evidence: n.evidence,
    author: n.author,
    received_at: n.received_at,
    cwd_repo: n.cwd_repo,
    commit: n.commit,
    status: n.status,
    decision,
    decision_reason: reason,
  };
}

/** A log.md entry in the wiki's format ("## [YYYY-MM-DD HH:MM] action" + bullets), for the job to append. */
export function logEntry(run: RunView, now: Date, summary?: string): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const decided = run.items.flatMap((i) => i.notes.filter((n) => n.decision === "accepted").map(() => i));
  const touched = [...new Set(decided.filter((i) => !i.is_new_page).map((i) => i.target_path ?? i.target))];
  const created = [...new Set(decided.filter((i) => i.is_new_page).map((i) => i.target))];
  const c = (k: string) => run.counts[k] ?? 0;
  return [
    `## [${stamp}] consolidate`,
    `- Pages touched: ${touched.length ? touched.join(", ") : "none"}${created.length ? `; new pages proposed: ${created.join(", ")}` : ""}`,
    `- Notes: brain inbox run ${run.run_id}: ${c("accepted")} accepted, ${c("rejected")} rejected, ${c("deferred")} deferred, ${c("discarded")} discarded, ${c("undecided")} left for the next run.`,
    ...(summary?.trim() ? [`- Summary: ${summary.trim().replace(/\s+/g, " ")}`] : []),
  ].join("\n");
}
