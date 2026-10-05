import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync,
  openSync, closeSync, writeSync, statSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("logger", () => {
  let log: typeof import("./logger.js").log;
  const originalEnv = process.env.COMPANION_LOG_FORMAT;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMPANION_LOG_FORMAT;
    } else {
      process.env.COMPANION_LOG_FORMAT = originalEnv;
    }
  });

  describe("human-readable format (default)", () => {
    beforeEach(async () => {
      delete process.env.COMPANION_LOG_FORMAT;
      const mod = await import("./logger.js");
      log = mod.log;
    });

    it("formats info messages with bracket prefix", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("ws-bridge", "Browser connected", { sessionId: "abc-123", browsers: 3 });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[ws-bridge]");
      expect(output).toContain("Browser connected");
      expect(output).toContain("sessionId=abc-123");
      expect(output).toContain("browsers=3");
      spy.mockRestore();
    });

    it("formats warn messages", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      log.warn("orchestrator", "Relaunch limit reached", { sessionId: "s1" });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[orchestrator]");
      expect(output).toContain("Relaunch limit reached");
      spy.mockRestore();
    });

    it("formats error messages", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      log.error("cli-launcher", "Process crashed", { exitCode: 1 });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toContain("[cli-launcher]");
      expect(output).toContain("exitCode=1");
      spy.mockRestore();
    });

    it("handles messages without data", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("server", "Started");
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      expect(output).toBe("[server] Started");
      spy.mockRestore();
    });
  });

  describe("JSON format (COMPANION_LOG_FORMAT=json)", () => {
    beforeEach(async () => {
      process.env.COMPANION_LOG_FORMAT = "json";
      const mod = await import("./logger.js");
      log = mod.log;
    });

    it("outputs valid JSON with required fields", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("ws-bridge", "CLI connected", { sessionId: "s1" });
      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("ws-bridge");
      expect(parsed.msg).toBe("CLI connected");
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.ts).toBeDefined();
      spy.mockRestore();
    });

    it("core metadata fields cannot be overwritten by caller data", () => {
      // Caller-supplied keys with names matching core fields should not
      // overwrite ts, level, module, or msg.
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      log.info("real-module", "real message", {
        level: "error" as any,
        module: "evil",
        msg: "overwritten",
        ts: "tampered",
      });
      expect(spy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(spy.mock.calls[0][0] as string);
      expect(parsed.level).toBe("info");
      expect(parsed.module).toBe("real-module");
      expect(parsed.msg).toBe("real message");
      expect(parsed.ts).not.toBe("tampered");
      spy.mockRestore();
    });
  });
});

