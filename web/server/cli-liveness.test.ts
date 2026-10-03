import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import cp from "node:child_process";

// Fake /proc: tests register file contents by path; anything unregistered
// falls through to the real fs (so the "no such process" test stays real).
const fakeProc = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: string, ...rest: unknown[]) => {
      if (fakeProc.has(String(path))) return fakeProc.get(String(path));
      if (String(path).startsWith("/proc/7777")) throw new Error("ENOENT"); // fake pids: never hit the real /proc
      if (String(path).startsWith("/proc/8888")) throw new Error("ENOENT");
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

import {
  parseCpuTicks, parseChildren, anyNonMcp, cliWorking, parseSsLastRcv, cpuTicks,
  CPU_ACTIVE_TICKS_PER_SEC, SOCKET_ACTIVE_MS,
} from "./cli-liveness.js";

describe("parseCpuTicks", () => {
  it("sums utime+stime from /proc/<pid>/stat", () => {
    // pid (comm) state ppid pgrp sess tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
    const stat = "1893153 (claude) S 494429 1 1 0 -1 4194560 100 0 0 0 300 162 0 0 20 0 10 0 12345 1 0";
    expect(parseCpuTicks(stat)).toBe(462);
  });
  it("survives a comm with spaces and parentheses", () => {
    const stat = "42 (my (odd) name) R 1 1 1 0 -1 0 0 0 0 0 7 3 0 0 20 0 1 0 0 0 0";
    expect(parseCpuTicks(stat)).toBe(10);
  });
  it("returns null on garbage", () => {
    expect(parseCpuTicks("")).toBeNull();
    expect(parseCpuTicks("nope")).toBeNull();
  });
});

describe("parseChildren / anyNonMcp", () => {
  it("parses the children list", () => {
    expect(parseChildren(" 12 34 56 \n")).toEqual([12, 34, 56]);
    expect(parseChildren("")).toEqual([]);
  });
  it("ignores persistent MCP servers but flags a real tool", () => {
    expect(anyNonMcp(["npm\0exec\0@modelcontextprotocol/server-github", "sh\0-c\0mcp-server-github"])).toBe(false);
    expect(anyNonMcp(["npm\0exec\0@modelcontextprotocol/server-github", "bash\0-c\0npx vitest run"])).toBe(true);
    expect(anyNonMcp([])).toBe(false);
  });
});

describe("cliWorking", () => {
  it("is not fooled by a missing/invalid pid", () => {
    expect(cliWorking(null, null).working).toBe(false);
    expect(cliWorking(0, null).working).toBe(false);
    expect(cliWorking(999999999, null).working).toBe(false); // no such process
  });
});

describe("parseSsLastRcv", () => {
  const ss = [
    "ESTAB 0 0 192.168.68.81:49322 160.79.104.10:443 users:((\"claude\",pid=555,fd=16))",
    "\t cubic wscale:13,10 rto:230 lastsnd:1200 lastrcv:800 lastack:880",
    "ESTAB 0 0 127.0.0.1:41236 127.0.0.1:3456 users:((\"claude\",pid=555,fd=7))",
    "\t cubic lastsnd:10 lastrcv:5 lastack:5",
    "ESTAB 0 0 192.168.68.81:5000 10.0.0.9:443 users:((\"other\",pid=999,fd=3))",
    "\t cubic lastrcv:50",
  ].join("\n");
  it("returns lastrcv only for the pid's non-loopback sockets", () => {
    const r = parseSsLastRcv(ss, 555);
    expect(r).toEqual([800]);          // 3456 loopback skipped; pid 999 ignored
  });
  it("returns empty when the pid has no external socket", () => {
    expect(parseSsLastRcv(ss, 12345)).toEqual([]);
  });
});

// Build a /proc/<pid>/stat line whose utime+stime = ut+st.
const statLine = (pid: number, ut: number, st: number) =>
  `${pid} (claude) S 1 1 1 0 -1 0 0 0 0 0 ${ut} ${st} 0 0 20 0 1 0 0 0 0`;

describe("cpuTicks", () => {
  beforeEach(() => fakeProc.clear());
  it("reads utime+stime from /proc/<pid>/stat", () => {
    fakeProc.set("/proc/7777/stat", statLine(7777, 40, 2));
    expect(cpuTicks(7777)).toBe(42);
  });
  it("returns null when the stat file cannot be read (process gone)", () => {
    expect(cpuTicks(7777)).toBeNull();
  });
});

describe("cliWorking (fake /proc + ss)", () => {
  const PID = 7777;
  let ssSpy: ReturnType<typeof vi.spyOn>;
  // ss output: by default the pid has no sockets at all.
  let ssOutput = "";

  beforeEach(() => {
    fakeProc.clear();
    ssOutput = "";
    fakeProc.set(`/proc/${PID}/stat`, statLine(PID, 100, 0));
    // cli-liveness lazily require()s child_process; spying on the shared CJS
    // module object intercepts that call too.
    ssSpy = vi.spyOn(cp, "execFileSync").mockImplementation((() => ssOutput) as never);
  });
  afterEach(() => ssSpy.mockRestore());

  it("reports not working (no sample) when /proc stat is unreadable", () => {
    fakeProc.delete(`/proc/${PID}/stat`);
    expect(cliWorking(PID, null)).toEqual({ working: false, sample: null });
  });

  it("is working when the CLI has a non-MCP child (a tool is running)", () => {
    fakeProc.set(`/proc/${PID}/task/${PID}/children`, "8001 8002\n");
    fakeProc.set("/proc/8001/cmdline", "node\0@modelcontextprotocol/server-github");
    fakeProc.set("/proc/8002/cmdline", "bash\0-c\0npm test");
    const r = cliWorking(PID, null);
    expect(r.working).toBe(true);
    expect(r.sample?.ticks).toBe(100);
    // the child check short-circuits before ss is consulted
    expect(ssSpy).not.toHaveBeenCalled();
  });

  it("ignores MCP-only children and children that vanished mid-scan", () => {
    fakeProc.set(`/proc/${PID}/task/${PID}/children`, "8001 8888");
    fakeProc.set("/proc/8001/cmdline", "npx\0mcp-server-foo");
    // /proc/8888/cmdline unregistered → throws → skipped
    const r = cliWorking(PID, null);
    expect(r.working).toBe(false);
    expect(r.sample).not.toBeNull();
  });

  it("is working when an external socket received data recently", () => {
    ssOutput = [
      `ESTAB 0 0 10.0.0.2:5000 160.79.104.10:443 users:(("claude",pid=${PID},fd=16))`,
      `\t cubic lastrcv:${SOCKET_ACTIVE_MS - 1}`,
    ].join("\n");
    expect(cliWorking(PID, null).working).toBe(true);
    expect(ssSpy).toHaveBeenCalledWith("ss", ["-tnpi"], expect.objectContaining({ encoding: "utf-8" }));
  });

  it("does not count an idle keep-alive socket as working", () => {
    ssOutput = [
      `ESTAB 0 0 10.0.0.2:5000 160.79.104.10:443 users:(("claude",pid=${PID},fd=16))`,
      `\t cubic lastrcv:${SOCKET_ACTIVE_MS + 60_000}`,
    ].join("\n");
    expect(cliWorking(PID, null).working).toBe(false);
  });

  it("fails safe when ss is unavailable", () => {
    ssSpy.mockImplementation(() => { throw new Error("ss: not found"); });
    expect(cliWorking(PID, null).working).toBe(false);
  });

  it("without a baseline sample, CPU is not consulted", () => {
    fakeProc.set(`/proc/${PID}/stat`, statLine(PID, 1_000_000, 0));
    expect(cliWorking(PID, null).working).toBe(false);
  });

  it("is working when the CPU rate since the previous sample is above idle housekeeping", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      // 10 s window, rate threshold × 10 ticks burned → exactly at threshold
      const prev = { ticks: 100 - CPU_ACTIVE_TICKS_PER_SEC * 10, at: 0 };
      const r = cliWorking(PID, prev);
      expect(r.working).toBe(true);
      expect(r.sample).toEqual({ ticks: 100, at: 10_000 });
    } finally { vi.useRealTimers(); }
  });

  it("is not working when the CPU rate is only idle housekeeping", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      // 1 tick/s over 100 s: an absolute delta of 100 ticks, but a low rate
      const r = cliWorking(PID, { ticks: 0, at: 0 });
      expect(r.working).toBe(false);
      expect(r.sample).toEqual({ ticks: 100, at: 100_000 });
    } finally { vi.useRealTimers(); }
  });

  it("clamps the window to >= 1 s so back-to-back samples cannot blow up the rate", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(5_000);
      // 2 ticks in 1 ms would be 2000 ticks/s unclamped; clamped it is 2/s < 3
      expect(cliWorking(PID, { ticks: 98, at: 4_999 }).working).toBe(CPU_ACTIVE_TICKS_PER_SEC <= 2);
    } finally { vi.useRealTimers(); }
  });
});
