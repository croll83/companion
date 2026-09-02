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

/** Minimum CPU ticks over the observation window to count as "working". */
export const CPU_ACTIVE_TICKS = Number(process.env.TG_CPU_ACTIVE_TICKS) || 20;

/**
 * Decide if the CLI is working. `prevTicks` is the cpuTicks() sample taken at
 * the previous check (or when the turn started); the caller stores the returned
 * `ticks` for the next call. With no baseline we only trust the child check.
 */
export function cliWorking(pid: number | null, prevTicks: number | null): { working: boolean; ticks: number | null } {
  if (!pid || pid <= 0) return { working: false, ticks: null };
  const ticks = cpuTicks(pid);
  if (ticks === null) return { working: false, ticks: null };            // process gone
  if (hasNonMcpChild(pid)) return { working: true, ticks };
  if (prevTicks !== null && ticks - prevTicks >= CPU_ACTIVE_TICKS) return { working: true, ticks };
  return { working: false, ticks };
}
