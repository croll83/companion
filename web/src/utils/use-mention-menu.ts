import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { api, type SavedPrompt } from "../api.js";

export interface MentionContext {
  query: string;
  start: number;
  end: number;
}

interface UseMentionMenuOptions {
  text: string;
  caretPos: number;
  cwd: string | undefined;
  enabled?: boolean;
}

/** The subset of a keyboard event the menu needs; React and DOM events both fit. */
interface MentionKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

/**
 * True when an "@token" reads as a file reference rather than a prompt name.
 * Claude Code and Codex users type "@src/foo.ts" or "@package.json" to point
 * the agent at a file, so a token with a path separator or a trailing
 * ".ext" (including the half-typed "@foo.") never opens the prompt menu.
 * A token that is exactly the name of a saved prompt still counts as a prompt,
 * so a prompt called "v1.2" stays reachable.
 */
export function looksLikeFileToken(query: string, prompts: SavedPrompt[]): boolean {
  if (!query) return false;
  if (!/[\\/]/.test(query) && !/\.[\w-]*$/.test(query)) return false;
  const lower = query.toLowerCase();
  return !prompts.some((p) => p.name.toLowerCase() === lower);
}

/**
 * Orders the prompts that match a query: exact name first, then names that
 * start with the query, then names that contain it. Within each group the
 * server order (most recently updated first) is kept.
 */
export function filterPromptsByQuery(prompts: SavedPrompt[], rawQuery: string): SavedPrompt[] {
  const query = rawQuery.toLowerCase();
  if (!query) return prompts;
  const exact: SavedPrompt[] = [];
  const prefix: SavedPrompt[] = [];
  const contains: SavedPrompt[] = [];
  for (const p of prompts) {
    const name = p.name.toLowerCase();
    if (name === query) exact.push(p);
    else if (name.startsWith(query)) prefix.push(p);
    else if (name.includes(query)) contains.push(p);
  }
  return [...exact, ...prefix, ...contains];
}

