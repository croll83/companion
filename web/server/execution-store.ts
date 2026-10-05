// ─── Execution Store ────────────────────────────────────────────────────────
// Persists AgentExecution records to disk as JSONL (one file per day).
// Used by the Runs view to display execution history across server restarts.

import { mkdirSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecution } from "./agent-types.js";
import { COMPANION_HOME, legacyStatePath } from "./paths.js";

const EXECUTIONS_DIR = join(COMPANION_HOME, "executions");
// Versions before COMPANION_HOME was honoured here always wrote to
// ~/.companion/executions; their history is still read from there.
const LEGACY_EXECUTIONS_DIR = legacyStatePath("executions");

export interface ExecutionQuery {
  agentId?: string;
  triggerType?: string;
  status?: "running" | "success" | "error";
  limit?: number;
  offset?: number;
}

export interface ExecutionListResult {
  executions: AgentExecution[];
  total: number;
}

export class ExecutionStore {
  private dir: string;
  /** Read-only older location whose history is merged in on load. */
  private legacyDir: string | null;
  /** In-memory cache of recent executions for fast access */
  private recentCache: AgentExecution[] = [];
  /**
   * Runs known only from `legacyDir`. They may belong to ANOTHER instance
   * still writing there (e.g. the live service, seen from a test instance
   * with its own COMPANION_HOME): shown in the history, never acted on —
   * not closed as interrupted, not updated, their temp folders not removed.
   */
  private foreign = new Set<string>();
  private static readonly MAX_CACHE_SIZE = 200;

  /**
   * @param dir storage directory (default COMPANION_HOME/executions)
   * @param legacyDir extra directory to read history from; defaults to the
   *   pre-COMPANION_HOME location only when `dir` is the default one.
   */
  constructor(dir?: string, legacyDir?: string | null) {
    this.dir = dir || EXECUTIONS_DIR;
    this.legacyDir = legacyDir !== undefined ? legacyDir : dir ? null : LEGACY_EXECUTIONS_DIR;
    mkdirSync(this.dir, { recursive: true });
    this.loadRecentIntoCache();
  }

  /**
   * Close every run still marked running. Called once at startup: a server
   * restart kills every CLI, so those runs can never report a result.
   * Returns how many runs were closed.
   */
  finalizeInterrupted(reason: string): number {
    let closed = 0;
    for (const exec of this.recentCache) {
      if (exec.completedAt || this.foreign.has(exec.sessionId)) continue;
      this.update(exec.sessionId, { completedAt: Date.now(), success: false, error: reason });
      closed++;
    }
    return closed;
  }

  /** Every cached execution (most recent first), without pagination. */
  all(): AgentExecution[] {
    return [...this.recentCache];
  }

  /** The cached executions this store owns (written to its own dir), most recent first. */
  own(): AgentExecution[] {
    return this.recentCache.filter((e) => !this.foreign.has(e.sessionId));
  }

  /** Append an execution record to the daily JSONL file and in-memory cache. */
  append(execution: AgentExecution): void {
    const filename = this.dailyFilename(execution.startedAt);
    const filepath = join(this.dir, filename);

    try {
      appendFileSync(filepath, JSON.stringify(execution) + "\n", "utf-8");
    } catch (err) {
      console.error("[execution-store] Failed to append execution:", err);
    }

    // Update cache
    this.recentCache.unshift(execution);
    if (this.recentCache.length > ExecutionStore.MAX_CACHE_SIZE) {
      this.recentCache.length = ExecutionStore.MAX_CACHE_SIZE;
    }
  }

  /** Update an existing execution in the cache and persist to disk. */
  update(sessionId: string, updates: Partial<AgentExecution>): void {
    const idx = this.recentCache.findIndex((e) => e.sessionId === sessionId);
    if (idx < 0) {
      console.warn(`[execution-store] update() called for unknown sessionId: ${sessionId} (not in cache)`);
      return;
    }
    if (this.foreign.has(sessionId)) return; // read-only history of another location
    Object.assign(this.recentCache[idx], updates);
    // Re-append the updated record to disk for durability.
    // On next load, dedup by sessionId keeps the latest entry.
    const updated = this.recentCache[idx];
    const filename = this.dailyFilename(updated.startedAt);
    const filepath = join(this.dir, filename);
    try {
      appendFileSync(filepath, JSON.stringify(updated) + "\n", "utf-8");
    } catch (err) {
      console.error("[execution-store] Failed to persist update:", err);
    }
  }

