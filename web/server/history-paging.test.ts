// @vitest-environment node
import { describe, it, expect } from "vitest";
import { historyTail, historyPage, HISTORY_PAGE_SIZE } from "./ws-bridge-persist.js";

/**
 * Replaying the full 2000-message history to every socket on every refresh is
 * what stalled the server. These pin the paging that replaced it.
 */
describe("history paging", () => {
  const history = Array.from({ length: 1000 }, (_, i) => i);

  it("sends only the newest page, and says where it starts", () => {
    const tail = historyTail(history);
    expect(tail.messages).toHaveLength(HISTORY_PAGE_SIZE);
    expect(tail.messages[tail.messages.length - 1]).toBe(999);
    expect(tail.startIndex).toBe(1000 - HISTORY_PAGE_SIZE);
    expect(tail.total).toBe(1000);
  });

  it("sends the whole history when it is shorter than a page", () => {
    const short = [1, 2, 3];
    const tail = historyTail(short);
    expect(tail.messages).toEqual(short);
    expect(tail.startIndex).toBe(0); // startIndex 0 means "nothing older exists"
  });

  it("walks backwards one page at a time without gaps or overlap", () => {
    const first = historyTail(history);
    const second = historyPage(history, first.startIndex);
    expect(second.messages[second.messages.length - 1]).toBe(first.startIndex - 1);
    expect(second.startIndex).toBe(first.startIndex - HISTORY_PAGE_SIZE);
  });

  it("clamps at the beginning instead of returning negative indices", () => {
    const page = historyPage(history, 50);
    expect(page.startIndex).toBe(0);
    expect(page.messages).toEqual(history.slice(0, 50));
  });

  it("returns nothing once the beginning is reached", () => {
    expect(historyPage(history, 0).messages).toHaveLength(0);
  });
});