describe("LogFileWriter", () => {
  let LogFileWriter: typeof import("./logger.js").LogFileWriter;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    // Create a unique temp directory for each test to avoid cross-contamination
    tmpDir = join(tmpdir(), `companion-log-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    const mod = await import("./logger.js");
    LogFileWriter = mod.LogFileWriter;
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates a log file in the specified directory", () => {
    // Verify that constructing a LogFileWriter creates a .log file
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
      expect(files).toHaveLength(1);
      expect(writer.filePath).toContain(tmpDir);
      expect(writer.filePath).toMatch(/\.log$/);
    } finally {
      writer.close();
    }
  });

  it("writes log lines to the file", () => {
    // Write multiple lines and verify they appear in the file
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      writer.write("[server] Line one");
      writer.write("[server] Line two");
      writer.write("[server] Line three");

      const content = readFileSync(writer.filePath, "utf-8");
      const lines = content.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("[server] Line one");
      expect(lines[1]).toBe("[server] Line two");
      expect(lines[2]).toBe("[server] Line three");
    } finally {
      writer.close();
    }
  });

  it("includes PID in the filename for uniqueness across server runs", () => {
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000 });
    try {
      // Filename format: companion_{iso-timestamp}_{pid}.log
      const filename = writer.filePath.split("/").pop()!;
      expect(filename).toContain(`_${process.pid}.log`);
      expect(filename).toMatch(/^companion_/);
    } finally {
      writer.close();
    }
  });

  it("exposes logsDir and maxLines for status reporting", () => {
    const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 42 });
    try {
      expect(writer.getLogsDir()).toBe(tmpDir);
      expect(writer.getMaxLines()).toBe(42);
    } finally {
      writer.close();
    }
  });

  describe("rotation", () => {
    it("deletes oldest log files when total lines exceed maxLines", () => {
      // Pre-create two old log files with known line counts and distinct mtimes
      // so rotation deletes the oldest first.
      const oldFile1 = join(tmpDir, "companion_2020-01-01T00-00-00_1.log");
      const oldFile2 = join(tmpDir, "companion_2020-06-01T00-00-00_2.log");
      writeFileSync(oldFile1, "line1\nline2\nline3\nline4\nline5\n");
      writeFileSync(oldFile2, "line1\nline2\nline3\nline4\nline5\n");

      // Set explicit mtimes: oldFile1 is oldest, oldFile2 is newer
      const past1 = new Date("2020-01-01");
      const past2 = new Date("2020-06-01");
      utimesSync(oldFile1, past1, past1);
      utimesSync(oldFile2, past2, past2);

      // maxLines = 8: total is 5 + 5 = 10 lines > 8, so oldest file (oldFile1)
      // gets deleted bringing total to 5 which is <= 8.
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 8 });
      try {
        // Initial cleanup is deferred — run it explicitly for the test
        writer.cleanup();
        const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
        // oldFile1 should have been deleted by cleanup, oldFile2 and current remain
        expect(files).toHaveLength(2);
        // The oldest file should be gone
        expect(files.some((f) => f.includes("2020-01-01"))).toBe(false);
        // The newer old file should still exist
        expect(files.some((f) => f.includes("2020-06-01"))).toBe(true);
      } finally {
        writer.close();
      }
    });

    it("does not delete the current log file during cleanup", () => {
      // Pre-create one old file that puts us over the limit, with an old mtime
      const oldFile = join(tmpDir, "companion_2020-01-01T00-00-00_1.log");
      writeFileSync(oldFile, "line1\nline2\nline3\n");
      utimesSync(oldFile, new Date("2020-01-01"), new Date("2020-01-01"));

      // maxLines = 2 means we're over limit but the current file must survive
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 2 });
      try {
        writer.write("current line 1");
        writer.write("current line 2");
        writer.write("current line 3");

        // Force another cleanup pass
        const deleted = writer.cleanup();
        expect(deleted).toBeGreaterThanOrEqual(0);

        // Current file must still exist and be writable
        writer.write("still works");
        const content = readFileSync(writer.filePath, "utf-8");
        expect(content).toContain("still works");
      } finally {
        writer.close();
      }
    });

    it("returns the number of files deleted during cleanup", () => {
      // Create 3 old files with 5 lines each = 15 lines total, with distinct mtimes
      for (let i = 0; i < 3; i++) {
        const f = join(tmpDir, `companion_2020-0${i + 1}-01T00-00-00_${i}.log`);
        writeFileSync(f, "a\nb\nc\nd\ne\n");
        const past = new Date(`2020-0${i + 1}-01`);
        utimesSync(f, past, past);
      }

      // maxLines = 5 means we need to delete at least 2 old files
      const writer = new LogFileWriter({ logsDir: tmpDir, maxLines: 5 });
      try {
        // Initial cleanup is deferred — run it explicitly for the test
        writer.cleanup();
        const files = readdirSync(tmpDir).filter((f) => f.endsWith(".log"));
        // At most the newest old file + current file should remain
        expect(files.length).toBeLessThanOrEqual(2);
      } finally {
        writer.close();
      }
    });
  });

  describe("isEnabled", () => {
    const origLogFile = process.env.COMPANION_LOG_FILE;

    afterEach(() => {
      if (origLogFile === undefined) {
        delete process.env.COMPANION_LOG_FILE;
      } else {
        process.env.COMPANION_LOG_FILE = origLogFile;
      }
    });

    it("returns true by default (no env var set)", async () => {
      delete process.env.COMPANION_LOG_FILE;
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(true);
    });

    it("returns false when COMPANION_LOG_FILE=0", async () => {
      process.env.COMPANION_LOG_FILE = "0";
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(false);
    });

    it("returns false when COMPANION_LOG_FILE=false", async () => {
      process.env.COMPANION_LOG_FILE = "false";
      vi.resetModules();
      const mod = await import("./logger.js");
      expect(mod.LogFileWriter.isEnabled()).toBe(false);
    });
  });
});

describe("initLogFile / closeLogFile", () => {
  let initLogFile: typeof import("./logger.js").initLogFile;
  let closeLogFile: typeof import("./logger.js").closeLogFile;
  let log: typeof import("./logger.js").log;
  let tmpDir: string;

  const origLogFile = process.env.COMPANION_LOG_FILE;
  const origLogFormat = process.env.COMPANION_LOG_FORMAT;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), `companion-log-init-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    delete process.env.COMPANION_LOG_FILE;
    delete process.env.COMPANION_LOG_FORMAT;
    const mod = await import("./logger.js");
    initLogFile = mod.initLogFile;
    closeLogFile = mod.closeLogFile;
    log = mod.log;
  });

  afterEach(() => {
    closeLogFile();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (origLogFile === undefined) {
      delete process.env.COMPANION_LOG_FILE;
    } else {
      process.env.COMPANION_LOG_FILE = origLogFile;
    }
    if (origLogFormat === undefined) {
      delete process.env.COMPANION_LOG_FORMAT;
    } else {
      process.env.COMPANION_LOG_FORMAT = origLogFormat;
    }
  });

  it("tees log output to file after initialization", () => {
    // Initialize the log file writer, then verify that log.info writes to both
    // console and the log file
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writer = initLogFile({ logsDir: tmpDir });
    expect(writer).not.toBeNull();

    log.info("test-module", "Hello world");

    // Console should have been called
    expect(consoleSpy).toHaveBeenCalledOnce();

    // File should contain the same line
    const content = readFileSync(writer!.filePath, "utf-8");
    expect(content).toContain("[test-module] Hello world");

    consoleSpy.mockRestore();
  });

  it("returns null when disabled via env var", async () => {
    process.env.COMPANION_LOG_FILE = "0";
    vi.resetModules();
    const mod = await import("./logger.js");
    const writer = mod.initLogFile({ logsDir: tmpDir });
    expect(writer).toBeNull();
  });

  it("stops writing to file after closeLogFile()", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writer = initLogFile({ logsDir: tmpDir });
    expect(writer).not.toBeNull();

    log.info("mod", "before close");
    closeLogFile();
    log.info("mod", "after close");

    // Console gets both calls
    expect(consoleSpy).toHaveBeenCalledTimes(2);

    // File should only have the first line (closeLogFile nulls out the writer
    // so subsequent writes are no-ops to the file)
    const content = readFileSync(writer!.filePath, "utf-8");
    expect(content).toContain("before close");
    expect(content).not.toContain("after close");

    consoleSpy.mockRestore();
  });
});

