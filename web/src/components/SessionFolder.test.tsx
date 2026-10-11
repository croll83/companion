// @vitest-environment jsdom
/**
 * SessionFolder ("Change folder") moves the focused session to another
 * folder: it previews the move (GET /sessions/:id/folder), names the memory
 * the session keeps (domain memory, or the pinned folder memory of a legacy
 * session), warns when a turn would be interrupted, then applies it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  previewSessionFolder: vi.fn(),
  changeSessionFolder: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));
vi.mock("./FolderPicker.js", () => ({
  FolderPicker: ({ onSelect }: { onSelect: (p: string) => void }) => (
    <button type="button" onClick={() => onSelect("/picked")}>pick folder</button>
  ),
}));

import { SessionFolder } from "./SessionFolder.js";
import { useStore } from "../store.js";

const preview = { ok: true, from: "/w", to: "/next", backend: "claude", interruptsWork: true, memory: { dir: "/mem/w", notes: 2 } };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.previewSessionFolder.mockResolvedValue(preview);
  mockApi.changeSessionFolder.mockResolvedValue(preview);
  // The folder shown is the session's own (stable) folder, not the runtime cwd.
  useStore.getState().setSdkSessions([{ sessionId: "s1", state: "connected", cwd: "/w/sub", folder: "/w", createdAt: 1 } as never]);
});

describe("SessionFolder", () => {
  it("renders the session's own folder", () => {
    render(<SessionFolder sessionId="s1" />);
    expect(screen.getByText("/w")).toBeInTheDocument();
  });

  it("passes axe accessibility scan in the edit and review states", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionFolder sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("group", { name: "Review the folder change" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("previews, names the memory kept and the interruption, then moves", async () => {
    render(<SessionFolder sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    fireEvent.change(screen.getByLabelText("New folder"), { target: { value: "/next" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/keeps \/mem\/w \(2 notes\)/)).toBeInTheDocument();
    expect(screen.getByText(/interrupts what it is doing/)).toBeInTheDocument();
    expect(mockApi.previewSessionFolder).toHaveBeenCalledWith("s1", "/next");
    fireEvent.click(screen.getByRole("button", { name: "Move and restart" }));
    expect(await screen.findByRole("status")).toHaveTextContent("/next");
    expect(mockApi.changeSessionFolder).toHaveBeenCalledWith("s1", "/next");
  });

  it("uses the folder picker and shows preview errors", async () => {
    mockApi.previewSessionFolder.mockRejectedValue(new Error("Folder does not exist"));
    render(<SessionFolder sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    fireEvent.click(screen.getByRole("button", { name: "pick folder" }));
    expect(screen.getByLabelText("New folder")).toHaveValue("/picked");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Folder does not exist");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Change folder" })).toBeInTheDocument();
  });

  it("goes back from the review and reports a failed move", async () => {
    mockApi.changeSessionFolder.mockRejectedValue(new Error("restart failed"));
    mockApi.previewSessionFolder.mockResolvedValue({ ...preview, interruptsWork: false, memory: undefined });
    render(<SessionFolder sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("restart failed");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("New folder")).toHaveValue("/next");
  });
});
