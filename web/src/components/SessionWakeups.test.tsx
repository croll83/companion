// @vitest-environment jsdom
/**
 * SessionWakeups shows a session's scheduled messages ("wake-ups") in the
 * TaskPanel: pending ones with their time and a Cancel button, skipped or
 * missed ones with the reason and a Dismiss button, and a small form that
 * schedules a new one-shot or cron wake-up through the API.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listSessionWakeups: vi.fn(),
  createSessionWakeup: vi.fn(),
  cancelSessionWakeup: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { useStore } from "../store.js";
import { SessionWakeups } from "./SessionWakeups.js";
import type { SessionWakeup } from "../api.js";

function wakeup(overrides: Partial<SessionWakeup> = {}): SessionWakeup {
  return {
    id: "wk-1",
    sessionId: "s1",
    message: "Check the nightly build",
    schedule: { at: "2026-10-06T09:00" },
    createdAt: 1,
    createdBy: "user",
    nextRunAt: Date.parse("2026-10-06T09:00:00Z"),
    enabled: true,
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ timeZone: "UTC" });
  mockApi.listSessionWakeups.mockResolvedValue({ wakeups: [] });
  mockApi.createSessionWakeup.mockResolvedValue({ wakeup: wakeup() });
  mockApi.cancelSessionWakeup.mockResolvedValue({ ok: true });
});

describe("SessionWakeups", () => {
  it("renders pending wake-ups with their time and message", async () => {
    mockApi.listSessionWakeups.mockResolvedValue({
      wakeups: [wakeup(), wakeup({ id: "wk-2", schedule: { cron: "0 9 * * 1-5" }, message: "Standup" })],
    });
    render(<SessionWakeups sessionId="s1" />);

    const list = await screen.findByRole("list", { name: "Pending wake-ups" });
    expect(list).toHaveTextContent("Check the nightly build");
    // Shown in the Settings time zone (UTC here), in the viewer's locale.
    const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
      .format(new Date("2026-10-06T09:00:00Z"));
    expect(list).toHaveTextContent(expected);
    expect(list).toHaveTextContent("Repeats 0 9 * * 1-5");
    expect(mockApi.listSessionWakeups).toHaveBeenCalledWith("s1");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    mockApi.listSessionWakeups.mockResolvedValue({
      wakeups: [wakeup(), wakeup({ id: "wk-3", enabled: false, status: "missed", lastResult: "Missed: the server was not running" })],
    });
    const { container } = render(<SessionWakeups sessionId="s1" />);
    await screen.findByRole("list", { name: "Pending wake-ups" });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("cancels a pending wake-up and refreshes the list", async () => {
    mockApi.listSessionWakeups.mockResolvedValueOnce({ wakeups: [wakeup()] }).mockResolvedValue({ wakeups: [] });
    render(<SessionWakeups sessionId="s1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel wake-up wk-1" }));

    await waitFor(() => expect(mockApi.cancelSessionWakeup).toHaveBeenCalledWith("s1", "wk-1"));
    await waitFor(() => expect(screen.queryByRole("list", { name: "Pending wake-ups" })).not.toBeInTheDocument());
  });

  // Skipped/missed wake-ups say why they did not run, and can be dismissed.
  it("reports wake-ups that did not run", async () => {
    mockApi.listSessionWakeups.mockResolvedValue({
      wakeups: [
        wakeup({ id: "wk-s", enabled: false, status: "skipped", lastResult: "Skipped at x: the session is archived" }),
        wakeup({ id: "wk-d", enabled: false, status: "delivered" }),
      ],
    });
    render(<SessionWakeups sessionId="s1" />);

    const list = await screen.findByRole("list", { name: "Wake-ups that did not run" });
    expect(list).toHaveTextContent("the session is archived");
    expect(screen.queryByRole("button", { name: "Dismiss wake-up wk-d" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss wake-up wk-s" }));
    await waitFor(() => expect(mockApi.cancelSessionWakeup).toHaveBeenCalledWith("s1", "wk-s"));
  });

  it("schedules a one-time wake-up", async () => {
    render(<SessionWakeups sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    const submit = screen.getByRole("button", { name: "Schedule wake-up" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Look at the PR again" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "2026-10-06T09:00" } });
    expect(screen.getByText(/Times are in UTC/)).toBeInTheDocument();
    fireEvent.click(submit);

    await waitFor(() => expect(mockApi.createSessionWakeup).toHaveBeenCalledWith("s1", {
      message: "Look at the PR again",
      at: "2026-10-06T09:00",
    }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Schedule a wake-up" })).not.toBeInTheDocument());
    expect(mockApi.listSessionWakeups).toHaveBeenCalledTimes(2);
  });

  it("schedules a repeating wake-up and shows the server's error", async () => {
    mockApi.createSessionWakeup.mockRejectedValueOnce(new Error("Invalid cron expression \"nope\""));
    useStore.setState({ timeZone: "" });
    render(<SessionWakeups sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    fireEvent.click(screen.getByLabelText("Repeat (cron)"));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Daily check" } });
    fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "nope" } });
    expect(screen.getByText(/server's local time zone/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schedule wake-up" }));

    expect(await screen.findByRole("alert")).toHaveTextContent('Invalid cron expression "nope"');
    expect(mockApi.createSessionWakeup).toHaveBeenCalledWith("s1", { message: "Daily check", cron: "nope" });

    // Back to "Once" and closing the form clears the error.
    fireEvent.click(screen.getByLabelText("Once"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // A failed refresh keeps what is on screen instead of blanking it.
  it("keeps the last list when a refresh fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi.listSessionWakeups.mockResolvedValueOnce({ wakeups: [wakeup()] }).mockRejectedValue(new Error("offline"));
      render(<SessionWakeups sessionId="s1" />);
      await screen.findByRole("list", { name: "Pending wake-ups" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockApi.listSessionWakeups).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("list", { name: "Pending wake-ups" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows when a recurring wake-up has no next run", async () => {
    mockApi.listSessionWakeups.mockResolvedValue({
      wakeups: [wakeup({ schedule: { cron: "0 9 * * *" }, nextRunAt: undefined, lastResult: "Not armed: bad zone" })],
    });
    render(<SessionWakeups sessionId="s1" />);
    const list = await screen.findByRole("list", { name: "Pending wake-ups" });
    expect(list).toHaveTextContent("next not scheduled");
    expect(list).toHaveTextContent("Not armed: bad zone");
  });
});
