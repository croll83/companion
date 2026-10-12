// @vitest-environment jsdom
/**
 * useMediaQuery tells the Domains page whether it is on a phone (list, then
 * a domain with sheets) or a desktop (two columns with tabs), following
 * window resizes; without matchMedia it answers the fallback.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "./use-media-query.js";

const original = window.matchMedia;
afterEach(() => { window.matchMedia = original; });

function fakeMatchMedia(initial: boolean) {
  let listener: (() => void) | null = null;
  const mql = {
    matches: initial,
    addEventListener: vi.fn((_: string, cb: () => void) => { listener = cb; }),
    removeEventListener: vi.fn(),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return { mql, fire: (matches: boolean) => { mql.matches = matches; listener?.(); } };
}

describe("useMediaQuery", () => {
  it("answers the fallback without matchMedia", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(renderHook(() => useMediaQuery("(min-width: 1024px)", true)).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery("(min-width: 1024px)")).result.current).toBe(false);
  });

  it("follows the query as the window changes, and stops listening on unmount", () => {
    const { mql, fire } = fakeMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    act(() => fire(true));
    expect(result.current).toBe(true);
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});
