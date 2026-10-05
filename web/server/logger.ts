// Lightweight structured logger for the Companion server.
// Provides JSON-structured log output for operational events while
// keeping the familiar console.log interface for human-readable logs.
//
// Log file persistence:
//   By default, all log output is also written to ~/.companion/logs/ with
//   automatic rotation (oldest companion_<ISO>_<pid>.log files deleted when
//   their total lines exceed 2M). Disable with COMPANION_LOG_FILE=0, override
//   dir with COMPANION_LOG_DIR, and configure rotation with
//   COMPANION_LOG_MAX_LINES. The service's stdout/stderr files in that dir
//   (companion.log / companion.error.log) are never deleted; past
//   COMPANION_LOG_STDIO_MAX_MB (default 100, 0 = off) they are copy-truncated
//   into <name>.1. That bound runs as part of this writer's cleanup, so it only
//   applies while the log-file writer is on (COMPANION_LOG_FILE not 0) and its
//   dir is the one systemd writes to.
//
// Usage:
//   import { log } from "./logger.js";
//   log.info("ws-bridge", "Browser connected", { sessionId, browsers: 3 });
//   log.warn("orchestrator", "Git fetch failed", { sessionId, error: "..." });
//   log.error("cli-launcher", "Process crashed", { sessionId, exitCode: 1 });

import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  fstatSync,
  unlinkSync,
  copyFileSync,
  appendFileSync,
  truncateSync,
  constants as fsConstants,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { countFileLines } from "./fs-utils.js";

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  [key: string]: unknown;
}

const STRUCTURED = process.env.COMPANION_LOG_FORMAT === "json";

function formatEntry(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): string {
  if (STRUCTURED) {
    const entry: LogEntry = {
      ...data,
      ts: new Date().toISOString(),
      level,
      module,
      msg,
    };
    return JSON.stringify(entry);
  }

  // Human-readable format (default): [module] msg key=value key=value
  let line = `[${module}] ${msg}`;
  if (data) {
    const pairs = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    if (pairs) line += ` | ${pairs}`;
  }
  return line;
}

// ─── Log File Writer ────────────────────────────────────────────────────────

const DEFAULT_LOG_MAX_LINES = 2_000_000;
const DEFAULT_STDIO_MAX_MB = 100;
const LOG_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Names of the files this writer creates: `companion_<ISO with - for :>_<pid>.log`.
 * Line-count rotation only ever deletes files matching this. Anything else in
 * the directory — notably `companion.log` / `companion.error.log`, which are
 * systemd's `StandardOutput=append:` / `StandardError=append:` targets — is not
 * ours to delete: unlinking them leaves the running service writing into an
 * orphaned inode, so every later console line and crash trace vanishes from
 * disk until the next restart.
 */
const OWN_LOG_FILE_RE = /^companion_\d{4}-\d{2}-\d{2}T[0-9.-]+Z?_\d+\.log$/;

/** A regular file this process holds open as stdout/stderr. */
interface StdioFileTarget {
  dev: number;
  ino: number;
  /** Opened with O_APPEND; null when that can't be determined (no /proc). */
  append: boolean | null;
}

/**
 * Identify which of `fds` are regular files and whether they were opened in
 * append mode. Linux exposes the open flags in /proc/self/fdinfo/<fd>; Node has
 * no fcntl(F_GETFL), so elsewhere `append` is null and callers must treat the
 * file as not safely truncatable.
 */
export function inspectStdioFiles(fds: readonly number[]): StdioFileTarget[] {
  const out: StdioFileTarget[] = [];
  for (const fd of fds) {
    let st;
    try {
      st = fstatSync(fd);
    } catch {
      continue; // fd closed
    }
    if (!st.isFile()) continue; // tty, pipe, socket (journal): nothing on disk to protect
    let append: boolean | null = null;
    try {
      const m = /^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf-8"));
      if (m) append = (parseInt(m[1], 8) & fsConstants.O_APPEND) !== 0;
    } catch {
      // not Linux, or /proc unavailable
    }
    out.push({ dev: st.dev, ino: st.ino, append });
  }
  return out;
}

/**
 * Copy-truncate rotation: copy `path` to `keepPath` (overwriting it), then
 * truncate `path` in place to 0 bytes. The inode never changes, so a writer
 * holding it with O_APPEND keeps writing to the same, now empty, file. Rename
 * or unlink rotation can't work here: the writer would never follow.
 *
 * Bytes appended while the copy runs are chased into `keepPath` before the
 * truncate. Only the instant between the last size check and the truncate is
 * unprotected (same as logrotate's copytruncate). If the copy fails (e.g.
 * ENOSPC) the original is left untouched: never truncate without a full copy.
 */
