// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { BoardIssue, BoardState, TakenIssue } from "../api.js";
import { boardColumns, initials, labelText, setLinearHandoff, takeLinearHandoff, toLinearIssue } from "./linear-board.js";

/**
 * Board helpers: label text, columns (hidden states, "mine", card order),
 * avatar initials, and the one-shot hand-off from "Take it" to the Home page.
 */

const states: BoardState[] = [
  { id: "todo", name: "Todo", type: "unstarted", hidden: false },
  { id: "progress", name: "In Progress", type: "started", hidden: false },
  { id: "cancel", name: "Canceled", type: "canceled", hidden: true },
];

const issue = (over: Partial<BoardIssue>): BoardIssue => ({
  id: "i", identifier: "BSK-1", title: "t", url: "u", branchName: "", priority: 0, priorityLabel: "",
  stateId: "todo", stateName: "Todo", stateType: "unstarted", updatedAt: "2026-10-01", assignee: null, labels: [],
  teamId: "team", teamKey: "BSK", teamName: "Bskts", ...over,
});

describe("labelText", () => {
  it("prefixes the group of grouped labels", () => {
    expect(labelText({ id: "1", name: "soak 24h", color: "", group: "Soak" })).toBe("Soak: soak 24h");
    expect(labelText({ id: "2", name: "bug", color: "" })).toBe("bug");
  });
});

describe("boardColumns", () => {
  const issues = [
    issue({ id: "a", priority: 0, updatedAt: "2026-10-05" }),
    issue({ id: "b", priority: 3 }),
    issue({ id: "c", priority: 1, assignee: { id: "me", name: "Me", avatarUrl: null } }),
    issue({ id: "d", stateId: "cancel" }),
    issue({ id: "e", priority: 0, updatedAt: "2026-10-09" }),
    issue({ id: "f", stateId: "gone" }),
  ];

  it("hides canceled columns unless asked, and orders cards by priority then recency", () => {
    const cols = boardColumns(states, issues, { showHidden: false });
    expect(cols.map((c) => c.state.id)).toEqual(["todo", "progress"]);
    expect(cols[0].issues.map((i) => i.id)).toEqual(["c", "b", "e", "a"]);
    expect(boardColumns(states, issues, { showHidden: true })[2].issues.map((i) => i.id)).toEqual(["d"]);
  });

  it("keeps only my issues with mineId", () => {
    const cols = boardColumns(states, issues, { showHidden: true, mineId: "me" });
    expect(cols.flatMap((c) => c.issues.map((i) => i.id))).toEqual(["c"]);
  });
});

describe("initials", () => {
  it("takes the first and last initial", () => {
    expect(initials("Marco Monaco")).toBe("MM");
    expect(initials("ema")).toBe("E");
    expect(initials("  ")).toBe("?");
  });
});

describe("hand-off", () => {
  beforeEach(() => sessionStorage.clear());

  const taken: TakenIssue = { ...issue({ id: "i9", identifier: "BSK-9", assignee: { id: "me", name: "Marco", avatarUrl: null } }), description: "d" };

  it("maps a taken issue to the Home page's LinearIssue", () => {
    expect(toLinearIssue(taken, "conn")).toMatchObject({ id: "i9", identifier: "BSK-9", description: "d", assigneeName: "Marco", connectionId: "conn", teamId: "team" });
  });

  // Read once: a page reload must not start a second session for the same issue.
  it("is read once", () => {
    setLinearHandoff({ domain: "herd", connectionId: "conn", issue: toLinearIssue(taken, "conn") });
    expect(takeLinearHandoff()).toMatchObject({ domain: "herd", issue: { identifier: "BSK-9" } });
    expect(takeLinearHandoff()).toBeNull();
  });

  it("ignores broken entries", () => {
    sessionStorage.setItem("cc-linear-handoff", "{");
    expect(takeLinearHandoff()).toBeNull();
    sessionStorage.setItem("cc-linear-handoff", JSON.stringify({ domain: "herd" }));
    expect(takeLinearHandoff()).toBeNull();
  });
});
