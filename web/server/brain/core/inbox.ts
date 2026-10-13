// Inbox of notes written by sessions. Append-only: after insert only the
// status fields change (curator API, consolidation API); the text can only be
// erased (tombstone) when a note is discarded or withdrawn. Validation happens
// here, in code, before anything is stored; a rejected note is never stored.
// Store: SQLite (node:sqlite) in BRAIN_DATA_DIR/inbox.db.

import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolvePage, SLUG_RE, type WikiSnapshot } from "./wiki.js";
import { findPersonalData, findSecrets } from "./redact.js";

export const NOTE_KINDS = ["new_fact", "correction", "contradiction", "question", "source_pointer"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_STATUSES = ["pending", "batched", "accepted", "rejected", "deferred", "discarded", "withdrawn"] as const;
/** Statuses whose text is erased (tombstone): not pertinent, or withdrawn by the author. */
export const TOMBSTONE_STATUSES = ["discarded", "withdrawn"] as const;
/** Statuses from which a note can still be decided or withdrawn. */
export const OPEN_STATUSES = ["pending", "batched", "deferred"];
/** Decisions a curator or the consolidation job (API) can record. */
export const DECISIONS = ["accepted", "rejected", "deferred", "discarded"] as const;
export type Decision = (typeof DECISIONS)[number];

export const LIMITS = {
  statementMin: 10,
  statementMax: 2000,
  evidenceMax: 1000,
  pagesMax: 10,
  sourcesMax: 10,
  /** Per author: one Companion session (its `brn_` token), or the single user of a server without tokens. */
  perAuthorPerHour: 120,
};

export const ROLE_USER = "user";

export interface NoteInput {
  kind: NoteKind;
  statement: string;
  pages?: string[];
  new_page_hint?: string;
  sources: string[];
  evidence?: string;
  client_session_id?: string;
  cwd_repo?: string;
  commit?: string;
}

/** Facts the server attests: they never come from the note arguments. */
export interface Attested {
  /** Session id sent by the client in an X-Client-Session-Id header, if any. */
  headerSessionId?: string;
  authorId: string;
  author: string;
  roles: string[];
  mcpSessionId: string;
  clientName: string;
  clientVersion: string;
  wikiCommit: string;
  wikiHash: string;
}

export interface Note extends NoteInput {
  note_id: string;
  status: string;
  received_at: string;
  author_id: string;
  author: string;
  roles: string[];
  mcp_session_id: string;
  client_name: string;
  client_version: string;
  wiki_commit: string;
  wiki_hash: string;
  declared_by_client: string[];
  client_session_header?: string;
  status_reason: string | null;
  status_changed_at: string | null;
  status_by: string | null;
}

export const SOURCE_TYPES = [
  "raw:<path in raw/> (a wiki source)",
  "wiki:<file of the wiki, e.g. index.md or concepts/x.md>",
  "git:<owner/repo>@<commit>[:<path>] (code)",
  "host:<hostname>[:<path or command>] (observed on a live host)",
  "url:<https URL> (documentation, issue, release notes)",
  "person:self (stated by the user)",
];

const SOURCE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "raw", re: /^raw:(raw\/.+)$/ },
  { name: "wiki", re: /^wiki:[^\s][^\n]*\.md$/ },
  { name: "git", re: /^git:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?@[0-9a-f]{7,40}(?::\S+)?$/ },
  { name: "host", re: /^host:[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?::[^\n]{1,300})?$/ },
  { name: "url", re: /^url:https?:\/\/\S{4,500}$/ },
  { name: "person", re: /^person:self$/ },
];

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(nowMs: number): string {
  let t = nowMs;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += ULID_ALPHABET[rnd[i] % 32];
  return time + r;
}

function normalizeSource(s: string): string {
  const t = s.trim();
  if (t.startsWith("raw/")) return `raw:${t}`;
  if (/^https?:\/\//.test(t)) return `url:${t}`;
  return t;
}

export function dedupKey(statement: string, pages: string[]): string {
  const norm = statement.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm + "|" + [...pages].sort().join(",")).digest("hex");
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  normalized?: NoteInput;
}

export interface ValidationOptions {
  allowedEmailDomains?: string[];
  /** Notes per hour from every author together (default: no global cap). */
  maxNotesPerHour?: number;
}

