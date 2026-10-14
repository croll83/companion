// @vitest-environment jsdom
/**
 * "Adopt existing folder": the form, then (when the folder lacks SCHEMA.md
 * or index.md) what is missing with buttons that create it, then the brain
 * created and its wiki check. Validates that the brain is never created on
 * a folder that cannot run it, that fixes go through the API with the
 * brain's name and about text, and that errors are shown.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainAdoptCheck } from "../api.js";
import { embeddedBrain } from "../test-fixtures/brains.js";

const mockApi = vi.hoisted(() => ({ checkAdoptFolder: vi.fn(), createBrain: vi.fn(), brainLint: vi.fn(), fixBrainLint: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { AdoptBrainFlow } from "./AdoptBrainFlow.js";

const notReady: BrainAdoptCheck = {
  ok: true,
  path: "/home/me/notes",
  ready: false,
  advice: [
    { id: "schema-missing", level: "error", sentence: "There is no SCHEMA.md: the brain needs it to know the wiki's rules and tags.", paths: ["SCHEMA.md"], count: 1, fix: { id: "create-schema", label: "Create SCHEMA.md" } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.createBrain.mockResolvedValue(embeddedBrain({ embedded: { wikiDir: "/home/me/notes", autostart: true, redactSecrets: true, language: "auto" } }));
  mockApi.brainLint.mockResolvedValue({ ok: false, errors: 1, warnings: 0, pages: 3, advice: [{ id: "index-unlisted", level: "error", sentence: "3 pages are not listed in index.md.", paths: ["index.md"], count: 3, fix: { id: "index-pages", label: "List them in index.md" } }] });
});

function fill() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Notes" } });
  fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "/home/me/notes" } });
  fireEvent.change(screen.getByLabelText("What it is about"), { target: { value: "Sailing notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
}

describe("AdoptBrainFlow", () => {
  it("renders the form, then creates a ready folder's brain and shows its wiki check", async () => {
    mockApi.checkAdoptFolder.mockResolvedValueOnce({ ...notReady, ready: true, advice: [] });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AdoptBrainFlow onCreated={onCreated} onClose={onClose} />);
    expect(screen.getByRole("form", { name: "Embedded brain" })).toBeInTheDocument();
    fill();
    expect(await screen.findByText("3 pages are not listed in index.md.")).toBeInTheDocument();
    expect(mockApi.checkAdoptFolder).toHaveBeenCalledWith({ wikiDir: "/home/me/notes" });
    expect(mockApi.createBrain).toHaveBeenCalledWith(expect.objectContaining({ kind: "embedded", name: "Notes", wikiDir: "/home/me/notes" }));
    expect(onCreated).toHaveBeenCalled();
    const done = screen.getByRole("link", { name: "Done" });
    expect(done).toHaveAttribute("href", "#/brains/work");
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalled();
  });

  it("passes axe accessibility scan", async () => {
    mockApi.checkAdoptFolder.mockResolvedValueOnce(notReady);
    const { axe } = await import("vitest-axe");
    const { container } = render(<AdoptBrainFlow onCreated={vi.fn()} onClose={vi.fn()} />);
    fill();
    await screen.findByText(/There is no SCHEMA.md/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("offers to create what is missing, and creates the brain only once the folder is ready", async () => {
    mockApi.checkAdoptFolder
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce({ ok: true, path: "/home/me/notes", ready: true, advice: [], done: "SCHEMA.md created" });
    render(<AdoptBrainFlow onCreated={vi.fn()} onClose={vi.fn()} />);
    fill();
    expect(await screen.findByText(/is not a brain wiki yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create brain" })).toBeDisabled();
    expect(mockApi.createBrain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create SCHEMA.md" }));
    await waitFor(() => expect(mockApi.checkAdoptFolder).toHaveBeenLastCalledWith({ wikiDir: "/home/me/notes", fix: "create-schema", name: "Notes", about: "Sailing notes" }));
    expect(await screen.findByRole("status")).toHaveTextContent("SCHEMA.md created.");
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    await waitFor(() => expect(mockApi.createBrain).toHaveBeenCalled());
    expect(await screen.findByRole("link", { name: "Done" })).toBeInTheDocument();
  });

  it("goes back to the form, and shows errors", async () => {
    mockApi.checkAdoptFolder.mockResolvedValueOnce(notReady);
    render(<AdoptBrainFlow onCreated={vi.fn()} onClose={vi.fn()} />);
    fill();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(screen.getByRole("form", { name: "Embedded brain" })).toBeInTheDocument();
    mockApi.checkAdoptFolder.mockRejectedValueOnce(new Error("The folder /home/me/notes does not exist"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Notes" } });
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "/home/me/notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("does not exist");
  });
});
