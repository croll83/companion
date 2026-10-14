import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { parseFrontmatter } from "./claude-config.js";

/**
 * The folder memory of a legacy Claude session, for the guided migration into
 * a domain (session panel → "Migrate to domain").
 *
 * A legacy Claude session reads its auto-memory folder (one `.md` per note
 * with YAML frontmatter `name`, `description`, `metadata.type`, plus a
 * `MEMORY.md` index). Once migrated it reads the domain memory instead, so the
 * notes worth keeping are copied there first. Copying never moves, deletes or
 * overwrites anything: the source folder is left as it is, and a note whose
 * file name already exists in the domain memory is skipped.
 */

export const MEMORY_INDEX = "MEMORY.md";
const PREVIEW_CHARS = 300;

export interface MemoryNote {
  /** File name in the memory folder, e.g. `deploy-notes.md`. */
  file: string;
  /** Frontmatter `name`, else the file name without `.md`. */
  name: string;
  description: string;
  /** Frontmatter `metadata.type` (or a top-level `type`), "" when absent. */
  type: string;
  /** The start of the note body (after the frontmatter). */
  preview: string;
  /** Only when a target domain was given: a file with this name is already in its memory. */
  existsInDomain?: boolean;
}

export interface CopyNotesResult {
  copied: string[];
  skipped: { file: string; reason: string }[];
}

/** A note file name we accept: a plain `.md` name, no path, not hidden, not the index. */
export function isNoteFileName(file: unknown): file is string {
  return typeof file === "string"
    && file.endsWith(".md")
    && file !== MEMORY_INDEX
    && !file.startsWith(".")
    && basename(file) === file
    && !/[\\/\0]/.test(file);
}

/**
 * Whether `path` is a regular file inside `dir` once symlinks are resolved:
 * a note may be a symlink to another file of the folder, never to a file
 * outside it.
 */
function isFileInside(path: string, dir: string): boolean {
  try {
    const realDir = realpathSync(dir);
    const real = realpathSync(path);
    if (!real.startsWith(realDir + sep)) return false;
    return lstatSync(real).isFile();
  } catch {
    return false;
  }
}

/** The note files of a memory folder (sorted), [] when the folder is missing. */
function noteFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => isNoteFileName(f) && isFileInside(join(dir, f), dir))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Split a note into its frontmatter fields and body. Malformed frontmatter falls back to the file name. */
export function parseNote(file: string, content: string): Omit<MemoryNote, "existsInDomain"> {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const fields = fm ? parseFrontmatter(content) : {};
  const typeMatch = fm?.[1].match(/^\s*type:\s*(.+)$/m);
  const body = (fm ? content.slice(fm[0].length) : content).trim();
  const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  return {
    file,
    name: oneLine(fields.name) || file.replace(/\.md$/, ""),
    description: oneLine(fields.description),
    type: typeMatch ? typeMatch[1].trim().replace(/^["']|["']$/g, "") : "",
    preview: body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS).trimEnd()}…` : body,
  };
}

/**
 * The notes of memory folder `dir`. With `domainMemory`, each note says
 * whether its file name is already taken there (it would not be copied).
 */
export function listMemoryNotes(dir: string, domainMemory?: string): MemoryNote[] {
  return noteFiles(dir).map((file) => {
    let content = "";
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch {
      // Unreadable: listed by name only.
    }
    const note: MemoryNote = parseNote(file, content);
    if (domainMemory !== undefined) note.existsInDomain = existsSync(join(domainMemory, file));
    return note;
  });
}

/**
 * Check a copy request against the source folder: every name must be a plain
 * note file present there. Returns the first problem, or null.
 */
export function invalidNoteFiles(dir: string, files: unknown): string | null {
  if (!Array.isArray(files) || files.length === 0) return "files must be a non-empty list of note file names";
  const present = new Set(noteFiles(dir));
  for (const file of files) {
    if (!isNoteFileName(file)) return `Invalid note file name: ${String(file)}`;
    if (!present.has(file)) return `Not a note of this session's folder memory: ${file}`;
  }
  return null;
}

/** The MEMORY.md line of a note: `- [Title](file.md) — description`. */
export function indexLine(note: Pick<MemoryNote, "file" | "name" | "description">): string {
  const title = note.name.replace(/[[\]]/g, "");
  return `- [${title}](${note.file})${note.description ? ` — ${note.description}` : ""}`;
}

/**
 * Copy `files` (already validated with invalidNoteFiles) from memory folder
 * `src` into `dest`, creating `dest` and its index when missing, and append
 * one index line per copied note. Existing files in `dest` are never
 * overwritten: they are reported in `skipped`.
 */
export function copyMemoryNotes(src: string, dest: string, files: string[]): CopyNotesResult {
  mkdirSync(dest, { recursive: true });
  const indexPath = join(dest, MEMORY_INDEX);
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "";
  const result: CopyNotesResult = { copied: [], skipped: [] };
  const lines: string[] = [];
  for (const file of [...new Set(files)]) {
    const content = readFileSync(join(src, file), "utf-8");
    try {
      // "wx": an existing file (or one created in the meantime) is never overwritten.
      writeFileSync(join(dest, file), content, { flag: "wx" });
    } catch (err) {
      const exists = (err as NodeJS.ErrnoException).code === "EEXIST";
      result.skipped.push({
        file,
        reason: exists ? "A note with this file name is already in the domain memory" : String((err as Error).message ?? err),
      });
      continue;
    }
    result.copied.push(file);
    if (!index.includes(`](${file})`)) lines.push(indexLine(parseNote(file, content)));
  }
  const sepLine = index === "" || index.endsWith("\n") ? "" : "\n";
  appendFileSync(indexPath, lines.length > 0 ? `${sepLine}${lines.join("\n")}\n` : "");
  return result;
}