/** Pure validation against the current wiki snapshot. */
export function validateNote(input: NoteInput, wiki: WikiSnapshot, opts: ValidationOptions = {}): ValidationResult {
  const errors: string[] = [];
  if (!(NOTE_KINDS as readonly string[]).includes(input.kind)) errors.push(`kind must be one of: ${NOTE_KINDS.join(", ")}`);
  const statement = (input.statement ?? "").trim();
  if (statement.length < LIMITS.statementMin) errors.push(`statement too short (at least ${LIMITS.statementMin} characters)`);
  if (statement.length > LIMITS.statementMax) errors.push(`statement too long (at most ${LIMITS.statementMax} characters)`);
  const evidence = input.evidence?.trim() || undefined;
  if (evidence && evidence.length > LIMITS.evidenceMax) errors.push(`evidence too long (at most ${LIMITS.evidenceMax} characters)`);

  const pages: string[] = [];
  for (const raw of new Set((input.pages ?? []).map((p) => p.trim()).filter(Boolean))) {
    const p = resolvePage(wiki, raw);
    if (!p) errors.push(`unknown page: ${raw} (use a slug from brain_search or brain_list, or new_page_hint)`);
    else if (!pages.includes(p.slug)) pages.push(p.slug);
  }
  if (pages.length > LIMITS.pagesMax) errors.push(`at most ${LIMITS.pagesMax} pages`);
  const hint = input.new_page_hint?.trim() || undefined;
  if (hint !== undefined) {
    if (!SLUG_RE.test(hint)) errors.push("new_page_hint is not a valid slug (lowercase words separated by hyphens, no spaces or accents)");
    else if (resolvePage(wiki, hint)) errors.push(`new_page_hint: page ${hint} already exists, put it in pages`);
  }
  if (pages.length === 0 && hint === undefined && !(input.pages ?? []).length) errors.push("give at least one page in pages, or new_page_hint");

  const sources = [...new Set((input.sources ?? []).map(normalizeSource).filter(Boolean))];
  if (sources.length === 0) errors.push("give at least one source in sources");
  if (sources.length > LIMITS.sourcesMax) errors.push(`at most ${LIMITS.sourcesMax} sources`);
  for (const s of sources) {
    const pat = SOURCE_PATTERNS.find((p) => p.re.test(s));
    if (!pat) {
      errors.push(`source not accepted: ${s.slice(0, 80)} (types: ${SOURCE_TYPES.join("; ")})`);
      continue;
    }
    if (pat.name === "raw") {
      const path = s.slice("raw:".length);
      if (!wiki.raw.has(path)) errors.push(`raw source not found: ${path}`);
    }
    if (pat.name === "wiki") {
      const path = s.slice("wiki:".length);
      const isPage = [...wiki.pages.values()].some((p) => p.path === path);
      if (!isPage && !wiki.nav.has(path)) errors.push(`wiki file not found: ${path}`);
    }
  }

  const scanned = [statement, evidence ?? "", sources.join(" "), input.cwd_repo ?? "", input.client_session_id ?? ""].join("\n");
  for (const f of findSecrets(scanned)) errors.push(`contains a possible secret (${f.rule}): the note is not stored`);
  for (const f of findPersonalData(scanned, opts.allowedEmailDomains)) errors.push(`contains possible personal data (${f.rule}): the note is not stored`);

  for (const [name, v, max] of [
    ["client_session_id", input.client_session_id, 200],
    ["cwd_repo", input.cwd_repo, 300],
  ] as const) {
    if (v !== undefined && v.length > max) errors.push(`${name} too long`);
  }
  if (input.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(input.commit)) errors.push("commit must be a hexadecimal git SHA");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: {
      kind: input.kind,
      statement,
      pages,
      new_page_hint: hint,
      sources,
      evidence,
      client_session_id: input.client_session_id?.trim() || undefined,
      cwd_repo: input.cwd_repo?.trim() || undefined,
      commit: input.commit,
    },
  };
}

export type AddResult =
  | { ok: true; note_id: string; duplicate: false }
  | { ok: true; note_id: string; duplicate: true }
  | { ok: false; errors: string[] };

export class Inbox {
  private db: DatabaseSync;
  private now: () => Date;
  private opts: ValidationOptions;

