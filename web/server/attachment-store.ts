/**
 * Disk store for chat attachments a backend cannot take inline.
 *
 * Codex's `turn/start` only accepts text / image / localImage / audio /
 * localAudio / skill / mention — there is no file variant, so a PDF cannot be
 * embedded in a turn the way Claude allows. Instead we persist the bytes and
 * hand the model an absolute path to read.
 *
 * Files land OUTSIDE any repository (under COMPANION_HOME) so an upload never
 * dirties the session's working tree or shows up in `git status`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

/** Media types Codex accepts as an inline `image` input item. */
export const INLINE_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

/** Where a session's uploaded attachments live. */
export function uploadsDir(sessionId: string): string {
  return join(COMPANION_HOME, "uploads", sessionId);
}

/**
 * Filesystem-safe name. `basename` drops any directory component, the
 * whitelist strips separators and shell metacharacters, and leading dots are
 * removed so "..", "../x" or ".bashrc" can never escape or hide.
 */
export function safeAttachmentName(name: string | undefined, mediaType: string): string {
  let base = basename(name || "")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!base || base === "." || base === "..") {
    const ext = mediaType === "application/pdf" ? ".pdf" : (extname(name || "") || ".bin");
    base = `attachment-${Date.now()}${ext.replace(/[^\w.]/g, "")}`;
  }
  return base.slice(0, 120);
}

export interface SavedAttachment { path: string; name: string; bytes: number; mediaType: string }

/** Persist one base64 attachment and return where it landed. */
export function saveAttachment(
  sessionId: string,
  attachment: { data: string; media_type: string; name?: string },
): SavedAttachment {
  const dir = uploadsDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const name = safeAttachmentName(attachment.name, attachment.media_type);
  const buf = Buffer.from(attachment.data, "base64");
  // Prefix with a timestamp so re-uploading the same filename never clobbers.
  const stamped = `${Date.now()}-${name}`;
  const path = join(dir, stamped);
  writeFileSync(path, buf);
  return { path, name, bytes: buf.length, mediaType: attachment.media_type };
}

/** The note appended to the user's turn so the model knows where to look. */
export function attachmentNote(saved: SavedAttachment[]): string {
  if (saved.length === 0) return "";
  const lines = saved.map(
    (s) => `- \`${s.path}\` (${s.name}${s.mediaType ? `, ${s.mediaType}` : ""}, ${s.bytes} byte)`,
  );
  const plural = saved.length > 1 ? "i" : "o";
  return `\n\n[File allegat${plural} salvat${plural} su disco, leggil${plural} da lì:]\n${lines.join("\n")}`;
}
