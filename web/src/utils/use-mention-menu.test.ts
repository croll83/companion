// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

const mockListPrompts = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    listPrompts: (...args: unknown[]) => mockListPrompts(...args),
  },
}));

import { useMentionMenu, looksLikeFileToken, filterPromptsByQuery } from "./use-mention-menu.js";

const samplePrompts = [
  { id: "1", name: "review", content: "Please review this code", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
  { id: "2", name: "refactor", content: "Refactor this module", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
  { id: "3", name: "test-review", content: "Review the tests", scope: "global" as const, createdAt: Date.now(), updatedAt: Date.now() },
];

describe("useMentionMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPrompts.mockResolvedValue(samplePrompts);
  });

  it("returns closed menu when no @ is typed", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello world", caretPos: 11, cwd: "/repo" }),
    );
    // Wait for prompt loading to finish
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(false);
    expect(result.current.mentionContext).toBe(null);
  });

  it("detects @ at start of text", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.mentionContext).toEqual({ query: "", start: 0, end: 1 });
  });

  it("detects @ after whitespace", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello @rev", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.mentionContext).toEqual({ query: "rev", start: 6, end: 10 });
  });

  it("does not detect @ in the middle of a word", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "email@test", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(false);
    expect(result.current.mentionContext).toBe(null);
  });

  it("filters prompts with startsWith priority", async () => {
    // Type @rev — should match "review" (startsWith) first, then "test-review" (includes)
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@rev", caretPos: 4, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
    expect(result.current.filteredPrompts.map((p) => p.name)).toEqual(["review", "test-review"]);
  });

  it("shows all prompts when @ is typed without a query", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.filteredPrompts).toHaveLength(3);
  });

  it("selectPrompt returns correct nextText and nextCursor", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "hello @rev", caretPos: 10, cwd: "/repo" }),
    );
    await act(async () => {});

    const output = result.current.selectPrompt(samplePrompts[0]);
    // "hello " + "Please review this code " = "hello Please review this code "
    expect(output.nextText).toBe("hello Please review this code ");
    // Cursor should be at end of inserted content + space
    expect(output.nextCursor).toBe("hello Please review this code ".length);
  });

  it("closes the menu when enabled is false", async () => {
    const { result, rerender } = renderHook(
      (props) => useMentionMenu(props),
      { initialProps: { text: "@", caretPos: 1, cwd: "/repo", enabled: true } },
    );
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);

    rerender({ text: "@", caretPos: 1, cwd: "/repo", enabled: false });
    expect(result.current.mentionMenuOpen).toBe(false);
  });

  it("loads prompts on mount via api.listPrompts", async () => {
    renderHook(() =>
      useMentionMenu({ text: "", caretPos: 0, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo");
  });

  it("reloads prompts when cwd changes", async () => {
    const { rerender } = renderHook(
      (props) => useMentionMenu(props),
      { initialProps: { text: "", caretPos: 0, cwd: "/repo-a" } },
    );
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo-a");

    rerender({ text: "", caretPos: 0, cwd: "/repo-b" });
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledWith("/repo-b");
  });

  it("filters out prompts with empty names", async () => {
    mockListPrompts.mockResolvedValue([
      ...samplePrompts,
      { id: "4", name: "  ", content: "empty name", scope: "global", createdAt: Date.now(), updatedAt: Date.now() },
    ]);
    const { result } = renderHook(() =>
      useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }),
    );
    await act(async () => {});
    // The empty-name prompt should be filtered out
    expect(result.current.filteredPrompts).toHaveLength(3);
  });
});

