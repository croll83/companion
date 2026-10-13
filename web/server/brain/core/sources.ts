// "Add source" (curator API, POST /api/v1/sources): a text the user pasted or
// uploaded in Companion becomes a file of the wiki's raw/ folder, and a
// `source_pointer` note in the inbox tells the consolidation to turn it into
// pages. An URL becomes only a note: the brain never downloads anything.
//
// The file is written by the brain (the process that owns the wiki folder for
// Companion), under raw/sources/<YYYY-MM-DD>-<safe-name>.md:
//  - the name is reduced to lowercase letters, digits and hyphens, so no path
//    can be smuggled in, and the folder must resolve inside the wiki;
//  - an existing file is never overwritten: the name gets -2, -3, ...;
//  - the file is not committed: raw/ is the consolidation's input, and the
//    consolidation (or the user) commits it with the pages it produces.
// When the note is rejected (for example personal data in the note text),
// the file just written is removed again, so a failed request leaves nothing.

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { HttpError } from "./consolidation.js";
import { resolvePage } from "./wiki.js";
import { ROLE_USER, type NoteInput } from "./inbox.js";
import type { Brain } from "./brain.js";

/** Largest source accepted (UTF-8 bytes). */
export const MAX_SOURCE_BYTES = 1_000_000;
const MAX_NAME = 60;
const MAX_NOTE = 600;

/** "Q3 Report (final).md" → "q3-report-final"; "" when nothing usable is left. */
export function safeSourceName(name: string): string {
  return name
    .replace(/\.(md|markdown|txt|text)$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
}

/** A slug for new_page_hint from a source name or an URL ("https://x.org/a/b-c" → "b-c"). */
export function hintFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return safeSourceName(decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, "")) || safeSourceName(u.hostname);
  } catch {
    return "";
  }
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Write `text` as a new file of raw/sources/; returns its wiki path (raw/sources/...). Never overwrites. */
export function writeSourceFile(wikiDir: string, name: string, text: string, now: Date): string {
  const root = realpathSync(wikiDir);
  const dir = join(root, "raw", "sources");
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (!real.startsWith(root + sep)) throw new HttpError(400, "raw/sources is outside the wiki folder");
  const base = `${today(now)}-${safeSourceName(name) || "source"}`;
  for (let i = 1; i < 1000; i++) {
    const file = `${base}${i === 1 ? "" : `-${i}`}.md`;
    try {
      writeFileSync(join(real, file), text.endsWith("\n") ? text : `${text}\n`, { flag: "wx" });
      return `raw/sources/${file}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new HttpError(409, "too many sources with this name today");
}

function optionalText(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${name} is longer than ${max} characters`);
  return t || undefined;
}

export interface AddSourceResult {
  /** The new raw file (text sources only). */
  path?: string;
  note_id: string;
  duplicate: boolean;
}

/**
 * POST /api/v1/sources: body {name, text, note?} (a text source) or
 * {url, title?, note?} (an URL, recorded as a note only). `by` names who
 * added it (default "Companion").
 */
export function addSource(brain: Brain, body: Record<string, unknown>, now = new Date()): AddSourceResult {
  const note = optionalText(body.note, "note", MAX_NOTE);
  const by = optionalText(body.by, "by", 64) ?? "Companion";
  let path: string | undefined;
  let input: NoteInput;
  if (body.url !== undefined) {
    const url = optionalText(body.url, "url", 500);
    if (!url || !/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, "url must be an http:// or https:// address");
    const title = optionalText(body.title, "title", 200);
    input = {
      kind: "source_pointer",
      statement: `Source to read and turn into wiki pages: ${url}${note ? `. ${note}` : ""}`,
      sources: [`url:${url}`],
      ...target(brain, safeSourceName(title ?? "") || hintFromUrl(url)),
    };
  } else {
    const name = optionalText(body.name, "name", 200);
    if (!name) throw new HttpError(400, "name is required");
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
    const text = body.text.replace(/\r\n?/g, "\n");
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) throw new HttpError(413, `the source is larger than ${MAX_SOURCE_BYTES / 1_000_000} MB`);
    if (text.includes("\u0000")) throw new HttpError(400, "the source is not text (markdown or plain text only)");
    path = writeSourceFile(brain.cfg.wikiDir, name, text, now);
    brain.refresh(true);
    input = {
      kind: "source_pointer",
      statement: `New source added from Companion: ${path}. Read it and turn it into wiki pages${note ? `. ${note}` : "."}`,
      sources: [`raw:${path}`],
      ...target(brain, safeSourceName(name)),
    };
  }
  const w = brain.wiki();
  const r = brain.inbox.add(input, {
    authorId: `curator:${by}`,
    author: by,
    roles: [ROLE_USER],
    mcpSessionId: "api",
    clientName: "companion",
    clientVersion: "api",
    wikiCommit: w.commit,
    wikiHash: w.contentHash,
  }, w);
  if (!r.ok) {
    if (path) {
      rmSync(join(realpathSync(brain.cfg.wikiDir), path), { force: true });
      brain.refresh(true);
    }
    throw new HttpError(400, `the note was rejected: ${r.errors.join("; ")}`);
  }
  brain.audit.log({ event: "source_added", detail: path ?? "url", ids: [r.note_id] });
  return { ...(path ? { path } : {}), note_id: r.note_id, duplicate: r.duplicate };
}

/** The page a source is about: an existing page with that slug, else a hint for a new one. */
function target(brain: Brain, slug: string): Pick<NoteInput, "pages" | "new_page_hint"> {
  const s = slug || "new-source";
  return resolvePage(brain.wiki(), s) ? { pages: [s] } : { new_page_hint: s };
}
