// @vitest-environment jsdom
/**
 * The Inbox tab of an embedded brain. Validates the notes of each status
 * (statement, kind, author, sources, date; the reason of a decision), the
 * filter buttons with their counts, Dismiss with an optional reason (sent to
 * the API, then the list reloads and the page is told), Include with a
 * comment for a note waiting for a person, Add source opening its form, and
 * errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainNote } from "../api.js";

const mockApi = vi.hoisted(() => ({ brainInbox: vi.fn(), dismissBrainNote: vi.fn(), includeBrainNote: vi.fn(), addBrainSource: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainInbox } from "./BrainInbox.js";

const waiting: BrainNote = {
  note_id: "N1",
  kind: "source_pointer",
  statement: "New source added from Companion: raw/sources/2026-10-14-manual.md. Read it and turn it into wiki pages.",
  new_page_hint: "manual",
  sources: ["raw:raw/sources/2026-10-14-manual.md"],
  author: "Companion",
  received_at: "2026-10-14T09:00:00.000Z",
  status: "pending",
};
const dismissed: BrainNote = { ...waiting, note_id: "N2", kind: "new_fact", statement: "", sources: [], pages: ["engine"], status: "discarded", status_reason: "Not needed", status_by: "user", status_changed_at: "2026-10-14T10:00:00.000Z" };

const held: BrainNote = { ...waiting, note_id: "N3", kind: "new_fact", statement: "The launch plan is dated 18 August 2026.", status: "needs_human", status_reason: "not decided in 2 runs, last 2026-10-15: source not available", status_by: "consolidation", status_changed_at: "2026-10-15T10:00:00.000Z", deferrals: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainInbox.mockImplementation(async (_slug: string, status: string) => ({
    counts: { pending: 1, discarded: 1, needs_human: 1 },
    notes: status === "pending" ? [waiting] : status === "discarded" ? [dismissed] : status === "needs_human" ? [held] : [],
  }));
  mockApi.dismissBrainNote.mockResolvedValue({ note_id: "N1", status: "discarded" });
  mockApi.includeBrainNote.mockResolvedValue({ ok: true, note_id: "N3", status: "pending" });
});

describe("BrainInbox", () => {
  it("shows the notes waiting for a person and includes one with a comment", async () => {
    const onChanged = vi.fn();
    render(<BrainInbox slug="work" onChanged={onChanged} />);
    await screen.findByText(/New source added/);
    fireEvent.click(screen.getByRole("button", { name: "Needs you (1)" }));
    const item = (await screen.findByText(/launch plan/)).closest("li")!;
    expect(item).toHaveTextContent("Waiting for you by consolidation");
    expect(within(item).getByRole("button", { name: "Dismiss…" })).toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: "Include…" }));
    const form = screen.getByRole("form", { name: "Include note" });
    fireEvent.change(within(form).getByLabelText(/Comment for the consolidation/), { target: { value: "I confirm it" } });
    fireEvent.click(within(form).getByRole("button", { name: "Include note" }));
    await waitFor(() => expect(mockApi.includeBrainNote).toHaveBeenCalledWith("work", "N3", "I confirm it"));
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("form", { name: "Include note" })).toBeNull());
  });

  it("offers no Include for a waiting note, and tells how many runs left it undecided", async () => {
    mockApi.brainInbox.mockResolvedValueOnce({ counts: { pending: 1 }, notes: [{ ...waiting, deferrals: 1 }] });
    render(<BrainInbox slug="work" />);
    const item = (await screen.findByText(/New source added/)).closest("li")!;
    expect(item).toHaveTextContent("Left undecided by 1 consolidation run.");
    expect(within(item).queryByRole("button", { name: "Include…" })).toBeNull();
  });

  it("renders the waiting notes with kind, author, target and sources", async () => {
    render(<BrainInbox slug="work" />);
    const item = (await screen.findByText(/New source added from Companion/)).closest("li")!;
    expect(item).toHaveTextContent("Source · Companion");
    expect(item).toHaveTextContent("new page manual");
    expect(item).toHaveTextContent("Sources: raw:raw/sources/2026-10-14-manual.md");
    expect(screen.getByRole("button", { name: "Waiting (1)" })).toHaveAttribute("aria-pressed", "true");
    expect(mockApi.brainInbox).toHaveBeenCalledWith("work", "pending");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainInbox slug="work" />);
    await screen.findByText(/New source added/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("dismisses a note with a reason, then reloads and tells the page", async () => {
    const onChanged = vi.fn();
    render(<BrainInbox slug="work" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss…" }));
    const form = screen.getByRole("form", { name: "Dismiss note" });
    fireEvent.change(within(form).getByLabelText("Reason (optional)"), { target: { value: " Duplicate " } });
    fireEvent.click(within(form).getByRole("button", { name: "Dismiss note" }));
    await waitFor(() => expect(mockApi.dismissBrainNote).toHaveBeenCalledWith("work", "N1", "Duplicate"));
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(mockApi.brainInbox).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Dismiss note" })).toBeNull());
  });

  it("dismisses without a reason, cancels, and shows a failed dismiss", async () => {
    render(<BrainInbox slug="work" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Dismiss note" })).toBeNull();
    mockApi.dismissBrainNote.mockRejectedValueOnce(new Error("the note is already discarded"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already discarded");
    expect(mockApi.dismissBrainNote).toHaveBeenCalledWith("work", "N1", undefined);
    expect(screen.getByRole("form", { name: "Dismiss note" })).toBeInTheDocument();
  });

  it("filters by status and shows the reason of a decided note", async () => {
    render(<BrainInbox slug="work" />);
    await screen.findByText(/New source added/);
    fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
    expect(await screen.findByText("Text erased.")).toBeInTheDocument();
    expect(screen.getByText(/Dismissed by user on .*: Not needed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accepted" }));
    expect(await screen.findByText("No notes here.")).toBeInTheDocument();
  });

  it("opens Add source, and reloads the waiting notes after one is added", async () => {
    mockApi.addBrainSource.mockResolvedValueOnce({ note_id: "N3", duplicate: false });
    render(<BrainInbox slug="work" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add source…" }));
    expect(screen.getByRole("form", { name: "Add source" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Link (URL)"));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "https://example.org/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(mockApi.brainInbox).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("form", { name: "Add source" })).toBeNull();
  });

  it("shows an error when the inbox cannot be read, and an empty inbox", async () => {
    mockApi.brainInbox.mockRejectedValueOnce(new Error("The brain is not running: start it first"));
    const { unmount } = render(<BrainInbox slug="work" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not running");
    unmount();
    mockApi.brainInbox.mockResolvedValueOnce({ counts: {}, notes: [] });
    render(<BrainInbox slug="work" />);
    expect(await screen.findByText("No notes waiting.")).toBeInTheDocument();
  });
});