describe("looksLikeFileToken", () => {
  // These guard the @file habit of Claude Code / Codex: such tokens must not
  // open the prompt menu (and so can never swallow Enter).
  it("treats tokens with a path separator as files", () => {
    expect(looksLikeFileToken("src/foo.ts", samplePrompts)).toBe(true);
    expect(looksLikeFileToken("src\\foo", samplePrompts)).toBe(true);
    expect(looksLikeFileToken("~/notes", samplePrompts)).toBe(true);
  });

  it("treats tokens ending in a dot extension as files, even half-typed", () => {
    expect(looksLikeFileToken("package.json", samplePrompts)).toBe(true);
    expect(looksLikeFileToken("README.", samplePrompts)).toBe(true);
  });

  it("keeps plain words and the empty query as prompt tokens", () => {
    expect(looksLikeFileToken("", samplePrompts)).toBe(false);
    expect(looksLikeFileToken("review", samplePrompts)).toBe(false);
    expect(looksLikeFileToken("fix-tests", samplePrompts)).toBe(false);
  });

  it("keeps a dotted token that exactly names a saved prompt", () => {
    // A prompt called "v1.2" must stay reachable through @v1.2.
    const prompts = [{ ...samplePrompts[0], id: "9", name: "V1.2" }];
    expect(looksLikeFileToken("v1.2", prompts)).toBe(false);
  });
});

