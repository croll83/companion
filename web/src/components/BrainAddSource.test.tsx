// @vitest-environment jsdom
/**
 * "Add source". Validates the three kinds: pasted text (name and text
 * required, 1 MB cap), a markdown or text file (read in the browser, other
 * files and files over 1 MB refused with a reason: PDFs are out of scope),
 * and an URL (a note only); the optional note; what the API gets; the
 * confirmation; and errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ addBrainSource: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainAddSource, MAX_SOURCE_BYTES } from "./BrainAddSource.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.addBrainSource.mockResolvedValue({ path: "raw/sources/2026-10-14-manual.md", note_id: "N1", duplicate: false });
});

function setup() {
  const onAdded = vi.fn();
  const onCancel = vi.fn();
  render(<BrainAddSource slug="work" onAdded={onAdded} onCancel={onCancel} />);
  return { onAdded, onCancel };
}

function file(name: string, text: string, size?: number): File {
  const f = new File([text], name, { type: "text/plain" });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  if (!("text" in f)) Object.defineProperty(f, "text", { value: async () => text });
  return f;
}

describe("BrainAddSource", () => {
  it("renders the paste form and saves a pasted text with a note", async () => {
    const { onAdded } = setup();
    expect(screen.getByRole("form", { name: "Add source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " manual " } });
    expect(screen.getByText("Paste the text of the source.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "# Manual\n\nOil every 250 h." } });
    fireEvent.change(screen.getByLabelText("Note for the consolidation (optional)"), { target: { value: " engine page " } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(mockApi.addBrainSource).toHaveBeenCalledWith("work", { name: "manual", text: "# Manual\n\nOil every 250 h.", note: "engine page" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as raw/sources/2026-10-14-manual.md.");
    expect(onAdded).toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainAddSource slug="work" onAdded={vi.fn()} onCancel={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByLabelText("Upload a file"));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("refuses a pasted text over 1 MB", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "big" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "x".repeat(MAX_SOURCE_BYTES + 1) } });
    expect(screen.getByText("The source is larger than 1 MB.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add source" })).toBeDisabled();
  });

  it("reads a markdown file, and refuses PDFs and files over 1 MB", async () => {
    setup();
    fireEvent.click(screen.getByLabelText("Upload a file"));
    const input = screen.getByLabelText("File");
    fireEvent.change(input, { target: { files: [file("report.pdf", "%PDF")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Only markdown or text files");
    fireEvent.change(input, { target: { files: [file("huge.md", "x", MAX_SOURCE_BYTES + 1)] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 1 MB");
    fireEvent.change(input, { target: { files: [file("Engine Manual.md", "# Engine")] } });
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Engine Manual.md"));
    expect(screen.getByText("1 KB read from the file.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(mockApi.addBrainSource).toHaveBeenCalledWith("work", { name: "Engine Manual.md", text: "# Engine" }));
  });

  it("records an URL as a note only", async () => {
    mockApi.addBrainSource.mockResolvedValueOnce({ note_id: "N2", duplicate: false });
    setup();
    fireEvent.click(screen.getByLabelText("Link (URL)"));
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "ftp://x" } });
    expect(screen.getByText("An http:// or https:// address is required.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: " https://example.org/guide " } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(mockApi.addBrainSource).toHaveBeenCalledWith("work", { url: "https://example.org/guide" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Recorded as a note in the inbox");
  });

  it("shows the API's error, and closes", async () => {
    mockApi.addBrainSource.mockRejectedValueOnce(new Error("the note was rejected: contains possible personal data (email)"));
    const { onCancel } = setup();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "n" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("personal data");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
