import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We mock node:fs at the module level so each test can drive the contents
// of the hosts file synthetically without ever touching the real file.
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readFileSync: vi.fn<(p: string, enc?: string) => string>(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

import { checkHostsEntry } from "./hosts-check.js";

const HOSTNAME = "beacon.claude-ai.staging.ant.dev";

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  mocks.existsSync.mockReset();
  mocks.readFileSync.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

describe("checkHostsEntry (linux/darwin)", () => {
  beforeEach(() => setPlatform("linux"));

  // Happy path: a normal loopback entry returns ok=true and points the
  // suggestedCommand at /etc/hosts via sudo bash -c.
  it("returns ok=true when /etc/hosts has 127.0.0.1 → hostname", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`# header\n127.0.0.1 localhost\n127.0.0.1 ${HOSTNAME}\n`);

    const result = checkHostsEntry(HOSTNAME);
    expect(result.ok).toBe(true);
    expect(result.hostsPath).toBe("/etc/hosts");
    expect(result.suggestedCommand).toContain("sudo bash -c");
    expect(result.suggestedCommand).toContain(HOSTNAME);
  });

  // IPv6 loopback (::1) is also acceptable because Bun.serve listens on the
  // dual-stack socket by default.
  it("accepts ::1 as a loopback mapping", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`::1 ${HOSTNAME}\n`);
    expect(checkHostsEntry(HOSTNAME).ok).toBe(true);
  });

  // Stray commented-out lines must NOT count — users sometimes pre-stage
  // entries with `# 127.0.0.1 foo` and we'd silently miss the missing setup.
  it("ignores commented-out entries", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`# 127.0.0.1 ${HOSTNAME}\n127.0.0.1 localhost\n`);
    expect(checkHostsEntry(HOSTNAME).ok).toBe(false);
  });

  // If the file is missing entirely (some minimal containers/sandboxes),
  // we still return a usable `suggestedCommand` so the UI can render it.
  it("returns ok=false when /etc/hosts does not exist", () => {
    mocks.existsSync.mockReturnValue(false);
    const result = checkHostsEntry(HOSTNAME);
    expect(result.ok).toBe(false);
    expect(result.suggestedCommand).toContain("sudo bash -c");
  });

  // A mapping that points the hostname elsewhere (e.g. an explicit non-loop
  // IP) is rejected — we explicitly require loopback.
  it("rejects non-loopback mappings", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`10.0.0.5 ${HOSTNAME}\n`);
    expect(checkHostsEntry(HOSTNAME).ok).toBe(false);
  });

  // Multiple names on the same line are common (e.g. localhost aliases).
  it("matches the hostname when listed as a later alias on a 127.0.0.1 line", () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(`127.0.0.1 localhost foo.local ${HOSTNAME}\n`);
    expect(checkHostsEntry(HOSTNAME).ok).toBe(true);
  });
});

describe("checkHostsEntry (win32)", () => {
  beforeEach(() => {
    setPlatform("win32");
    process.env.SystemRoot = "C:\\Windows";
  });

  // Windows uses the canonical system32 path and a PowerShell runAs
  // elevation command; the embedded hostname must round-trip into the
  // suggestedCommand verbatim.
  it("returns the Windows hosts path and PowerShell suggestion", () => {
    mocks.existsSync.mockReturnValue(false);
    const result = checkHostsEntry(HOSTNAME);
    expect(result.ok).toBe(false);
    expect(result.hostsPath).toContain("System32\\drivers\\etc\\hosts");
    expect(result.suggestedCommand).toContain("powershell");
    expect(result.suggestedCommand).toContain("runAs");
    expect(result.suggestedCommand).toContain(HOSTNAME);
  });
});
