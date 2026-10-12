// @vitest-environment jsdom
/**
 * Sheet is the large panel of the Domains page views (MCP, skills, plugins)
 * on phones: a titled dialog that closes with ×, a backdrop click or Escape,
 * after a short exit animation; clicks inside never close it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Sheet } from "./Sheet.js";

afterEach(() => vi.useRealTimers());

describe("Sheet", () => {
  it("renders a titled dialog with its content", () => {
    render(<Sheet title="Herd · MCP servers" onClose={vi.fn()}><p>content</p></Sheet>);
    expect(screen.getByRole("dialog", { name: "Herd · MCP servers" })).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    render(<Sheet title="Sheet" onClose={vi.fn()}><p>x</p></Sheet>);
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("closes once with ×, Escape or the backdrop, but not from inside", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<Sheet title="S" onClose={onClose}><button type="button">inside</button></Sheet>);
    fireEvent.click(screen.getByRole("button", { name: "inside" }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(200); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on a backdrop click", () => {
    vi.useFakeTimers();
    const onEsc = vi.fn();
    const { unmount } = render(<Sheet title="A" onClose={onEsc}><p>a</p></Sheet>);
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(200); });
    expect(onEsc).toHaveBeenCalledTimes(1);
    unmount();
    const onBackdrop = vi.fn();
    render(<Sheet title="B" onClose={onBackdrop}><p>b</p></Sheet>);
    fireEvent.click(screen.getByTestId("sheet-backdrop"));
    act(() => { vi.advanceTimersByTime(200); });
    expect(onBackdrop).toHaveBeenCalledTimes(1);
  });
});
