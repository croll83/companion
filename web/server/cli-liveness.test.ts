import { describe, it, expect } from "vitest";
import { parseCpuTicks, parseChildren, anyNonMcp, cliWorking, parseSsLastRcv } from "./cli-liveness.js";

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
