// @vitest-environment jsdom
/**
 * SessionReload is the "Reload" button under the wake-ups in the TaskPanel.
 * It force-relaunches the focused session's CLI on the same conversation
 * (POST /sessions/:id/relaunch?force=1). Because a forced reload interrupts a
 * running turn, it must always ask for confirmation before calling the API.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ relaunchSession: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { SessionReload } from "./SessionReload.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockApi.relaunchSession.mockResolvedValue({ ok: true });
});

describe("SessionReload", () => {
  it("renders a Reload button without calling the API", () => {
    render(<SessionReload sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(mockApi.relaunchSession).not.toHaveBeenCalled();
  });

  it("passes axe accessibility scan in both the idle and confirm states", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionReload sessionId="s1" />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("asks for confirmation and only then force-relaunches the focused session", async () => {
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    // The first click never reloads: a forced reload interrupts a running turn.
    expect(mockApi.relaunchSession).not.toHaveBeenCalled();
    expect(screen.getByText(/A turn in progress is interrupted/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(mockApi.relaunchSession).toHaveBeenCalledWith("s1", { force: true });
    expect(await screen.findByRole("status")).toHaveTextContent(/same conversation/);
  });

  it("cancel leaves the session alone", () => {
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockApi.relaunchSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("disables the button while the reload is in flight", async () => {
    let resolve!: (v: unknown) => void;
    mockApi.relaunchSession.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));

    // A second click while the first reload runs must not start another one.
    expect(screen.getByRole("button", { name: "Reloading..." })).toBeDisabled();
    await act(async () => { resolve({ ok: true }); });
    expect(mockApi.relaunchSession).toHaveBeenCalledTimes(1);
  });

  it("shows the server's error when the reload fails", async () => {
    mockApi.relaunchSession.mockRejectedValue(new Error("Session is archived"));
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Session is archived");
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
  });

  it("shows non-Error rejections as text", async () => {
    mockApi.relaunchSession.mockRejectedValue("offline");
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  it("clears the confirmation after a few seconds", async () => {
    vi.useFakeTimers();
    render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reload now" })); });
    expect(screen.getByRole("status")).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("resets a pending confirmation when another session takes focus", () => {
    const { rerender } = render(<SessionReload sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    rerender(<SessionReload sessionId="s2" />);

    // A confirmation for s1 must never reload s2.
    expect(screen.queryByRole("button", { name: "Reload now" })).not.toBeInTheDocument();
  });
});
