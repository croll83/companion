// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockRead = vi.fn();
const mockWrite = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    readConfigFile: (...args: unknown[]) => mockRead(...args),
    writeConfigFile: (...args: unknown[]) => mockWrite(...args),
  },
}));

import { ConfigFileEditor } from "./ConfigFileEditor.js";

const PATH = "/repo/.claude/settings.json";

function renderEditor(props: Partial<Parameters<typeof ConfigFileEditor>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ConfigFileEditor sessionId="s1" path={PATH} label="settings.json" onClose={onClose} onSaved={onSaved} {...props} />,
  );
  return { onClose, onSaved };
}

const textarea = () => screen.getByLabelText("Contents of settings.json") as HTMLTextAreaElement;

describe("ConfigFileEditor", () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockWrite.mockReset();
    mockRead.mockResolvedValue({ path: PATH, content: '{"a":1}', format: "json", readOnly: false });
    mockWrite.mockResolvedValue({ ok: true, path: PATH });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Loads through the session-scoped route and shows title, path and content.
  it("renders the file loaded via readConfigFile", async () => {
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    expect(mockRead).toHaveBeenCalledWith("s1", PATH);
    expect(screen.getByRole("dialog", { name: "settings.json" })).toBeInTheDocument();
    expect(screen.getAllByText(PATH).length).toBeGreaterThan(0);
  });

  it("shows the description instead of the path in the header when given", async () => {
    renderEditor({ description: "User instructions" });
    await waitFor(() => expect(screen.getByText("User instructions")).toBeInTheDocument());
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // Saving valid JSON writes through writeConfigFile and clears the dirty state.
  it("saves edited content and notifies onSaved", async () => {
    const { onSaved } = renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    fireEvent.change(textarea(), { target: { value: '{"a":2}' } });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(mockWrite).toHaveBeenCalledWith("s1", PATH, '{"a":2}'));
    await waitFor(() => expect(screen.queryByText("Unsaved")).not.toBeInTheDocument());
    expect(onSaved).toHaveBeenCalled();
  });

  // Invalid JSON is never sent; the error is clear and the user's text stays.
  it("rejects invalid JSON before saving and keeps the text", async () => {
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    fireEvent.change(textarea(), { target: { value: "{broken" } });
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid JSON, not saved/);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(textarea()).toHaveValue("{broken");
  });

  // Markdown is not JSON-validated; server errors (e.g. invalid TOML) surface.
  it("shows server-side save errors", async () => {
    mockRead.mockResolvedValue({ path: PATH, content: "a = 1", format: "toml", readOnly: false });
    mockWrite.mockRejectedValue(new Error("Invalid TOML: bad"));
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue("a = 1"));
    fireEvent.change(textarea(), { target: { value: "a = [" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid TOML: bad"));
    expect(textarea()).toHaveValue("a = [");
  });

  it("falls back to a generic message for non-Error failures", async () => {
    mockRead.mockResolvedValue({ path: PATH, content: "# md" });
    mockWrite.mockRejectedValue("nope");
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue("# md"));
    fireEvent.change(textarea(), { target: { value: "# md2" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to save"));
  });

  // Read-only files (synced skills, config.toml without a parser) cannot be edited.
  it("renders read-only files without a Save button", async () => {
    mockRead.mockResolvedValue({ path: PATH, content: "x", format: "markdown", readOnly: true });
    renderEditor();
    await waitFor(() => expect(screen.getByText("Read-only")).toBeInTheDocument());
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(textarea()).toHaveAttribute("readonly");
  });

  it("shows load errors", async () => {
    mockRead.mockRejectedValue(new Error("Not a known config file for this session"));
    renderEditor();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not a known config file"));
  });

  it("shows a generic message for non-Error load failures", async () => {
    mockRead.mockRejectedValue("boom");
    renderEditor();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Failed to read file"));
  });

  // Review finding: after a failed read the editor showed an empty, editable
  // textarea with Save, so a >2MB or unreadable file could be overwritten by
  // whatever the user typed. Neither the textarea nor Save may be offered.
  it("never offers to edit or save a file that failed to load", async () => {
    mockRead.mockRejectedValue(new Error("File too large (>2MB)"));
    renderEditor();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("File too large"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
    expect(screen.getByText(/could not be opened/)).toBeInTheDocument();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  // Closing with unsaved changes asks first; cancelling keeps the editor open.
  it("confirms before discarding unsaved changes", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onClose } = renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    fireEvent.change(textarea(), { target: { value: "{}" } });
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it("closes immediately when clean, including via the backdrop", async () => {
    const { onClose } = renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue('{"a":1}'));
    fireEvent.click(document.querySelector(".bg-black\\/40")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
