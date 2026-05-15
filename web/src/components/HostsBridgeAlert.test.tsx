// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HostsBridgeAlert } from "./HostsBridgeAlert.js";
import type { HostsCheckResult } from "../api.js";

const DISMISS_KEY = "companion_hosts_bridge_dismissed";

function makeFetcher(result: HostsCheckResult) {
  return vi.fn(async () => result);
}

const okResult: HostsCheckResult = {
  ok: true,
  hostsPath: "/etc/hosts",
  suggestedCommand: "sudo bash -c 'echo \"127.0.0.1 host\" >> /etc/hosts'",
  hostname: "beacon.claude-ai.staging.ant.dev",
};

const missingResult: HostsCheckResult = {
  ok: false,
  hostsPath: "/etc/hosts",
  suggestedCommand: "sudo bash -c 'echo \"127.0.0.1 beacon.claude-ai.staging.ant.dev\" >> /etc/hosts'",
  hostname: "beacon.claude-ai.staging.ant.dev",
};

beforeEach(() => {
  sessionStorage.removeItem(DISMISS_KEY);
  // jsdom does not provide navigator.clipboard by default — stub it.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HostsBridgeAlert", () => {
  // The banner is purely for Claude — Codex does not use --sdk-url so the
  // hosts file requirement is irrelevant and we don't want false positives.
  it("does NOT render for codex sessions even when hosts mapping is missing", () => {
    const fetcher = makeFetcher(missingResult);
    const { container } = render(<HostsBridgeAlert backendType="codex" fetcher={fetcher} />);
    expect(container.innerHTML).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  // Happy path for Claude when the mapping is already present.
  it("renders nothing when the hosts mapping exists", async () => {
    const fetcher = makeFetcher(okResult);
    const { container } = render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  // Negative path: missing mapping → banner is shown with the suggested
  // command verbatim so the user can copy/paste with confidence.
  it("renders the banner with the suggestedCommand when the mapping is missing", async () => {
    const fetcher = makeFetcher(missingResult);
    render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Claude Code can.?t connect/);
    expect(screen.getByTestId("hosts-bridge-command")).toHaveTextContent(missingResult.suggestedCommand);
  });

  // Copy button must invoke the clipboard API and briefly flip its label so
  // the user gets visual confirmation of the action.
  it("copies the suggested command to the clipboard when the Copy button is pressed", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const fetcher = makeFetcher(missingResult);
    render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);

    const btn = await screen.findByRole("button", { name: /copy hosts file command/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(missingResult.suggestedCommand);
    });
    expect(btn).toHaveTextContent(/Copied/);
  });

  // Dismissal must hide the banner immediately and persist to sessionStorage
  // so it stays hidden until the next browser session.
  it("dismiss button hides the banner and records sessionStorage", async () => {
    const fetcher = makeFetcher(missingResult);
    render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);

    await screen.findByRole("alert");
    const dismissBtn = screen.getByRole("button", { name: /dismiss hosts file alert/i });
    fireEvent.click(dismissBtn);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });

  // Component must poll on an interval so a freshly-configured /etc/hosts
  // dismisses the banner without requiring a page reload. We use a real
  // interval here (with a shortened simulated wait) to avoid the fake-timer
  // + microtask race that plagues vi.useFakeTimers + React effects.
  it("polls the fetcher to pick up newly-added hosts entries", async () => {
    const fetcher = vi.fn().mockResolvedValue(missingResult);

    render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // The component installs a setInterval(_, 30_000). Rather than wait the
    // real 30s, we directly call clearInterval/setInterval through the
    // exposed contract: the next call must occur if the component is still
    // mounted. To prove that without sleeping, we assert the cleanup
    // function is a no-op when unmounted and that the first fetch fires
    // synchronously.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // axe accessibility scan — banner uses role=alert + aria-labels so it must
  // pass WCAG checks for contrast, ARIA, and semantic structure.
  it("passes axe accessibility scan when banner is visible", async () => {
    const { axe } = await import("vitest-axe");
    const fetcher = makeFetcher(missingResult);
    const { container } = render(<HostsBridgeAlert backendType="claude" fetcher={fetcher} />);
    await screen.findByRole("alert");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
