/**
 * Liveness probe for a companion-spawned Claude CLI, used by the Telegram bridge
 * to avoid relaunching a session that is actually working (the earlier watchdogs
 * relaunched on frame-silence alone, which killed CLIs mid --resume init or
 * mid long tool — corrupting the resume and losing context).
 *
 * "Working" = the CLI process has EITHER a non-MCP child (a tool running) OR an
 * ESTABLISHED TCP connection to a non-loopback address (talking to the model
 * API). A deadlocked CLI has neither: event loop parked, no request in flight.
 *
 * Reads /proc directly (Linux). Only `establishedExternalInodes` is pure and
 * unit-tested; the /proc glue is best-effort and fails safe (returns false =
 * "not proven working" only when it truly can't tell).
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

function isZeroHex(h: string): boolean { return /^0+$/.test(h); }
function isLoopbackHex(h: string): boolean {
  // /proc/net/tcp encodes the IP little-endian hex. 127.0.0.1 -> "0100007F".
  // IPv6 ::1 -> "00000000000000000000000001000000". v4-mapped loopback ends 0100007F.
  if (h === "0100007F") return true;
  if (h === "00000000000000000000000001000000") return true;
  if (h.endsWith("0100007F")) return true;
  return false;
}

/** Socket inodes with an ESTABLISHED (st=01) connection to a real remote host. */
export function establishedExternalInodes(procNetTcp: string): Set<string> {
  const out = new Set<string>();
  const lines = procNetTcp.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 10) continue;
    if (f[3] !== "01") continue;                 // 01 = TCP_ESTABLISHED
    const ipHex = (f[2].split(":")[0] || "").toUpperCase();
    if (isZeroHex(ipHex) || isLoopbackHex(ipHex)) continue;
    out.add(f[9]);                               // inode
  }
  return out;
}

function socketInodesOfPid(pid: number): Set<string> {
  const out = new Set<string>();
  let fds: string[];
  try { fds = readdirSync(`/proc/${pid}/fd`); } catch { return out; }
  for (const fd of fds) {
    try {
      const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
      if (m) out.add(m[1]);
    } catch { /* fd vanished */ }
  }
  return out;
}

function hasNonMcpChild(pid: number): boolean {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8"); } catch { return false; }
  for (const cpid of raw.trim().split(/\s+/).filter(Boolean)) {
    let cmd = "";
    try { cmd = readFileSync(`/proc/${cpid}/cmdline`, "utf-8").replace(/\0/g, " ").trim(); } catch { continue; }
    if (!cmd) continue;
    if (/mcp|modelcontextprotocol/i.test(cmd)) continue; // persistent MCP server, not a tool
    return true;
  }
  return false;
}

/** True if the CLI is provably doing work (a tool child, or an API connection). */
export function cliWorking(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (hasNonMcpChild(pid)) return true;
    const inodes = socketInodesOfPid(pid);
    if (inodes.size === 0) return false;
    const ext = new Set<string>();
    for (const p of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try { for (const ino of establishedExternalInodes(readFileSync(p, "utf-8"))) ext.add(ino); }
      catch { /* one family may be absent */ }
    }
    for (const ino of inodes) if (ext.has(ino)) return true;
    return false;
  } catch { return false; }
}
