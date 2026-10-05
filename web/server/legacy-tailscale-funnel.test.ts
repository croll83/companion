import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warnIfLegacyTailscaleFunnel } from "./legacy-tailscale-funnel.js";

describe("warnIfLegacyTailscaleFunnel", () => {
  let home: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("stays silent when no Funnel state was ever persisted", () => {
    // Fresh installs and hosts that never used Funnel must not get a warning.
    home = mkdtempSync(join(tmpdir(), "companion-ts-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(warnIfLegacyTailscaleFunnel(home)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with the reset command when an old tailscale-state.json exists", () => {
    // Funnel config survives in tailscaled after the integration was removed;
    // the leftover state file is the signal that the user may still be public.
    home = mkdtempSync(join(tmpdir(), "companion-ts-"));
    writeFileSync(join(home, "tailscale-state.json"), JSON.stringify({ funnelActive: true, port: 3456 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(warnIfLegacyTailscaleFunnel(home)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("sudo tailscale funnel reset");
  });
});