describe("filterPromptsByQuery", () => {
  it("orders exact name, then prefix, then substring matches", () => {
    // The exact name comes first even when a prefix match is newer (earlier
    // in the server's updatedAt order).
    const prompts = [
      { ...samplePrompts[0], id: "a", name: "review-pr" },
      { ...samplePrompts[0], id: "b", name: "test-review" },
      { ...samplePrompts[0], id: "c", name: "review" },
      { ...samplePrompts[0], id: "d", name: "other" },
    ];
    expect(filterPromptsByQuery(prompts, "Review").map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("returns every prompt for an empty query", () => {
    expect(filterPromptsByQuery(samplePrompts, "")).toBe(samplePrompts);
  });
});

describe("useMentionMenu behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPrompts.mockResolvedValue(samplePrompts);
  });

  function keyEvent(key: string, shiftKey = false) {
    return { key, shiftKey, preventDefault: vi.fn() };
  }

  it("does not open for a file-like @token", async () => {
    const { result } = renderHook(() =>
      useMentionMenu({ text: "see @src/a.ts", caretPos: 13, cwd: "/repo" }),
    );
    await act(async () => {});
    expect(result.current.mentionContext).toBe(null);
    expect(result.current.mentionMenuOpen).toBe(false);
  });

  it("refreshes the prompt list every time the menu opens", async () => {
    // Prompts saved after mount must appear without changing cwd.
    const { rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "", caretPos: 0, cwd: "/repo" },
    });
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledTimes(1);

    rerender({ text: "@", caretPos: 1, cwd: "/repo" });
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledTimes(2);

    rerender({ text: "@ ", caretPos: 2, cwd: "/repo" });
    await act(async () => {});
    rerender({ text: "@ @", caretPos: 3, cwd: "/repo" });
    await act(async () => {});
    expect(mockListPrompts).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale response that resolves after a newer request", async () => {
    // A slow fetch for the old cwd must not overwrite the new cwd's prompts.
    let resolveOld: (v: unknown) => void = () => {};
    mockListPrompts.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    mockListPrompts.mockResolvedValueOnce([samplePrompts[1]]);
    const { result, rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "", caretPos: 0, cwd: "/old" },
    });
    rerender({ text: "", caretPos: 0, cwd: "/new" });
    await act(async () => {});
    await act(async () => { resolveOld(samplePrompts); });
    expect(result.current.savedPrompts.map((p) => p.name)).toEqual(["refactor"]);
    expect(result.current.promptsLoading).toBe(false);
  });

  it("ignores a stale failure that arrives after a newer request", async () => {
    let rejectOld: (e: unknown) => void = () => {};
    mockListPrompts.mockImplementationOnce(() => new Promise((_r, j) => { rejectOld = j; }));
    mockListPrompts.mockResolvedValueOnce([samplePrompts[1]]);
    const { result, rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "", caretPos: 0, cwd: "/old" },
    });
    rerender({ text: "", caretPos: 0, cwd: "/new" });
    await act(async () => {});
    await act(async () => { rejectOld(new Error("late")); });
    expect(result.current.savedPrompts.map((p) => p.name)).toEqual(["refactor"]);
  });

  it("clears the list when loading fails", async () => {
    mockListPrompts.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }));
    await act(async () => {});
    expect(result.current.savedPrompts).toEqual([]);
    expect(result.current.promptsLoading).toBe(false);
  });

  it("does not consume keys while the menu is closed", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "hi", caretPos: 2, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets Enter through for a bare @ and for partial matches", async () => {
    // The core fix: suggestions alone never turn Enter into a selection.
    const { result, rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "@", caretPos: 1, cwd: "/repo" },
    });
    await act(async () => {});
    const onSelect = vi.fn();
    const e = keyEvent("Enter");
    expect(result.current.handleMentionKeyDown(e, onSelect)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();

    rerender({ text: "@rev", caretPos: 4, cwd: "/repo" });
    await act(async () => {});
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("lets Enter through when nothing matches, but Tab stays in the composer", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@zzz", caretPos: 4, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(false);
    expect(result.current.handleMentionKeyDown(keyEvent("ArrowDown"), onSelect)).toBe(false);
    const tab = keyEvent("Tab");
    expect(result.current.handleMentionKeyDown(tab, onSelect)).toBe(true);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Enter selects an exact name match", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@Review", caretPos: 7, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(samplePrompts[0]);
  });

  it("Enter selects the highlighted prompt after arrow navigation (wrapping both ways)", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    act(() => { result.current.handleMentionKeyDown(keyEvent("ArrowUp"), onSelect); });
    expect(result.current.mentionMenuIndex).toBe(2);
    act(() => { result.current.handleMentionKeyDown(keyEvent("ArrowDown"), onSelect); });
    expect(result.current.mentionMenuIndex).toBe(0);
    act(() => { result.current.handleMentionKeyDown(keyEvent("ArrowDown"), onSelect); });
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(samplePrompts[1]);
  });

  it("Shift+Enter is never consumed, even after navigating", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    act(() => { result.current.handleMentionKeyDown(keyEvent("ArrowDown"), onSelect); });
    expect(result.current.handleMentionKeyDown(keyEvent("Enter", true), onSelect)).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hovering counts as navigation", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@", caretPos: 1, cwd: "/repo" }));
    await act(async () => {});
    act(() => { result.current.hoverPrompt(2); });
    const onSelect = vi.fn();
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), onSelect)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(samplePrompts[2]);
  });

  it("typing more of the token resets a previous navigation", async () => {
    // The list changed, so the old highlight is no longer a deliberate pick.
    const { result, rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "@", caretPos: 1, cwd: "/repo" },
    });
    await act(async () => {});
    act(() => { result.current.hoverPrompt(1); });
    rerender({ text: "@re", caretPos: 3, cwd: "/repo" });
    await act(async () => {});
    expect(result.current.mentionMenuIndex).toBe(0);
    expect(result.current.handleMentionKeyDown(keyEvent("Enter"), vi.fn())).toBe(false);
  });

  it("Tab selects the highlighted prompt without navigation", async () => {
    const { result } = renderHook(() => useMentionMenu({ text: "@ref", caretPos: 4, cwd: "/repo" }));
    await act(async () => {});
    const onSelect = vi.fn();
    expect(result.current.handleMentionKeyDown(keyEvent("Tab"), onSelect)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(samplePrompts[1]);
  });

  it("Escape closes the menu until the caret leaves the token", async () => {
    const { result, rerender } = renderHook((props) => useMentionMenu(props), {
      initialProps: { text: "@re", caretPos: 3, cwd: "/repo" },
    });
    await act(async () => {});
    act(() => { result.current.handleMentionKeyDown(keyEvent("Escape"), vi.fn()); });
    expect(result.current.mentionMenuOpen).toBe(false);

    // Still the same token: stays closed.
    rerender({ text: "@rev", caretPos: 4, cwd: "/repo" });
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(false);

    // Leave the token, then start a new one: opens again.
    rerender({ text: "@rev ", caretPos: 5, cwd: "/repo" });
    await act(async () => {});
    rerender({ text: "@rev @", caretPos: 6, cwd: "/repo" });
    await act(async () => {});
    expect(result.current.mentionMenuOpen).toBe(true);
  });
});
