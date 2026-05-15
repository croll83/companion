import { existsSync, readFileSync } from "node:fs";

export interface HostsCheckResult {
  ok: boolean;
  hostsPath: string;
  /** Cross-platform command users can copy/paste to add the mapping. */
  suggestedCommand: string;
}

function getHostsPath(): string {
  if (process.platform === "win32") {
    // Windows resolves %SystemRoot% from the environment; fall back to
    // C:\Windows if it is missing (rare, but possible in unusual installs).
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    return `${systemRoot}\\System32\\drivers\\etc\\hosts`;
  }
  return "/etc/hosts";
}

function buildSuggestedCommand(hostname: string): string {
  if (process.platform === "win32") {
    // We use Start-Process -Verb runAs so the user is prompted for elevation
    // exactly once; Add-Content writes the line atomically (no risk of
    // truncation as with `>>` redirection in some shells).
    const inner = `Add-Content -Path C:\\Windows\\System32\\drivers\\etc\\hosts -Value '127.0.0.1 ${hostname}'`;
    return `powershell -Command "Start-Process powershell -Verb runAs -ArgumentList \\"-Command ${inner}\\""`;
  }
  return `sudo bash -c 'echo "127.0.0.1 ${hostname}" >> /etc/hosts'`;
}

/**
 * Detect whether the OS hosts file maps `hostname` to a loopback address.
 *
 * Returns `ok: true` only when the active mapping is loopback. A stray
 * commented-out line (e.g. `# 127.0.0.1 foo`) does not count, nor does a
 * line that resolves the name to anything other than 127.0.0.1 / ::1.
 *
 * On a missing hosts file (e.g. some sandboxed environments), `ok` is false
 * and the `suggestedCommand` still points to the canonical OS location so
 * downstream UI can render guidance without inspecting the platform.
 */
export function checkHostsEntry(hostname: string): HostsCheckResult {
  const hostsPath = getHostsPath();
  const suggestedCommand = buildSuggestedCommand(hostname);

  if (!existsSync(hostsPath)) {
    return { ok: false, hostsPath, suggestedCommand };
  }

  let content: string;
  try {
    content = readFileSync(hostsPath, "utf-8");
  } catch {
    return { ok: false, hostsPath, suggestedCommand };
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Hosts entries are whitespace-separated: <ip> <name1> <name2> ...
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const ip = parts[0];
    const names = parts.slice(1).map((n) => n.toLowerCase());
    if (!names.includes(hostname.toLowerCase())) continue;
    if (ip === "127.0.0.1" || ip === "::1") {
      return { ok: true, hostsPath, suggestedCommand };
    }
  }

  return { ok: false, hostsPath, suggestedCommand };
}
