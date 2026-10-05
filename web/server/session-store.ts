import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  SessionState,
  BrowserIncomingMessage,
  PermissionRequest,
  BufferedBrowserEvent,
} from "./session-types.js";

// ─── Serializable session shape ─────────────────────────────────────────────

export interface PersistedSession {
  id: string;
  state: SessionState;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  pendingPermissions: [string, PermissionRequest][];
  eventBuffer?: BufferedBrowserEvent[];
  nextEventSeq?: number;
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  archived?: boolean;
}

// ─── Store ──────────────────────────────────────────────────────────────────

const DEFAULT_DIR = join(tmpdir(), "vibe-sessions");

export class SessionStore {
  private dir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dir?: string) {
    this.dir = dir || DEFAULT_DIR;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  /** Debounced write — batches rapid changes (e.g. multiple stream events). */
  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.saveSync(session);
    }, 150);
    this.debounceTimers.set(session.id, timer);
  }

  /** Immediate write — use for critical state changes. */
  saveSync(session: PersistedSession): void {
    try {
      writeFileSync(this.filePath(session.id), JSON.stringify(session), "utf-8");
    } catch (err) {
      console.error(`[session-store] Failed to save session ${session.id}:`, err);
    }
  }

  /** Load a single session from disk. */
  load(sessionId: string): PersistedSession | null {
    try {
      const raw = readFileSync(this.filePath(sessionId), "utf-8");
      return JSON.parse(raw) as PersistedSession;
    } catch {
      return null;
    }
  }

  /** Load all sessions from disk. */
  loadAll(): PersistedSession[] {
    const sessions: PersistedSession[] = [];
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".json") && f !== "launcher.json");
      for (const file of files) {
        try {
          const raw = readFileSync(join(this.dir, file), "utf-8");
          sessions.push(JSON.parse(raw));
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  /** Set the archived flag on a persisted session. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    this.saveSync(session);
    return true;
  }

  /** Remove a session file from disk. */
  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    try {
      unlinkSync(this.filePath(sessionId));
    } catch {
      // File may not exist
    }
  }

  /** Persist launcher state (separate file). */
  saveLauncher(data: unknown): void {
    try {
      writeFileSync(join(this.dir, "launcher.json"), JSON.stringify(data), "utf-8");
    } catch (err) {
      console.error("[session-store] Failed to save launcher state:", err);
    }
  }

  /** Load launcher state. */
  loadLauncher<T>(): T | null {
    try {
      const raw = readFileSync(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private requestEnvPath(sessionId: string): string {
    // Session ids are server-generated UUIDs; refuse anything path-like anyway.
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) throw new Error("Invalid session id");
    return join(this.dir, "request-env", `${sessionId}.json`);
  }

  /**
   * Persist the env passed with a session's create request (or agent config)
   * so a relaunch after a server restart still applies it. Values can be
   * secrets: the directory is 0700 and each file 0600, and they live outside
   * launcher.json, which only keeps references (env slug, connection id).
   * An empty env removes the file.
   */
  saveRequestEnv(sessionId: string, env: Record<string, string> | undefined): void {
    try {
      const path = this.requestEnvPath(sessionId);
      if (!env || Object.keys(env).length === 0) {
        this.removeRequestEnv(sessionId);
        return;
      }
      const dir = join(this.dir, "request-env");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      writeFileSync(path, JSON.stringify(env), { encoding: "utf-8", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (err) {
      console.error(`[session-store] Failed to save request env for ${sessionId}:`, err);
    }
  }

  /** Load the env persisted by saveRequestEnv, or undefined. */
  loadRequestEnv(sessionId: string): Record<string, string> | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.requestEnvPath(sessionId), "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") env[k] = v;
      }
      return env;
    } catch {
      return undefined;
    }
  }

  /** Delete the env persisted by saveRequestEnv (no-op when absent). */
  removeRequestEnv(sessionId: string): void {
    try {
      unlinkSync(this.requestEnvPath(sessionId));
    } catch {
      // File may not exist
    }
  }

  /** Cancel all pending debounce timers (for clean test teardown). */
  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  get directory(): string {
    return this.dir;
  }
}
