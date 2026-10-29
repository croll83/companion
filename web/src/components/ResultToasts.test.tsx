// @vitest-environment jsdom
/**
 * "Result ready" toasts: one per session that finished a turn off screen.
 * Clicking opens the session; the close button only dismisses; each closes
 * by itself after 10 s of the page being visible (a toast raised while the
 * user was away waits for them). Real store, fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../store.js";
import { ResultToasts, TOAST_MS } from "./ResultToasts.js";

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setVisibility("visible");
  useStore.setState({ resultToasts: [], sessionNames: new Map([["s1", "Fix the login"]]), sdkSessions: [] });
  window.location.hash = "#/";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ResultToasts", () => {
  it("renders nothing without toasts, and one toast per session with its title", () => {
    const { container } = render(<ResultToasts />);
    expect(container).toBeEmptyDOMElement();
    act(() => {
      useStore.getState().pushResultToast("s1");
      useStore.getState().pushResultToast("s2abcdef99");
      useStore.getState().pushResultToast("s1");
    });
    const region = screen.getByRole("region", { name: "Sessions with a new result" });
    expect(region).toBeInTheDocument();
    // A newer result of s1 replaced its older toast and moved it last.
    expect(screen.getAllByText(/Result ready/)).toHaveLength(2);
    expect(region.textContent).toMatch(/Session s2abcdef.*Fix the login/);
  });

  it("keeps at most three toasts", () => {
    render(<ResultToasts />);
    act(() => {
      for (const id of ["a1", "b2", "c3", "d4"]) useStore.getState().pushResultToast(id);
    });
    expect(useStore.getState().resultToasts.map((t) => t.sessionId)).toEqual(["b2", "c3", "d4"]);
  });

  it("opens the session on click and dismisses the toast", () => {
    render(<ResultToasts />);
    act(() => useStore.getState().pushResultToast("s1"));
    fireEvent.click(screen.getByRole("button", { name: /^Fix the login/ }));
    expect(window.location.hash).toBe("#/session/s1");
    expect(useStore.getState().resultToasts).toEqual([]);
  });

  it("the close button dismisses without opening", () => {
    render(<ResultToasts />);
    act(() => useStore.getState().pushResultToast("s1"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the notification of Fix the login" }));
    expect(useStore.getState().resultToasts).toEqual([]);
    expect(window.location.hash).toBe("#/");
  });

  it("closes by itself after 10 s of the page being visible", () => {
    vi.useFakeTimers();
    setVisibility("hidden");
    render(<ResultToasts />);
    act(() => useStore.getState().pushResultToast("s1"));
    act(() => { vi.advanceTimersByTime(TOAST_MS * 3); });
    expect(useStore.getState().resultToasts).toHaveLength(1);
    act(() => setVisibility("visible"));
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
    expect(useStore.getState().resultToasts).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(useStore.getState().resultToasts).toHaveLength(0);
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<ResultToasts />);
    act(() => useStore.getState().pushResultToast("s1"));
    expect(await axe(container)).toHaveNoViolations();
  });
});