export function copyTruncate(path: string, keepPath: string): boolean {
  try {
    copyFileSync(path, keepPath);
    let copied = statSync(keepPath).size;
    for (let i = 0; i < 5; i++) {
      const size = statSync(path).size;
      if (size <= copied) break;
      const buf = Buffer.alloc(size - copied);
      const rfd = openSync(path, "r");
      let n: number;
      try {
        n = readSync(rfd, buf, 0, buf.length, copied);
      } finally {
        closeSync(rfd);
      }
      appendFileSync(keepPath, buf.subarray(0, n));
      copied += n;
    }
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

/** COMPANION_LOG_STDIO_MAX_MB in bytes; 0 or negative disables, garbage means default. */
function resolveStdioMaxBytes(): number {
  const raw = process.env.COMPANION_LOG_STDIO_MAX_MB;
  const mb = raw === undefined || raw.trim() === "" ? DEFAULT_STDIO_MAX_MB : Number(raw);
  if (!Number.isFinite(mb)) return DEFAULT_STDIO_MAX_MB * 1024 * 1024;
  return mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
}

/**
 * Writes log lines to a file under ~/.companion/logs/ with automatic rotation.
 * A new log file is created each time the server starts. When total lines across
 * this writer's own files (companion_<ISO>_<pid>.log) exceed maxLines (default
 * 2M), the oldest of them are deleted.
 *
 * The service's own stdout/stderr files (systemd `append:` targets such as
 * companion.log / companion.error.log) are never deleted. If one of them lives
 * in the logs dir, is open with O_APPEND and grows past stdioMaxBytes (default
 * 100 MB, COMPANION_LOG_STDIO_MAX_MB, 0 disables), it is copy-truncated into
 * `<name>.1` instead, so the running process keeps writing to the same file.
 *
 * Follows the same pattern as RecorderManager for recordings.
 */
export class LogFileWriter {
  readonly filePath: string;
  private logsDir: string;
  private maxLines: number;
  private stdioMaxBytes: number;
  private stdioFds: readonly number[];
  private fd: number;
  private closed = false;
  private dirCreated = false;
  private initialCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: {
    logsDir?: string;
    maxLines?: number;
    /** Size bound for stdout/stderr append targets in logsDir; 0 disables. */
    stdioMaxBytes?: number;
    /** Which fds count as "our stdio" (tests inject their own). Default [1, 2]. */
    stdioFds?: readonly number[];
  }) {
    this.logsDir = options?.logsDir ?? LogFileWriter.resolveDir();
    this.maxLines =
      options?.maxLines ??
      (Number(process.env.COMPANION_LOG_MAX_LINES) || DEFAULT_LOG_MAX_LINES);
    this.stdioMaxBytes = options?.stdioMaxBytes ?? resolveStdioMaxBytes();
    this.stdioFds = options?.stdioFds ?? [1, 2];

    this.ensureDir();

    // Create a new log file for this server run and keep the fd open
    const ts = new Date().toISOString().replace(/:/g, "-");
    const pid = process.pid;
    this.filePath = join(this.logsDir, `companion_${ts}_${pid}.log`);
    this.fd = openSync(this.filePath, "a");

    // Defer initial cleanup so it doesn't block the event loop at startup
    this.initialCleanupTimer = setTimeout(() => {
      this.initialCleanupTimer = null;
      this.cleanup();
    }, 2000);
    if (this.initialCleanupTimer.unref) this.initialCleanupTimer.unref();
    this.cleanupTimer = setInterval(() => this.cleanup(), LOG_CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private static resolveDir(): string {
    return process.env.COMPANION_LOG_DIR ?? join(COMPANION_HOME, "logs");
  }

  /** Whether log file writing is enabled. Disable with COMPANION_LOG_FILE=0|false. */
  static isEnabled(): boolean {
    const env = process.env.COMPANION_LOG_FILE;
    if (env === "0" || env === "false") return false;
    return true;
  }

  getLogsDir(): string {
    return this.logsDir;
  }

  getMaxLines(): number {
    return this.maxLines;
  }

  write(line: string): void {
    if (this.closed) return;
    try {
      writeSync(this.fd, line + "\n");
    } catch {
      // Never throw — logging must not disrupt normal operation
    }
  }

  /**
   * Bound the stdio append targets (copy-truncate), then delete the oldest of
   * this writer's own log files until their total lines are under maxLines.
   * Never deletes the current log file (still being written to), anything not
   * named like our own files, or anything this process holds as stdout/stderr.
   * Returns the number of files deleted.
   */
  cleanup(): number {
    try {
      this.ensureDir();
      const names = readdirSync(this.logsDir);
      const stdio = inspectStdioFiles(this.stdioFds);
      this.rotateStdioFiles(names, stdio);
      return this.deleteOldOwnFiles(names, stdio);
    } catch {
      return 0;
    }
  }

  private rotateStdioFiles(names: string[], stdio: StdioFileTarget[]): void {
    if (this.stdioMaxBytes <= 0) return;
    // Only files we provably append to: truncating under a non-O_APPEND writer
    // would make it keep writing at its old offset (a sparse file of zeros).
    const appendTargets = stdio.filter((t) => t.append === true);
    if (appendTargets.length === 0) return;
    // Iterating directory names (not fds) visits a file shared by stdout and
    // stderr once; a second name for the same inode re-stats at size 0 after
    // the first truncate and is skipped by the size check.
    for (const name of names) {
      const fullPath = join(this.logsDir, name);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size <= this.stdioMaxBytes) continue;
      if (!appendTargets.some((t) => t.dev === st.dev && t.ino === st.ino)) continue;
      if (copyTruncate(fullPath, `${fullPath}.1`)) {
        // Lands at the top of the freshly truncated stdout file: a marker for readers.
        console.log(`[logger] Rotated ${name} (${st.size} bytes) to ${name}.1 (copy-truncate)`);
      }
    }
  }

  private deleteOldOwnFiles(names: string[], stdio: StdioFileTarget[]): number {
    const entries: { path: string; lines: number; mtimeMs: number }[] = [];
    let totalLines = 0;

    for (const filename of names) {
      if (!OWN_LOG_FILE_RE.test(filename)) continue;
      const fullPath = join(this.logsDir, filename);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      // Belt and braces: never unlink a file we hold open as stdout/stderr,
      // even if it happens to carry our naming pattern.
      if (stdio.some((t) => t.dev === st.dev && t.ino === st.ino)) continue;
      const lines = countFileLines(fullPath);
      entries.push({ path: fullPath, lines, mtimeMs: st.mtimeMs });
      totalLines += lines;
    }

    if (totalLines <= this.maxLines) return 0;

    // Sort oldest first
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let deleted = 0;
    for (const entry of entries) {
      if (totalLines <= this.maxLines) break;
      // Don't delete the current log file
      if (entry.path === this.filePath) continue;
      try {
        unlinkSync(entry.path);
        totalLines -= entry.lines;
        deleted++;
      } catch {
        // File may have been removed concurrently
      }
    }

    if (deleted > 0) {
      // Log to console only (avoid recursion)
      console.log(`[logger] Cleanup: deleted ${deleted} old log file(s), ${totalLines} lines remaining`);
    }
    return deleted;
  }

  close(): void {
    this.closed = true;
    if (this.initialCleanupTimer) {
      clearTimeout(this.initialCleanupTimer);
      this.initialCleanupTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    try { closeSync(this.fd); } catch { /* ignore */ }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    mkdirSync(this.logsDir, { recursive: true });
    this.dirCreated = true;
  }
}

// ─── Singleton file writer (initialized lazily) ─────────────────────────────

let fileWriter: LogFileWriter | null = null;

/**
 * Initialize the log file writer. Call once at server startup.
 * Returns the writer instance for status reporting, or null if disabled.
 */
export function initLogFile(options?: { logsDir?: string; maxLines?: number }): LogFileWriter | null {
  if (!LogFileWriter.isEnabled()) return null;
  if (fileWriter) {
    fileWriter.close();
  }
  fileWriter = new LogFileWriter(options);
  return fileWriter;
}

/** Shut down the log file writer (clears cleanup timer). */
export function closeLogFile(): void {
  if (fileWriter) {
    fileWriter.close();
    fileWriter = null;
  }
}

// ─── Public logger ──────────────────────────────────────────────────────────

export const log = {
  info(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("info", module, msg, data);
    console.log(line);
    fileWriter?.write(line);
  },

  warn(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("warn", module, msg, data);
    console.warn(line);
    fileWriter?.write(line);
  },

  error(module: string, msg: string, data?: Record<string, unknown>): void {
    const line = formatEntry("error", module, msg, data);
    console.error(line);
    fileWriter?.write(line);
  },
};