// ─── Live stdio files: never deleted, copy-truncated instead ───────────────────
//
// companion.log / companion.error.log are systemd's StandardOutput/StandardError
// `append:` targets. The old cleanup counted every *.log in the dir and could
// unlink them, leaving the running service writing into an orphaned inode (all
// later console output invisible on disk). These tests pin the new contract:
// line-count rotation only touches the writer's own companion_<ISO>_<pid>.log
// files, and the stdio files are bounded by copy-truncate, which keeps the inode.

describe("log cleanup vs. live stdio files", () => {
  let mod: typeof import("./logger.js");
  let tmpDir: string;
  const openFds: number[] = [];
  const origStdioMax = process.env.COMPANION_LOG_STDIO_MAX_MB;

  /** Open a file the way systemd's `append:` does (O_WRONLY|O_CREAT|O_APPEND). */
  function openAppend(path: string): number {
    const fd = openSync(path, "a");
    openFds.push(fd);
    return fd;
  }

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = join(tmpdir(), `companion-log-stdio-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
    delete process.env.COMPANION_LOG_STDIO_MAX_MB;
    mod = await import("./logger.js");
  });

  afterEach(() => {
    for (const fd of openFds.splice(0)) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    vi.doUnmock("node:fs");
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
    if (origStdioMax === undefined) delete process.env.COMPANION_LOG_STDIO_MAX_MB;
    else process.env.COMPANION_LOG_STDIO_MAX_MB = origStdioMax;
  });

  describe("own-file selection", () => {
    it("deletes only companion_<ISO>_<pid>.log files, never companion.log / companion.error.log", () => {
      // The exact production failure: the stdio files dwarf everything else, so
      // they used to be counted and deleted first. Now they are invisible to
      // line-count rotation, and only the old own-pattern file goes.
      const stdout = join(tmpDir, "companion.log");
      const stderr = join(tmpDir, "companion.error.log");
      const other = join(tmpDir, "something-else.log");
      const own = join(tmpDir, "companion_2020-01-01T00-00-00.000Z_123.log");
      for (const f of [stdout, stderr, other]) writeFileSync(f, "x\n".repeat(50));
      writeFileSync(own, "a\nb\nc\nd\ne\n");
      const old = new Date("2019-01-01");
      for (const f of [stdout, stderr, other, own]) utimesSync(f, old, old);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const writer = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 2, stdioFds: [] });
      try {
        expect(writer.cleanup()).toBe(1);
        expect(existsSync(own)).toBe(false);
        expect(existsSync(stdout)).toBe(true);
        expect(existsSync(stderr)).toBe(true);
        expect(existsSync(other)).toBe(true);
        expect(existsSync(writer.filePath)).toBe(true);
      } finally {
        writer.close();
      }
    });

    it("does not count foreign files toward maxLines", () => {
      // 150 foreign lines + 5 own lines with maxLines=10: only own lines count,
      // so nothing is over the limit and nothing is deleted.
      writeFileSync(join(tmpDir, "companion.log"), "x\n".repeat(150));
      const own = join(tmpDir, "companion_2020-01-01T00-00-00_1.log");
      writeFileSync(own, "a\nb\nc\nd\ne\n");
      const writer = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 10, stdioFds: [] });
      try {
        expect(writer.cleanup()).toBe(0);
        expect(existsSync(own)).toBe(true);
      } finally {
        writer.close();
      }
    });

    it("never unlinks a file held open as stdout/stderr, even if it is named like an own file", () => {
      // Defense in depth for odd service configs: the inode match against our
      // own stdio fds vetoes deletion regardless of the filename.
      const disguised = join(tmpDir, "companion_2020-01-01T00-00-00_7.log");
      writeFileSync(disguised, "a\nb\nc\nd\ne\n");
      utimesSync(disguised, new Date("2020-01-01"), new Date("2020-01-01"));
      const fd = openAppend(disguised);
      const writer = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 1, stdioFds: [fd], stdioMaxBytes: 0 });
      try {
        expect(writer.cleanup()).toBe(0);
        expect(existsSync(disguised)).toBe(true);
      } finally {
        writer.close();
      }
    });
  });

  describe("copyTruncate", () => {
    it("keeps the content in <name>.1 and truncates the original in place (same inode)", () => {
      const file = join(tmpDir, "companion.log");
      writeFileSync(file, "line 1\nline 2\n");
      writeFileSync(`${file}.1`, "stale previous rotation, longer than the new copy\n");
      const inoBefore = statSync(file).ino;

      expect(mod.copyTruncate(file, `${file}.1`)).toBe(true);

      // .1 is overwritten (not appended to) with the full pre-rotation content.
      expect(readFileSync(`${file}.1`, "utf-8")).toBe("line 1\nline 2\n");
      expect(statSync(file).size).toBe(0);
      expect(statSync(file).ino).toBe(inoBefore);
    });

    it("leaves the original untouched when the copy cannot be made", () => {
      // Never truncate without a complete .1 copy: if the copy fails (here the
      // target directory doesn't exist; in production, ENOSPC) nothing is lost.
      const file = join(tmpDir, "companion.log");
      writeFileSync(file, "precious\n");
      expect(mod.copyTruncate(file, join(tmpDir, "missing-dir", "companion.log.1"))).toBe(false);
      expect(readFileSync(file, "utf-8")).toBe("precious\n");
    });

    it("chases lines appended while the copy runs into .1 before truncating", async () => {
      // Simulate the service writing during copyFileSync: those bytes must end
      // up in .1, not vanish in the truncate.
      const file = join(tmpDir, "companion.log");
      writeFileSync(file, "before\n");
      vi.resetModules();
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        return {
          ...actual,
          copyFileSync: (src: string, dst: string) => {
            actual.copyFileSync(src, dst);
            actual.appendFileSync(src, "during copy\n");
          },
        };
      });
      const mocked = await import("./logger.js");
      expect(mocked.copyTruncate(file, `${file}.1`)).toBe(true);
      expect(readFileSync(`${file}.1`, "utf-8")).toBe("before\nduring copy\n");
      expect(statSync(file).size).toBe(0);
    });
  });

  describe("inspectStdioFiles", () => {
    it("reports regular files with their O_APPEND flag and skips non-files and closed fds", () => {
      const appendFd = openAppend(join(tmpDir, "a.log"));
      const plainFd = openSync(join(tmpDir, "w.log"), "w");
      openFds.push(plainFd);
      const dirFd = openSync(tmpDir, "r");
      openFds.push(dirFd);
      const closedFd = openSync(join(tmpDir, "c.log"), "w");
      closeSync(closedFd);

      const res = mod.inspectStdioFiles([appendFd, plainFd, dirFd, closedFd]);
      expect(res).toHaveLength(2);
      expect(res[0].ino).toBe(statSync(join(tmpDir, "a.log")).ino);
      expect(res[1].ino).toBe(statSync(join(tmpDir, "w.log")).ino);
      if (process.platform === "linux") {
        expect(res[0].append).toBe(true);
        expect(res[1].append).toBe(false);
      }
    });
  });

  // O_APPEND detection needs /proc/self/fdinfo; elsewhere rotation is skipped by design.
  describe.runIf(process.platform === "linux")("stdio rotation during cleanup", () => {
    it("copy-truncates an oversized O_APPEND stdout file and the writer keeps appending to it", () => {
      // End-to-end version of the systemd setup: fd opened with O_APPEND, file
      // grows past the bound, cleanup rotates it. The inode must not change
      // and the next write must land at offset 0 of the same file (O_APPEND),
      // not at the old offset behind a hole of NUL bytes.
      const file = join(tmpDir, "companion.log");
      const fd = openAppend(file);
      const old = "old line\n".repeat(20); // 180 bytes
      writeSync(fd, old);
      const inoBefore = statSync(file).ino;
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const writer = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000, stdioFds: [fd], stdioMaxBytes: 100 });
      try {
        writer.cleanup();
        expect(readFileSync(`${file}.1`, "utf-8")).toBe(old);
        expect(statSync(file).ino).toBe(inoBefore);
        expect(statSync(file).size).toBe(0);

        writeSync(fd, "after rotation\n");
        expect(readFileSync(file, "utf-8")).toBe("after rotation\n");
        expect(statSync(file).ino).toBe(inoBefore);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Rotated companion.log"));
      } finally {
        writer.close();
      }
    });

    it("rotates a file shared by stdout and stderr only once", () => {
      // StandardOutput and StandardError may point at the same file. A second
      // copy-truncate in the same pass would overwrite .1 with the empty file.
      const file = join(tmpDir, "companion.log");
      const out = openAppend(file);
      const err = openAppend(file);
      writeSync(out, "x".repeat(300));
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const writer = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000, stdioFds: [out, err], stdioMaxBytes: 100 });
      try {
        writer.cleanup();
        expect(readFileSync(`${file}.1`, "utf-8")).toBe("x".repeat(300));
        expect(logSpy).toHaveBeenCalledTimes(1);
      } finally {
        writer.close();
      }
    });

    it("leaves files alone when under the bound, not O_APPEND, not ours, or rotation is disabled", () => {
      // Conservative by construction: only a file we provably append to, and
      // only past the bound, is ever truncated.
      const small = join(tmpDir, "companion.error.log");
      const smallFd = openAppend(small);
      writeSync(smallFd, "tiny\n");
      const nonAppend = join(tmpDir, "companion.log");
      const nonAppendFd = openSync(nonAppend, "w");
      openFds.push(nonAppendFd);
      writeSync(nonAppendFd, "y".repeat(300));
      const foreign = join(tmpDir, "foreign.log");
      writeFileSync(foreign, "z".repeat(300));

      const writer = new mod.LogFileWriter({
        logsDir: tmpDir, maxLines: 1_000_000, stdioFds: [smallFd, nonAppendFd], stdioMaxBytes: 100,
      });
      try {
        writer.cleanup();
        expect(statSync(small).size).toBe(5);
        expect(statSync(nonAppend).size).toBe(300);
        expect(statSync(foreign).size).toBe(300);
        expect(readdirSync(tmpDir).some((f) => f.endsWith(".1"))).toBe(false);
      } finally {
        writer.close();
      }

      const big = join(tmpDir, "big.log");
      const bigFd = openAppend(big);
      writeSync(bigFd, "w".repeat(300));
      const disabled = new mod.LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000, stdioFds: [bigFd], stdioMaxBytes: 0 });
      try {
        disabled.cleanup();
        expect(statSync(big).size).toBe(300);
      } finally {
        disabled.close();
      }
    });

    it("reads the bound from COMPANION_LOG_STDIO_MAX_MB (0 disables, garbage falls back to 100 MB)", async () => {
      // The bound is operator-tunable without a code change.
      const file = join(tmpDir, "companion.log");
      const fd = openAppend(file);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const runWith = async (env: string) => {
        writeSync(fd, "q".repeat(300));
        process.env.COMPANION_LOG_STDIO_MAX_MB = env;
        vi.resetModules();
        const fresh = await import("./logger.js");
        const w = new fresh.LogFileWriter({ logsDir: tmpDir, maxLines: 1_000_000, stdioFds: [fd] });
        try {
          w.cleanup();
        } finally {
          w.close();
        }
        return statSync(file).size;
      };

      expect(await runWith("0")).toBe(300); // disabled
      expect(await runWith("abc")).toBe(600); // default 100 MB: far from reached
      expect(await runWith("0.0001")).toBe(0); // ~104 bytes: rotated
      expect(readFileSync(`${file}.1`, "utf-8")).toBe("q".repeat(900));
    });
  });
});
