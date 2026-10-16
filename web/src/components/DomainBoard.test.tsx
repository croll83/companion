// @vitest-environment jsdom
/**
 * The domain's Linear board: columns from the team's states (canceled behind
 * a toggle), cards with assignee, grouped labels, priority and linked
 * sessions, "Mine", Refresh and polling, moving an issue, and "Take it"
 * handing the issue to the Home page to start a session in this domain.
 * The API is mocked: no Linear call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BoardIssue, DomainBoard as Board } from "../api.js";

const mockApi = vi.hoisted(() => ({
  getDomainBoard: vi.fn(),
  moveDomainIssue: vi.fn(),
  takeDomainIssue: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BOARD_POLL_MS, DomainBoard } from "./DomainBoard.js";
import { takeLinearHandoff } from "../utils/linear-board.js";

const issue = (over: Partial<BoardIssue>): BoardIssue => ({
  id: "i1", identifier: "BSK-1", title: "Soak the release", url: "https://linear.app/bskts/issue/BSK-1", branchName: "marco/bsk-1",
  priority: 2, priorityLabel: "High", stateId: "st-todo", stateName: "Todo", stateType: "unstarted", updatedAt: "2026-10-15",
  assignee: null, labels: [], teamId: "team-bsk", teamKey: "BSK", teamName: "Bskts", ...over,
});

function board(over: Partial<Board> = {}): Board {
  return {
    link: { connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", projectId: "p", projectName: "Bskts", connectionName: "Bskts", workspaceName: "bskts" },
    team: { id: "team-bsk", key: "BSK", name: "Bskts" },
    states: [
      { id: "st-todo", name: "Todo", type: "unstarted", hidden: false },
      { id: "st-progress", name: "In Progress", type: "started", hidden: false },
      { id: "st-cancel", name: "Canceled", type: "canceled", hidden: true },
    ],
    viewer: { id: "u-marco", name: "Marco", avatarUrl: null },
    issues: [
      issue({ labels: [{ id: "l1", name: "soak 24h", color: "#f00", group: "Soak" }, { id: "l2", name: "bug", color: "" }] }),
      issue({ id: "i2", identifier: "BSK-2", title: "Ema's task", priority: 1, stateId: "st-progress", stateName: "In Progress", stateType: "started", assignee: { id: "u-ema", name: "Ema Rossi", avatarUrl: null } }),
      issue({ id: "i3", identifier: "BSK-3", title: "My task", priority: 0, stateId: "st-progress", stateName: "In Progress", stateType: "started", assignee: { id: "u-marco", name: "Marco", avatarUrl: "https://a/m.png" } }),
      issue({ id: "i4", identifier: "BSK-4", title: "Dropped", stateId: "st-cancel", stateType: "canceled" }),
    ],
    truncated: false,
    sessions: {
      i1: [{ sessionId: "s-1", name: "Brave Falcon", archived: false, backendType: "codex", domain: "herd" }],
      i3: [{ sessionId: "s-3", name: "Old run", archived: true, backendType: "claude", domain: "herd" }],
    },
    fetchedAt: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.location.hash = "#/domains/herd/board";
  mockApi.getDomainBoard.mockResolvedValue(board());
  mockApi.moveDomainIssue.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

const column = (name: RegExp) => screen.getByRole("region", { name });

describe("DomainBoard", () => {
  it("renders the columns and cards of the linked team", async () => {
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    expect(await screen.findByText("Soak the release")).toBeInTheDocument();
    expect(mockApi.getDomainBoard).toHaveBeenCalledWith("herd", false);
    expect(screen.getByText("BSK · Bskts · bskts")).toBeInTheDocument();
    // Canceled is hidden by default.
    expect(screen.queryByRole("region", { name: /Canceled/ })).toBeNull();
    const todo = column(/^Todo \(1\)/);
    const card = within(todo).getByRole("article", { name: "BSK-1 Soak the release" });
    // Group labels read "Group: label".
    expect(within(card).getByText("Soak: soak 24h")).toBeInTheDocument();
    expect(within(card).getByText("bug")).toBeInTheDocument();
    expect(within(card).getByText("High")).toBeInTheDocument();
    expect(within(card).getByText("Unassigned")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Brave Falcon" })).toHaveAttribute("href", "#/session/s-1");
    expect(within(card).getByText(/Codex/)).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Open in Linear/ })).toHaveAttribute("href", "https://linear.app/bskts/issue/BSK-1");
    // Urgent first inside a column; my started issue has no "Take it".
    const progress = column(/^In Progress \(2\)/);
    const cards = within(progress).getAllByRole("article");
    expect(cards[0]).toHaveAccessibleName("BSK-2 Ema's task");
    expect(within(cards[0]).getByText("Ema Rossi")).toBeInTheDocument();
    expect(within(cards[1]).queryByRole("button", { name: "Take it" })).toBeNull();
    expect(within(cards[1]).getByText(/archived/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("filters to my issues and shows canceled on demand", async () => {
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Soak the release")).toBeNull();
    expect(screen.getByText("My task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Show canceled" }));
    expect(within(column(/^Canceled \(1\)/)).getByText("Dropped")).toBeInTheDocument();
  });

  it("explains how to link a domain that has no Linear link", () => {
    render(<DomainBoard slug="herd" domainName="Baskets" linked={false} />);
    expect(screen.getByText("Baskets is not linked to Linear yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linear tab" })).toHaveAttribute("href", "#/domains/herd/linear");
    expect(mockApi.getDomainBoard).not.toHaveBeenCalled();
  });

  // The link may have been removed meanwhile (another tab): same explanation.
  it("switches to the explanation when the server says the domain is not linked", async () => {
    mockApi.getDomainBoard.mockRejectedValueOnce(new Error("This domain is not linked to Linear"));
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    expect(await screen.findByText("Baskets is not linked to Linear yet.")).toBeInTheDocument();
  });

  it("shows Linear errors and a truncated board", async () => {
    mockApi.getDomainBoard.mockRejectedValueOnce(new Error("Rate limited"));
    const { unmount } = render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Rate limited");
    unmount();
    mockApi.getDomainBoard.mockResolvedValueOnce(board({ truncated: true }));
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    expect(await screen.findByText(/most recently updated issues only/)).toBeInTheDocument();
  });

  // Refresh skips the server cache; polling re-reads every minute while visible.
  it("refreshes on demand and polls while the page is visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockApi.getDomainBoard).toHaveBeenCalledWith("herd", true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).not.toBeDisabled());
    const before = mockApi.getDomainBoard.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(BOARD_POLL_MS); });
    await waitFor(() => expect(mockApi.getDomainBoard.mock.calls.length).toBe(before + 1));
    // Hidden tab: no poll.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      await act(async () => { vi.advanceTimersByTime(BOARD_POLL_MS); });
      expect(mockApi.getDomainBoard.mock.calls.length).toBe(before + 1);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    }
  });

  it("moves an issue to another state and reloads", async () => {
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    fireEvent.change(screen.getByLabelText("Move BSK-1 to"), { target: { value: "st-progress" } });
    await waitFor(() => expect(mockApi.moveDomainIssue).toHaveBeenCalledWith("herd", "i1", "st-progress"));
    await waitFor(() => expect(mockApi.getDomainBoard).toHaveBeenCalledTimes(2));
  });

  it("shows an error when a move fails", async () => {
    mockApi.moveDomainIssue.mockRejectedValueOnce(new Error("No state"));
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    fireEvent.change(screen.getByLabelText("Move BSK-1 to"), { target: { value: "st-progress" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("No state");
  });

  // Take it → offer a session in this domain → the Home page gets the issue.
  it("takes an issue and hands it to the Home page to start a session", async () => {
    mockApi.takeDomainIssue.mockResolvedValueOnce({
      ok: true, moved: true, connectionId: "conn-bskts",
      issue: { ...issue({ stateId: "st-progress", stateName: "In Progress", stateType: "started" }), description: "Steps" },
    });
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    const card = screen.getByRole("article", { name: "BSK-1 Soak the release" });
    fireEvent.click(within(card).getByRole("button", { name: "Take it" }));
    const offer = await screen.findByRole("status");
    expect(offer).toHaveTextContent("BSK-1 is yours (In Progress). Start a session in Baskets linked to it?");
    expect(mockApi.takeDomainIssue).toHaveBeenCalledWith("herd", "i1");
    fireEvent.click(screen.getByRole("button", { name: "Start a session" }));
    expect(window.location.hash).toBe("#/");
    expect(takeLinearHandoff()).toMatchObject({
      domain: "herd", connectionId: "conn-bskts",
      issue: { identifier: "BSK-1", branchName: "marco/bsk-1", description: "Steps", connectionId: "conn-bskts" },
    });
  });

  it("can decline the session offer, and reports a failed take", async () => {
    mockApi.takeDomainIssue
      .mockResolvedValueOnce({ ok: true, moved: false, connectionId: "c", issue: { ...issue({}), description: "" } })
      .mockRejectedValueOnce(new Error("not an issue of team BSK"));
    render(<DomainBoard slug="herd" domainName="Baskets" linked />);
    await screen.findByText("Soak the release");
    fireEvent.click(within(screen.getByRole("article", { name: "BSK-1 Soak the release" })).getByRole("button", { name: "Take it" }));
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(within(screen.getByRole("article", { name: "BSK-2 Ema's task" })).getByRole("button", { name: "Take it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not an issue of team BSK");
    expect(sessionStorage.getItem("cc-linear-handoff")).toBeNull();
  });
});
