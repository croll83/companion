import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { companionBus } from "./event-bus.js";

/**
 * Which sessions delivered a result nobody has looked at yet (the sidebar's
 * green dot, the domain's unread badge). Kept by the server, not the
 * browser, so it survives a reload, covers results that arrived with no
 * browser open (agents, Telegram) and is the same on every device.
 *
 * A session is unread when its last turn ended (a `result`, Claude or Codex)
 * after the last time a browser showed it to the user. The browser reports
 * that (`POST /api/sessions/:id/read`) when the session is on screen and the
 * page visible, including right after a result arrives while it is.
 */

interface Entry {
  resultAt: number;
  readAt?: number;
}

export class SessionUnread {
  private entries: Record<string, Entry> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, Entry>;
      for (const [id, e] of Object.entries(raw ?? {})) {
        if (e && typeof e.resultAt === "number") this.entries[id] = e;
      }
    } catch { /* first run, or a corrupt file: start empty */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.entries)}\n`, "utf-8");
    } catch (err) {
      console.warn("[session-unread] Could not save:", err);
    }
  }

  /** A turn of `sessionId` ended now. */
  noteResult(sessionId: string, at = Date.now()): void {
    this.entries[sessionId] = { ...this.entries[sessionId], resultAt: at };
    this.save();
  }

  /** The user saw `sessionId` now. Returns whether it was unread. */
  markRead(sessionId: string, at = Date.now()): boolean {
    const e = this.entries[sessionId];
    if (!e) return false;
    const was = this.isUnread(sessionId);
    this.entries[sessionId] = { ...e, readAt: at };
    this.save();
    return was;
  }

  isUnread(sessionId: string): boolean {
    const e = this.entries[sessionId];
    return !!e && e.resultAt > (e.readAt ?? 0);
  }

  /** Forget the sessions that no longer exist. */
  prune(existing: ReadonlySet<string>): void {
    const gone = Object.keys(this.entries).filter((id) => !existing.has(id));
    if (gone.length === 0) return;
    for (const id of gone) delete this.entries[id];
    this.save();
  }
}

export const sessionUnread = new SessionUnread(join(COMPANION_HOME, "session-unread.json"));

/** Mark sessions unread when their turns end. Returns the unsubscribe function. */
export function trackSessionResults(unread: SessionUnread = sessionUnread): () => void {
  const onResult = ({ sessionId }: { sessionId: string }) => unread.noteResult(sessionId);
  companionBus.on("message:result", onResult);
  return () => companionBus.off("message:result", onResult);
}
