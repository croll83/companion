// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ClaudeCliAlert } from "./ClaudeCliAlert.js";
import type { ClaudeCliCheckResult } from "../api.js";

const DISMISS_KEY = "companion_claude_cli_dismissed";

function makeFetcher(result: ClaudeCliCheckResult) {
  return vi.fn(async () => result);
}

const okResult: ClaudeCliCheckResult = {
  ok: true,
  found: true,
  version: "2.1.175",
  missingFlags: [],
  reason: null,
  suggestedCommand: "claude update",
};

const tooOldResult: ClaudeCliCheckResult = {
  ok: false,
  found: true,
  version: "1.0.0",
  missingFlags: ["--include-partial-messages"],
  reason: "Your Claude CLI (v1.0.0) is missing features required by this Companion build (--include-partial-messages). Update it to continue.",
  suggestedCommand: "claude update",
};

const notFoundResult: ClaudeCliCheckResult = {
  ok: false,
  found: false,
  version: null,
  missingFlags: [],
  reason: "Claude CLI not found on PATH. Install it, then reload.",
  suggestedCommand: "claude update",
};

beforeEach(() => {
  sessionStorage.removeItem(DISMISS_KEY);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeCliAlert", () => {
  it("does NOT render for codex sessions", () => {
    const fetcher = makeFetcher(tooOldResult);
    const { container } = render(<ClaudeCliAlert backendType="codex" fetcher={fetcher} />);
    expect(container.innerHTML).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders nothing when the CLI is compatible", async () => {
    const fetcher = makeFetcher(okResult);
    const { container } = render(<ClaudeCliAlert backendType="claude" fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("shows the update banner with `claude update` when the CLI is too old", async () => {
    const fetcher = makeFetcher(tooOldResult);
    render(<ClaudeCliAlert backendType="claude" fetcher={fetcher} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/needs updating/i);
    expect(alert).toHaveTextContent(/--include-partial-messages/);
    expect(screen.getByTestId("claude-cli-command")).toHaveTextContent("claude update");
  });

  it("shows a not-found title when the CLI is missing", async () => {
    const fetcher = makeFetcher(notFoundResult);
    render(<ClaudeCliAlert backendType="claude" fetcher={fetcher} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/not found/i);
  });

  it("can be dismissed", async () => {
    const fetcher = makeFetcher(tooOldResult);
    render(<ClaudeCliAlert backendType="claude" fetcher={fetcher} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss Claude CLI alert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe("1");
  });
});