export function useMentionMenu({ text, caretPos, cwd, enabled = true }: UseMentionMenuOptions) {
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0);
  // True once the user moved through the menu (arrow keys or pointer). Only
  // then does Enter pick the highlighted prompt; otherwise Enter sends.
  const [navigated, setNavigated] = useState(false);
  // Start offset of an "@token" the user dismissed with Escape, so the menu
  // stays closed for that token instead of reopening on the next render.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const hasLoadedRef = useRef(false);
  const requestIdRef = useRef(0);

  const refreshPrompts = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    // Show the loading row only for the first load; later refreshes keep the
    // current list on screen so the menu does not flicker when it opens.
    if (!hasLoadedRef.current) setPromptsLoading(true);
    try {
      const prompts = await api.listPrompts(cwd);
      if (requestId !== requestIdRef.current) return;
      setSavedPrompts(prompts.filter((p) => !!p.name.trim()));
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSavedPrompts([]);
    } finally {
      if (requestId === requestIdRef.current) {
        hasLoadedRef.current = true;
        setPromptsLoading(false);
      }
    }
  }, [cwd]);

  useEffect(() => {
    // A new cwd has a different prompt set; show loading until it arrives.
    hasLoadedRef.current = false;
    void refreshPrompts();
  }, [refreshPrompts]);

  const mentionContext = useMemo<MentionContext | null>(() => {
    const prefix = text.slice(0, caretPos);
    const match = prefix.match(/(^|\s)@([^\s@]*)$/);
    if (!match || match.index === undefined) return null;
    const query = match[2] || "";
    if (looksLikeFileToken(query, savedPrompts)) return null;
    const start = prefix.length - match[0].length + match[1].length;
    return { query, start, end: caretPos };
  }, [text, caretPos, savedPrompts]);

  const filteredPrompts = useMemo(() => {
    if (!mentionMenuOpen || !mentionContext) return [];
    return filterPromptsByQuery(savedPrompts, mentionContext.query);
  }, [mentionMenuOpen, mentionContext, savedPrompts]);

  // Forget an Escape dismissal once the caret leaves that token.
  useEffect(() => {
    if (dismissedStart !== null && mentionContext?.start !== dismissedStart) {
      setDismissedStart(null);
    }
  }, [dismissedStart, mentionContext?.start]);

  // Open/close menu based on context; refresh the list every time it opens so
  // prompts created or edited elsewhere (Prompts page, other tab) show up.
  useEffect(() => {
    const shouldOpen = enabled && !!mentionContext && mentionContext.start !== dismissedStart;
    if (shouldOpen && !mentionMenuOpen) {
      setMentionMenuOpen(true);
      setMentionMenuIndex(0);
      setNavigated(false);
      void refreshPrompts();
    } else if (!shouldOpen && mentionMenuOpen) {
      setMentionMenuOpen(false);
    }
  }, [enabled, mentionContext, mentionMenuOpen, dismissedStart, refreshPrompts]);

  // A new query means a new list: drop the previous highlight and choice.
  const query = mentionContext?.query;
  useEffect(() => {
    setMentionMenuIndex(0);
    setNavigated(false);
  }, [query]);

  // Keep selected index in bounds
  useEffect(() => {
    if (mentionMenuIndex >= filteredPrompts.length) {
      setMentionMenuIndex(Math.max(0, filteredPrompts.length - 1));
    }
  }, [filteredPrompts.length, mentionMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!mentionMenuRef.current || !mentionMenuOpen) return;
    const items = mentionMenuRef.current.querySelectorAll("[data-prompt-index]");
    const selected = items[mentionMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [mentionMenuIndex, mentionMenuOpen]);

  const selectPrompt = useCallback(
    (prompt: SavedPrompt): { nextText: string; nextCursor: number } => {
      if (!mentionContext) return { nextText: text, nextCursor: caretPos };
      const insertion = `${prompt.content} `;
      const nextText = `${text.slice(0, mentionContext.start)}${insertion}${text.slice(mentionContext.end)}`;
      const nextCursor = mentionContext.start + insertion.length;
      return { nextText, nextCursor };
    },
    [mentionContext, text, caretPos],
  );

  /** Pointer movement over an item highlights it and counts as navigation. */
  const hoverPrompt = useCallback((index: number) => {
    setMentionMenuIndex(index);
    setNavigated(true);
  }, []);

  /**
   * Shared keyboard handling for every composer. Returns true when the key
   * was consumed by the menu; on false the caller runs its own handling
   * (Enter sends, Shift+Enter inserts a newline, ...).
   *
   * Enter picks a prompt only when the user navigated the menu or typed a
   * prompt's exact name. A bare "@", a partial match or a token with no match
   * falls through so the message is sent as typed.
   */
  const handleMentionKeyDown = useCallback(
    (e: MentionKeyEvent, onSelect: (prompt: SavedPrompt) => void): boolean => {
      if (!mentionMenuOpen) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionMenuOpen(false);
        if (mentionContext) setDismissedStart(mentionContext.start);
        return true;
      }
      const count = filteredPrompts.length;
      if (count > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionMenuIndex((i) => (i + step + count) % count);
        setNavigated(true);
        return true;
      }
      if (e.shiftKey) return false;
      if (e.key === "Tab") {
        // Tab never moves focus out of the composer while the menu is open;
        // with nothing to insert it is simply a no-op.
        e.preventDefault();
        if (count > 0) onSelect(filteredPrompts[mentionMenuIndex] ?? filteredPrompts[0]);
        return true;
      }
      if (e.key === "Enter" && count > 0) {
        const lowerQuery = mentionContext?.query.toLowerCase() ?? "";
        const exact = filteredPrompts.find((p) => p.name.toLowerCase() === lowerQuery);
        const choice = navigated ? filteredPrompts[mentionMenuIndex] : exact;
        if (!choice) return false;
        e.preventDefault();
        onSelect(choice);
        return true;
      }
      return false;
    },
    [mentionMenuOpen, mentionContext, filteredPrompts, mentionMenuIndex, navigated],
  );

  return {
    mentionMenuOpen,
    setMentionMenuOpen,
    mentionMenuIndex,
    setMentionMenuIndex,
    mentionContext,
    filteredPrompts,
    promptsLoading,
    savedPrompts,
    selectPrompt,
    refreshPrompts,
    mentionMenuRef,
    hoverPrompt,
    handleMentionKeyDown,
  };
}
