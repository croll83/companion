/**
 * Liveness probe for a companion-spawned Claude CLI, used by the Telegram bridge
 * so a stall/no-activity relaunch never kills a CLI that is actually working.
 *
 * "Working" = the CLI has a non-MCP child (a tool running) OR it has burned
 * CPU since the last check (streaming / parsing / thinking). A deadlocked or
 * finished-and-idle CLI does neither: event loop parked, ~0 CPU.
 *
 * Deliberately NOT "has an external TCP connection": the HTTP client keeps an
 * idle keep-alive socket to the API open for minutes after a request, which
 * made an idle CLI look busy forever (observed: lastrcv 5 min old, 2 KB total,
 * 0 CPU ticks over 3 s — and the watchdog deferred indefinitely).
 *
 * Reads /proc (Linux). Fails safe: if it cannot read the process it reports
 * "not proven working" so the caller's recovery path still runs.
 */
import { readFileSync } from "node:fs";

/** utime+stime clock ticks from the contents of /proc/<pid>/stat, or null. */
export function parseCpuTicks(stat: string): number | null {
  // comm may contain spaces/parens: fields start after the LAST ')'.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  // rest[0] = state (field 3); utime = field 14 → rest[11]; stime = field 15 → rest[12]
  const ut = Number(rest[11]), st = Number(rest[12]);
  return Number.isFinite(ut) && Number.isFinite(st) ? ut + st : null;
}

/** utime+stime clock ticks of a live pid, or null if unreadable. */
export function cpuTicks(pid: number): number | null {
  try { return parseCpuTicks(readFileSync(`/proc/${pid}/stat`, "utf-8")); } catch { return null; }
}

/** Parse the whitespace-separated child pid list from /proc/<pid>/task/<pid>/children. */
export function parseChildren(raw: string): number[] {
  return raw.trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/** True if any command line is a real tool/subagent (not a persistent MCP server). */
export function anyNonMcp(cmdlines: string[]): boolean {
  return cmdlines.some((c) => {
    const s = c.replace(/\0/g, " ").trim();
    return s.length > 0 && !/mcp|modelcontextprotocol/i.test(s);
  });
}

function hasNonMcpChild(pid: number): boolean {
  let raw: string;
  try { raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf-8"); } catch { return false; }
  const cmds: string[] = [];
  for (const c of parseChildren(raw)) {
    try { cmds.push(readFileSync(`/proc/${c}/cmdline`, "utf-8")); } catch { /* gone */ }
  }
  return anyNonMcp(cmds);
}

/**
 * Minimum CPU RATE (clock ticks per second, 100 ticks = 1 CPU-second) over the
 * observation window to count as "working". An idle CLI still burns ~0.5-1
 * tick/s of housekeeping (timers, MCP keepalive, GC) — over a 3-minute window
 * that is well over 100 ticks, which is why an absolute tick threshold was
 * fooled (observed: 40 s CPU over 92 idle minutes, 0 ticks in any 3 s sample).
 * Streaming/parsing a turn runs at several ticks/s.
 */
export const CPU_ACTIVE_TICKS_PER_SEC = Number(process.env.TG_CPU_ACTIVE_TPS) || 3;

/** ms since a socket last RECEIVED data, from `ss -tnpi` output, for one pid. */
export function parseSsLastRcv(ssOutput: string, pid: number): number[] {
  const out: number[] = [];
  const lines = ssOutput.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(`pid=${pid},`)) continue;
    // skip loopback peers (companion WS, local MCP)
    const cols = lines[i].trim().split(/\s+/);
    const peer = cols[4] || "";
    if (/^(127\.|\[?::1\]?:)/.test(peer)) continue;
    const info = lines[i + 1] || "";
    const m = info.match(/lastrcv:(\d+)/);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** An external socket that received data recently = a model response in flight. */
export const SOCKET_ACTIVE_MS = Number(process.env.TG_SOCKET_ACTIVE_MS) || 30_000;

function hasActiveExternalSocket(pid: number): boolean {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("ss", ["-tnpi"], { encoding: "utf-8", timeout: 3000 });
    return parseSsLastRcv(out, pid).some((ms) => ms < SOCKET_ACTIVE_MS);
  } catch { return false; }
}

/**
 * Decide if the CLI is working. `prev` is the sample returned by the previous
 * call (or taken when the turn started); the caller stores the returned sample.
 * Working = a tool child, OR an external socket with recent traffic, OR a CPU
 * rate above idle housekeeping. With no baseline, CPU is not consulted.
 */
export interface CpuSample { ticks: number; at: number }
export function cliWorking(pid: number | null, prev: CpuSample | null): { working: boolean; sample: CpuSample | null } {
  if (!pid || pid <= 0) return { working: false, sample: null };
  const ticks = cpuTicks(pid);
  if (ticks === null) return { working: false, sample: null };          // process gone
  const sample = { ticks, at: Date.now() };
  if (hasNonMcpChild(pid)) return { working: true, sample };
  if (hasActiveExternalSocket(pid)) return { working: true, sample };
  if (prev) {
    const secs = Math.max(1, (sample.at - prev.at) / 1000);
    if ((ticks - prev.ticks) / secs >= CPU_ACTIVE_TICKS_PER_SEC) return { working: true, sample };
  }
  return { working: false, sample };
}