  constructor(dataDir: string, now: () => Date = () => new Date(), opts: ValidationOptions = {}) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "inbox.db"));
    this.now = now;
    this.opts = opts;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS note (
        note_id TEXT PRIMARY KEY,
        dedup_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        status_reason TEXT,
        status_changed_at TEXT,
        status_by TEXT,
        received_at TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS note_author ON note(author_id, received_at);
      CREATE INDEX IF NOT EXISTS note_status ON note(status, received_at);
      CREATE INDEX IF NOT EXISTS note_dedup ON note(dedup_key, status);
      CREATE TRIGGER IF NOT EXISTS note_no_delete
        BEFORE DELETE ON note
        BEGIN SELECT RAISE(ABORT, 'notes are never deleted'); END;
      CREATE TRIGGER IF NOT EXISTS note_identity_immutable
        BEFORE UPDATE OF note_id, dedup_key, received_at, author_id, author ON note
        BEGIN SELECT RAISE(ABORT, 'note fields are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS note_body_tombstone_only
        BEFORE UPDATE OF body ON note
        WHEN NOT (NEW.status IN ('discarded', 'withdrawn')
                  AND json_extract(NEW.body, '$.tombstone') = 1
                  AND json_extract(NEW.body, '$.statement') = '')
        BEGIN SELECT RAISE(ABORT, 'note fields are immutable'); END;
      PRAGMA user_version = 1;
    `);
  }

  add(input: NoteInput, att: Attested, wiki: WikiSnapshot): AddResult {
    const v = validateNote(input, wiki, this.opts);
    if (!v.ok || !v.normalized) return { ok: false, errors: v.errors };
    const n = v.normalized;
    const now = this.now();
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const recent = this.db.prepare("SELECT COUNT(*) AS c FROM note WHERE author_id = ? AND received_at > ?").get(att.authorId, hourAgo) as { c: number };
    const limit = LIMITS.perAuthorPerHour;
    if (recent.c >= limit) return { ok: false, errors: [`limit of ${limit} notes per hour reached: try again later`] };
    const cap = this.opts.maxNotesPerHour;
    if (cap !== undefined) {
      const all = this.db.prepare("SELECT COUNT(*) AS c FROM note WHERE received_at > ?").get(hourAgo) as { c: number };
      if (all.c >= cap) return { ok: false, errors: [`the brain received ${cap} notes in the last hour from all sessions: try again later`] };
    }
    const key = dedupKey(n.statement, [...(n.pages ?? []), n.new_page_hint ?? ""]);
    const dup = this.db.prepare("SELECT note_id FROM note WHERE dedup_key = ? AND status IN ('pending','batched','deferred') LIMIT 1").get(key) as { note_id: string } | undefined;
    if (dup) return { ok: true, note_id: dup.note_id, duplicate: true };

    const note_id = ulid(now.getTime());
    const declared = ["client_session_id", "cwd_repo", "commit"].filter((k) => (n as unknown as Record<string, unknown>)[k] !== undefined);
    const headerSid = att.headerSessionId && /^[A-Za-z0-9._:-]{8,100}$/.test(att.headerSessionId) ? att.headerSessionId : undefined;
    const body = {
      ...n,
      client_session_header: headerSid,
      roles: att.roles,
      mcp_session_id: att.mcpSessionId,
      client_name: att.clientName,
      client_version: att.clientVersion,
      wiki_commit: att.wikiCommit,
      wiki_hash: att.wikiHash,
      declared_by_client: declared,
    };
    this.db
      .prepare("INSERT INTO note (note_id, dedup_key, received_at, author_id, author, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(note_id, key, now.toISOString(), att.authorId, att.author, JSON.stringify(body));
    return { ok: true, note_id, duplicate: false };
  }

  listByAuthor(authorId: string, status: string | undefined, limit: number): Note[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM note WHERE author_id = ? AND status = ? ORDER BY received_at DESC LIMIT ?").all(authorId, status, limit)
        : this.db.prepare("SELECT * FROM note WHERE author_id = ? ORDER BY received_at DESC LIMIT ?").all(authorId, limit)
    ) as Record<string, unknown>[];
    return rows.map(rowToNote);
  }

  listByStatus(status: string, limit: number): Note[] {
    const rows = this.db.prepare("SELECT * FROM note WHERE status = ? ORDER BY received_at ASC LIMIT ?").all(status, limit) as Record<string, unknown>[];
    return rows.map(rowToNote);
  }

  get(noteId: string): Note | undefined {
    const r = this.db.prepare("SELECT * FROM note WHERE note_id = ?").get(noteId) as Record<string, unknown> | undefined;
    return r ? rowToNote(r) : undefined;
  }

  /** Move open notes to `batched` for a consolidation run (no-op for notes not open). */
  batch(noteIds: string[], runId: string): void {
    const st = this.db.prepare("UPDATE note SET status = 'batched', status_reason = ?, status_changed_at = ?, status_by = 'consolidation' WHERE note_id = ? AND status IN ('pending','deferred')");
    for (const id of noteIds) st.run(`run ${runId}`, this.now().toISOString(), id);
  }

  /** Give batched notes back to the inbox (run finalized without a decision, or abandoned). */
  release(noteIds: string[], reason: string): void {
    const st = this.db.prepare("UPDATE note SET status = 'pending', status_reason = ?, status_changed_at = ?, status_by = 'consolidation' WHERE note_id = ? AND status = 'batched'");
    for (const id of noteIds) st.run(reason, this.now().toISOString(), id);
  }

  /** Open notes, oldest first: what a new consolidation run takes. */
  listOpenForRun(limit: number): Note[] {
    const rows = this.db.prepare("SELECT * FROM note WHERE status IN ('pending','deferred') ORDER BY received_at ASC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(rowToNote);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS c FROM note GROUP BY status").all() as { status: string; c: number }[]) out[r.status] = r.c;
    return out;
  }

  /** Shared database handle for the consolidation tables. */
  get database(): DatabaseSync {
    return this.db;
  }

  /** The author withdraws an open note: its text is erased, the metadata stays. */
  withdraw(noteId: string, authorId: string, reason: string | undefined): { ok: boolean; error?: string } {
    const n = this.get(noteId);
    if (!n || n.author_id !== authorId) return { ok: false, error: "no such note, or written by another author" };
    if (!OPEN_STATUSES.includes(n.status)) return { ok: false, error: `the note is already ${n.status}: it cannot be withdrawn` };
    this.tombstone(n, "withdrawn", reason?.trim() || "withdrawn by the author", authorId);
    return { ok: true };
  }

  /** A decision on an open note (curator API or consolidation job). */
  decide(noteId: string, decision: Decision, reason: string, by: string): { ok: boolean; error?: string } {
    if (!(DECISIONS as readonly string[]).includes(decision)) return { ok: false, error: `invalid decision: ${decision}` };
    if (!reason.trim()) return { ok: false, error: "a reason is required" };
    const n = this.get(noteId);
    if (!n) return { ok: false, error: "no such note" };
    if (!OPEN_STATUSES.includes(n.status)) return { ok: false, error: `the note is already ${n.status}` };
    if (decision === "discarded") {
      this.tombstone(n, "discarded", reason.trim(), by);
    } else {
      this.db
        .prepare("UPDATE note SET status = ?, status_reason = ?, status_changed_at = ?, status_by = ? WHERE note_id = ?")
        .run(decision, reason.trim(), this.now().toISOString(), by, noteId);
    }
    return { ok: true };
  }

  private tombstone(n: Note, status: "discarded" | "withdrawn", reason: string, by: string): void {
    const body = {
      kind: n.kind,
      pages: n.pages,
      new_page_hint: n.new_page_hint,
      statement: "",
      sources: [],
      tombstone: 1,
      erased_at: this.now().toISOString(),
      roles: n.roles,
      mcp_session_id: n.mcp_session_id,
      client_name: n.client_name,
      client_version: n.client_version,
      wiki_commit: n.wiki_commit,
      wiki_hash: n.wiki_hash,
      declared_by_client: [],
    };
    this.db
      .prepare("UPDATE note SET status = ?, status_reason = ?, status_changed_at = ?, status_by = ?, body = ? WHERE note_id = ?")
      .run(status, reason, this.now().toISOString(), by, JSON.stringify(body), n.note_id);
  }

  close(): void {
    this.db.close();
  }
}

function rowToNote(r: Record<string, unknown>): Note {
  const body = JSON.parse(r.body as string);
  return {
    ...body,
    note_id: r.note_id,
    status: r.status,
    status_reason: r.status_reason ?? null,
    status_changed_at: r.status_changed_at ?? null,
    status_by: r.status_by ?? null,
    received_at: r.received_at,
    author_id: r.author_id,
    author: r.author,
  } as Note;
}