  /** Query executions with pagination and filtering. */
  list(opts?: ExecutionQuery): ExecutionListResult {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    let filtered = this.getAllExecutions();

    if (opts?.agentId) {
      filtered = filtered.filter((e) => e.agentId === opts.agentId);
    }
    if (opts?.triggerType) {
      filtered = filtered.filter((e) => e.triggerType === opts.triggerType);
    }
    if (opts?.status) {
      filtered = filtered.filter((e) => {
        if (opts.status === "running") return !e.completedAt;
        if (opts.status === "success") return e.success === true;
        if (opts.status === "error") return e.error !== undefined || (!!e.completedAt && e.success === false);
        return true;
      });
    }

    // Sort by startedAt descending (most recent first)
    filtered.sort((a, b) => b.startedAt - a.startedAt);

    const total = filtered.length;
    const executions = filtered.slice(offset, offset + limit);

    return { executions, total };
  }

  /** Get all executions from cache + disk. */
  private getAllExecutions(): AgentExecution[] {
    // For now, use the in-memory cache which is loaded from disk on startup.
    // This is fast and sufficient for the Runs view.
    return [...this.recentCache];
  }

  /** Load recent executions from disk into cache on startup. */
  private loadRecentIntoCache(): void {
    try {
      // Same-named daily files from both locations: the current one is read
      // first for each day, so its (newer) lines win the dedup below.
      const files = [
        ...this.listDailyFiles(this.dir),
        ...(this.legacyDir ? this.listDailyFiles(this.legacyDir) : []),
      ].sort((a, b) => b.name.localeCompare(a.name) || a.rank - b.rank); // Most recent day first

      const allLoaded: Array<{ exec: AgentExecution; legacy: boolean }> = [];
      const ownIds = new Set<string>();

      for (const { path: filepath, rank } of files) {
        if (allLoaded.length >= ExecutionStore.MAX_CACHE_SIZE * 2) break;

        const content = readFileSync(filepath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        // Parse lines in reverse (most recent last in file = most up-to-date)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const execution = JSON.parse(lines[i]) as AgentExecution;
            allLoaded.push({ exec: execution, legacy: rank !== 0 });
            if (rank === 0) ownIds.add(execution.sessionId);
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Dedup by sessionId: since we read most-recent-last first, the first
      // occurrence of a sessionId is the most up-to-date version.
      const seen = new Set<string>();
      for (const { exec, legacy } of allLoaded) {
        if (seen.has(exec.sessionId)) continue;
        seen.add(exec.sessionId);
        // Foreign only if this store never wrote a line for the run.
        if (legacy && !ownIds.has(exec.sessionId)) this.foreign.add(exec.sessionId);
        this.recentCache.push(exec);
        if (this.recentCache.length >= ExecutionStore.MAX_CACHE_SIZE) break;
      }
    } catch (err) {
      // Log errors that aren't simply "directory not found" (ENOENT)
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code !== "ENOENT") {
        console.error("[execution-store] Failed to load executions from disk:", err);
      }
    }
  }

  /** Daily JSONL files in `dir` (none if it does not exist). */
  private listDailyFiles(dir: string): { name: string; path: string; rank: number }[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const rank = dir === this.dir ? 0 : 1;
    return names
      .filter((f) => f.startsWith("executions-") && f.endsWith(".jsonl"))
      .map((name) => ({ name, path: join(dir, name), rank }));
  }

  /** Generate a daily JSONL filename from a timestamp. */
  private dailyFilename(timestamp: number): string {
    const date = new Date(timestamp);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `executions-${yyyy}-${mm}-${dd}.jsonl`;
  }

  get directory(): string {
    return this.dir;
  }
}
