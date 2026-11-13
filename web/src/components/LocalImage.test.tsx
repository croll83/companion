// @vitest-environment jsdom
/**
 * Images on the machine running Companion, in the chat (real react-markdown):
 *  - an image the model wrote and put in its answer as an absolute path is
 *    loaded through /fs/raw (api.getFileBlob) instead of the browser asking
 *    Companion's origin for a filesystem path (the broken icon);
 *  - it is loaded once: a new render of the message (streaming, polling) keeps
 *    the same <img> and does not fetch again (the chat used to jump);
 *  - a missing file shows its name, and is not asked again at every render;
 *  - relative images of a markdown file resolve against its folder;
 *  - a click opens the file viewer;
 *  - a user message from the history shows its saved attachments (images as
 *    thumbnails, other files as a chip) instead of losing them.
 * The API is mocked; the store is the real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ChatMessage } from "../types.js";

const mockApi = vi.hoisted(() => ({ getFileBlob: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { LocalImage, resetLocalImageCache } from "./LocalImage.js";
import { MarkdownContent, MessageBubble } from "./MessageBubble.js";
import { useStore } from "../store.js";

const message = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", role: "assistant", content, timestamp: Date.now(), ...extra });

beforeEach(() => {
  resetLocalImageCache();
  vi.clearAllMocks();
  mockApi.getFileBlob.mockImplementation(async (path: string) => `blob:${path}`);
  useStore.setState({ viewerFilePath: null } as never);
});

describe("images in the chat", () => {
  it("loads an absolute-path image once and keeps it across renders", async () => {
    const { rerender } = render(<MessageBubble message={message("Drawing:\n\n![basetta](/home/u/docs/img/basetta.png)")} />);
    expect(screen.getByRole("img", { name: "Loading basetta" })).toBeInTheDocument();
    const img = await screen.findByAltText("basetta");
    expect(img).toHaveAttribute("src", "blob:/home/u/docs/img/basetta.png");
    rerender(<MessageBubble message={message("Drawing:\n\n![basetta](/home/u/docs/img/basetta.png)\n\nMore text arrives.")} />);
    expect(screen.getByAltText("basetta")).toBe(img);
    expect(mockApi.getFileBlob).toHaveBeenCalledTimes(1);
  });

  it("leaves images of other sites to the browser", () => {
    render(<MarkdownContent text="![logo](https://example.com/logo.png)" />);
    expect(screen.getByAltText("logo")).toHaveAttribute("src", "https://example.com/logo.png");
    expect(mockApi.getFileBlob).not.toHaveBeenCalled();
  });

  it("opens the file viewer on click", async () => {
    render(<MarkdownContent text="![cover](/home/u/cover.png)" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open cover" }));
    expect(useStore.getState().viewerFilePath).toBe("/home/u/cover.png");
  });

  it("shows the name of a missing file and does not ask again at every render", async () => {
    mockApi.getFileBlob.mockRejectedValue(new Error("File not found"));
    const { unmount } = render(<MarkdownContent text="![x](/home/u/missing.png)" />);
    expect(await screen.findByText("Image not available: missing.png")).toBeInTheDocument();
    unmount();
    render(<MarkdownContent text="![x](/home/u/missing.png)" />);
    expect(screen.getByText("Image not available: missing.png")).toBeInTheDocument();
    expect(mockApi.getFileBlob).toHaveBeenCalledTimes(1);
  });

  it("asks again for a failed file after a while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      mockApi.getFileBlob.mockRejectedValueOnce(new Error("not yet"));
      const { unmount } = render(<LocalImage path="/home/u/late.png" />);
      await screen.findByText("Image not available: late.png");
      unmount();
      vi.setSystemTime(Date.now() + 31_000);
      render(<LocalImage path="/home/u/late.png" />);
      expect(await screen.findByAltText("late.png")).toHaveAttribute("src", "blob:/home/u/late.png");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the relative images of a markdown file against its folder", async () => {
    render(<MarkdownContent text="![zona](img/zona.png) ![up](../up.png)" baseDir="/home/u/docs" />);
    expect(await screen.findByAltText("zona")).toHaveAttribute("src", "blob:/home/u/docs/img/zona.png");
    expect(await screen.findByAltText("up")).toHaveAttribute("src", "blob:/home/u/up.png");
  });

  it("shows the saved attachments of a user message from the history", async () => {
    const msg: ChatMessage = {
      id: "u1",
      role: "user",
      content: "Board",
      timestamp: Date.now(),
      attachments: [
        { path: "/home/u/.companion/uploads/s1/1-board.jpg", name: "board.jpg", media_type: "image/jpeg" },
        { path: "/home/u/.companion/uploads/s1/2-sheet.pdf", name: "sheet.pdf", media_type: "application/pdf" },
      ],
    };
    render(<MessageBubble message={msg} />);
    expect(await screen.findByAltText("board.jpg")).toHaveAttribute("src", "blob:/home/u/.companion/uploads/s1/1-board.jpg");
    fireEvent.click(screen.getByRole("button", { name: /sheet\.pdf/ }));
    expect(useStore.getState().viewerFilePath).toBe("/home/u/.companion/uploads/s1/2-sheet.pdf");
  });

  it("prefers the inline images of a message just sent", () => {
    const msg: ChatMessage = {
      id: "u2",
      role: "user",
      content: "x",
      timestamp: Date.now(),
      images: [{ media_type: "image/png", data: "AAAA" }],
      attachments: [{ path: "/home/u/a.png", name: "a.png", media_type: "image/png" }],
    };
    render(<MessageBubble message={msg} />);
    expect(mockApi.getFileBlob).not.toHaveBeenCalled();
  });

  it("follows a change of path", async () => {
    const { rerender } = render(<LocalImage path="/home/u/one.png" />);
    await screen.findByAltText("one.png");
    await act(async () => { rerender(<LocalImage path="/home/u/two.png" />); });
    await waitFor(() => expect(screen.getByAltText("two.png")).toHaveAttribute("src", "blob:/home/u/two.png"));
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    mockApi.getFileBlob.mockImplementation(async (path: string) => {
      if (path.endsWith("bad.png")) throw new Error("no");
      return `blob:${path}`;
    });
    const { container } = render(
      <div>
        <LocalImage path="/home/u/ok.png" alt="ok" />
        <LocalImage path="/home/u/bad.png" />
      </div>,
    );
    await screen.findByAltText("ok");
    await screen.findByText("Image not available: bad.png");
    expect(await axe(container)).toHaveNoViolations();
  });
});
