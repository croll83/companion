// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BunRuntimeAlert, BUN_RUNTIME_DISMISS_KEY } from "./BunRuntimeAlert.js";
import type { BunRuntimeCheckResult } from "../api.js";

const mockGetBunRuntimeCheck = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({
  api: { getBunRuntimeCheck: mockGetBunRuntimeCheck },
}));

function makeFetcher(result: BunRuntimeCheckResult) {
  return vi.fn(async () => result);
}

const okResult: BunRuntimeCheckResult = {
  version: "1.4.2",
  minimum: "1.4.0",
  ok: true,
  reason: "ok",
  isServiceMode: true,
};

const outdatedResult: BunRuntimeCheckResult = {
  version: "1.3.9",
  minimum: "1.4.0",
  ok: false,
  reason: "outdated",
  isServiceMode: true,
};

const outdatedForegroundResult: BunRuntimeCheckResult = { ...outdatedResult, isServiceMode: false };

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.removeItem(BUN_RUNTIME_DISMISS_KEY);
  mockGetBunRuntimeCheck.mockReset();
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BunRuntimeAlert", () => {
  // Bun >= 1.4.0: no banner at all.
  it("renders nothing when the Bun runtime is ok", async () => {
    const fetcher = makeFetcher(okResult);
    const { container } = render(<BunRuntimeAlert fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  // A failed check (network/auth error) must never surface a banner.
  it("renders nothing when the check request fails", async () => {
    const fetcher = vi.fn(async (): Promise<BunRuntimeCheckResult> => {
      throw new Error("network down");
    });
    const { container } = render(<BunRuntimeAlert fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  // Defensive: even if a result says ok=false without a version string, we
  // don't render a banner we can't phrase (nor a dismissal we can't key).
  it("renders nothing when an outdated result has no version", async () => {
    const fetcher = makeFetcher({ ...outdatedResult, version: null });
    const { container } = render(<BunRuntimeAlert fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  // Outdated Bun in service mode: the banner names the running version, the
  // minimum, the risk, and offers both `bun upgrade` and `the-companion restart`.
  it("shows the banner with bun upgrade and the restart command in service mode", async () => {
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Companion is running on Bun 1.3.9");
    expect(alert).toHaveTextContent("versions older than 1.4.0 have a bug that can drop live sessions");
    expect(alert).toHaveTextContent("bun upgrade");
    expect(alert).toHaveTextContent("the-companion restart");
    expect(screen.getByLabelText("Copy restart command")).toBeInTheDocument();
  });

  // Foreground (non-service) mode: there's no service to restart, so only the
  // upgrade command is shown with a plain "restart Companion" instruction.
  it("omits the restart command outside service mode", async () => {
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedForegroundResult)} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("then restart Companion.");
    expect(alert).not.toHaveTextContent("the-companion restart");
    expect(screen.queryByLabelText("Copy restart command")).not.toBeInTheDocument();
  });

  // Without an injected fetcher the component uses api.getBunRuntimeCheck.
  it("falls back to api.getBunRuntimeCheck when no fetcher is passed", async () => {
    mockGetBunRuntimeCheck.mockResolvedValue(outdatedResult);
    render(<BunRuntimeAlert />);
    await screen.findByRole("alert");
    expect(mockGetBunRuntimeCheck).toHaveBeenCalledTimes(1);
  });

  // Copy buttons write the exact command to the clipboard and flash "Copied".
  it("copies the upgrade and restart commands", async () => {
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    await screen.findByRole("alert");

    const upgradeBtn = screen.getByLabelText("Copy bun upgrade command");
    fireEvent.click(upgradeBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bun upgrade"));
    await waitFor(() => expect(upgradeBtn).toHaveTextContent("Copied"));

    fireEvent.click(screen.getByLabelText("Copy restart command"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the-companion restart"));
  });

  // The "Copied" label reverts after a short delay.
  it("resets the copied label after a delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    await screen.findByRole("alert");
    const upgradeBtn = screen.getByLabelText("Copy bun upgrade command");
    await act(async () => {
      fireEvent.click(upgradeBtn);
    });
    expect(upgradeBtn).toHaveTextContent("Copied");
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(upgradeBtn).toHaveTextContent("Copy");
  });

  // Clipboard rejection (insecure context) must not crash or flip the label.
  it("handles clipboard failures gracefully", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    await screen.findByRole("alert");
    const upgradeBtn = screen.getByLabelText("Copy bun upgrade command");
    fireEvent.click(upgradeBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(upgradeBtn).toHaveTextContent("Copy");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  // Dismissing hides the banner and stores the dismissed Bun VERSION, not a
  // boolean, in localStorage.
  it("dismisses and remembers the dismissed Bun version", async () => {
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Dismiss Bun runtime alert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem(BUN_RUNTIME_DISMISS_KEY)).toBe("1.3.9");
  });

  // A dismissal for the same version persists across mounts (page reloads).
  it("stays hidden on remount when the same version was dismissed", async () => {
    localStorage.setItem(BUN_RUNTIME_DISMISS_KEY, "1.3.9");
    const fetcher = makeFetcher(outdatedResult);
    const { container } = render(<BunRuntimeAlert fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  // Dismissal is per version: if Companion is still on an outdated Bun but a
  // DIFFERENT version (e.g. after another update), the banner comes back.
  it("reappears when the outdated Bun version differs from the dismissed one", async () => {
    localStorage.setItem(BUN_RUNTIME_DISMISS_KEY, "1.3.8");
    render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Bun 1.3.9");
  });

  // If localStorage throws (e.g. disabled storage), the banner still renders
  // and dismissing still hides it for the current view.
  it("tolerates unavailable localStorage", async () => {
    const getSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
      await screen.findByRole("alert");
      fireEvent.click(screen.getByLabelText("Dismiss Bun runtime alert"));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  // The check is re-polled periodically so the banner clears after
  // `bun upgrade` + restart without a page reload.
  it("re-polls the check and hides the banner once Bun is upgraded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi
      .fn<() => Promise<BunRuntimeCheckResult>>()
      .mockResolvedValueOnce(outdatedResult)
      .mockResolvedValue(okResult);
    render(<BunRuntimeAlert fetcher={fetcher} />);
    await screen.findByRole("alert");
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  // axe accessibility scan of the visible banner (role=alert, labelled
  // buttons, decorative icons hidden from assistive tech).
  it("passes axe accessibility scan when banner is visible", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BunRuntimeAlert fetcher={makeFetcher(outdatedResult)} />);
    await screen.findByRole("alert");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
