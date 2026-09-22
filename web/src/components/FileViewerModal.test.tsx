// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useStore } from "../store.js";

// The viewer renders through the chat's MarkdownContent so both get the same
// element styling; mock the library underneath it, not the component.
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

const readFile = vi.hoisted(() => vi.fn());
const getFileBlob = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ api: { readFile, getFileBlob } }));

import { FileViewerModal } from "./FileViewerModal.js";

function open(path: string) {
  useStore.getState().openFileViewer(path);
}

describe("FileViewerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.getState().closeFileViewer();
    global.URL.createObjectURL = vi.fn(() => "blob:fake");
    global.URL.revokeObjectURL = vi.fn();
  });

  it("renders nothing until a file is opened", () => {
    const { container } = render(<FileViewerModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders markdown through /fs/read", async () => {
    readFile.mockResolvedValue({ path: "/h/a.md", content: "# Titolo" });
    render(<FileViewerModal />);
    open("/h/a.md");
    await waitFor(() => expect(screen.getByTestId("md")).not.toBeNull());
    expect(readFile).toHaveBeenCalledWith("/h/a.md");
    expect(screen.getByTestId("md").textContent).toBe("# Titolo");
  });

  it("renders text files as monospace, not markdown", async () => {
    readFile.mockResolvedValue({ path: "/h/s.log", content: "line one" });
    const { container } = render(<FileViewerModal />);
    open("/h/s.log");
    await waitFor(() => expect(container.querySelector("pre")).not.toBeNull());
    expect(screen.queryByTestId("md")).toBeNull();
  });

  it("loads images as a blob (so auth headers are sent)", async () => {
    getFileBlob.mockResolvedValue("blob:fake");
    const { container } = render(<FileViewerModal />);
    open("/h/pic.png");
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(getFileBlob).toHaveBeenCalledWith("/h/pic.png");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("offers download instead of previewing an unsupported type", async () => {
    render(<FileViewerModal />);
    open("/h/archive.zip");
    await waitFor(() => expect(screen.getByText(/can't be previewed/)).not.toBeNull());
    expect(readFile).not.toHaveBeenCalled();
    expect(getFileBlob).not.toHaveBeenCalled();
  });

  it("surfaces a read failure instead of hanging on 'Loading'", async () => {
    // e.g. the path is outside the server's allowed directories (403).
    readFile.mockRejectedValue(new Error("Path outside allowed directories"));
    render(<FileViewerModal />);
    open("/etc/shadow.md");
    await waitFor(() => expect(screen.getByRole("alert")).not.toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("Path outside allowed");
  });

  it("closes on the close button and on Escape", async () => {
    readFile.mockResolvedValue({ path: "/h/a.md", content: "x" });
    render(<FileViewerModal />);
    open("/h/a.md");
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(useStore.getState().viewerFilePath).toBeNull());

    open("/h/a.md");
    await waitFor(() => expect(screen.getByRole("dialog")).not.toBeNull());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(useStore.getState().viewerFilePath).toBeNull());
  });

  it("renders markdown through the shared, styled renderer", async () => {
    // A bare <Markdown> loses headings/bold/lists to Tailwind's preflight, so
    // the viewer must go through MarkdownContent like the chat does. Its
    // wrapper is the only place that carries markdown-body.
    readFile.mockResolvedValue({ path: "/h/a.md", content: "# T\n\n**b**\n\n- x" });
    render(<FileViewerModal />);
    open("/h/a.md");
    await waitFor(() => expect(screen.getByTestId("md")).not.toBeNull());
    expect(screen.getByTestId("md").closest(".markdown-body")).not.toBeNull();
  });
});
