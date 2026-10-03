// Prefix every console line with local time, to the millisecond.
//
// companion.log / companion.error.log are the service's raw stdout/stderr
// (systemd StandardOutput=append), so lines carried no time at all. Ordering a
// CLI death against a kill, a relaunch or a browser reconnect was guesswork —
// the sessions-dying-mid-turn investigation (2026-10-03) had to reconstruct
// timelines from recordings instead. Imported first by index.ts so it covers
// everything the server prints.

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function stamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const g = globalThis as { __companionLogStamped?: boolean };
// With COMPANION_LOG_FORMAT=json every logger line is already an NDJSON object
// carrying its own `ts`; a prefix would make those lines unparseable.
const structured = process.env.COMPANION_LOG_FORMAT === "json";
if (!g.__companionLogStamped && !structured) {
  g.__companionLogStamped = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(stamp(), ...args);
  }
}
