import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTest as resetCache } from "./linear-cache.js";
import {
  BOARD_TTL_MS,
  DONE_WINDOW_DAYS,
  boardCacheKey,
  fetchBoardIssues,
  fetchIssue,
  fetchLinearViewer,
  fetchTeamProjects,
  firstStartedState,
  linearGraphql,
  sortBoardStates,
  toBoardIssue,
  updateLinearIssue,
} from "./linear-board.js";

/**
 * The Linear reads/writes behind the domain board. fetch is mocked: the
 * tests never call the real Linear API. They check the GraphQL each helper
 * sends (filters, pagination, variables), how responses are mapped, and the
 * caching that keeps polling boards under Linear's rate limit.
 */

const fetchMock = vi.fn();

function reply(data: unknown, init: { ok?: boolean; errors?: Array<{ message: string }>; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    statusText: init.statusText ?? "OK",
    json: async () => ({ data, ...(init.errors ? { errors: init.errors } : {}) }),
  };
}

function sentBody(call = 0): { query: string; variables?: Record<string, unknown> } {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

const rawIssue = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  identifier: "BSK-1",
  title: "Fix login",
  url: "https://linear.app/bskts/issue/BSK-1",
  branchName: "marco/bsk-1-fix-login",
  priority: 2,
  priorityLabel: "High",
  updatedAt: "2026-10-15T10:00:00.000Z",
  state: { id: "st-todo", name: "Todo", type: "unstarted" },
  assignee: { id: "u1", name: "marco", displayName: "Marco", avatarUrl: "https://a/x.png" },
  labels: { nodes: [{ id: "l1", name: "soak 24h", color: "#f00", parent: { name: "Soak" } }, { id: "l2", name: "bug", color: "#0f0", parent: null }] },
  team: { id: "team-bsk", key: "BSK", name: "Bskts" },
  project: { id: "p1", name: "Shiki" },
  ...over,
});

beforeEach(() => {
  resetCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linearGraphql", () => {
  it("sends the key as Authorization and returns data", async () => {
    fetchMock.mockResolvedValueOnce(reply({ viewer: { id: "u1" } }));
    await expect(linearGraphql("lin_key", "query X { viewer { id } }", { a: 1 })).resolves.toEqual({ viewer: { id: "u1" } });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("lin_key");
    expect(sentBody().variables).toEqual({ a: 1 });
  });

  it("throws Linear's first error, the HTTP status text, or a network error", async () => {
    fetchMock.mockResolvedValueOnce(reply(null, { errors: [{ message: "Entity not found" }] }));
    await expect(linearGraphql("k", "q")).rejects.toThrow("Entity not found");
    fetchMock.mockResolvedValueOnce(reply(null, { ok: false, statusText: "Unauthorized" }));
    await expect(linearGraphql("k", "q")).rejects.toThrow("Unauthorized");
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(linearGraphql("k", "q")).rejects.toThrow("Failed to connect to Linear: ECONNRESET");
  });
});

describe("sortBoardStates / firstStartedState", () => {
  // Columns follow Linear's board: backlog, todo, started, done, canceled;
  // inside a type, Linear's position (BSK has several "started" states).
  const states = [
    { id: "prod", name: "In prod", type: "completed", position: 0 },
    { id: "review", name: "In Review", type: "started", position: 2 },
    { id: "cancel", name: "Canceled", type: "canceled", position: 0 },
    { id: "progress", name: "In Progress", type: "started", position: 1 },
    { id: "backlog", name: "Backlog", type: "backlog", position: 0 },
    { id: "dup", name: "Duplicate", type: "duplicate", position: 1 },
    { id: "todo", name: "Todo", type: "unstarted", position: 0 },
    { id: "weird", name: "Custom", type: "something" },
  ];

  it("orders by type, then position; unknown types last", () => {
    expect(sortBoardStates(states).map((s) => s.id)).toEqual(["backlog", "todo", "progress", "review", "prod", "cancel", "dup", "weird"]);
  });

  it("picks the first started state by position", () => {
    expect(firstStartedState(states)?.id).toBe("progress");
    expect(firstStartedState([{ id: "b", name: "Backlog", type: "backlog" }])).toBeUndefined();
  });
});

describe("toBoardIssue", () => {
  it("maps assignee, grouped labels and project", () => {
    const issue = toBoardIssue(rawIssue());
    expect(issue).toMatchObject({
      identifier: "BSK-1",
      priority: 2,
      stateId: "st-todo",
      stateType: "unstarted",
      assignee: { id: "u1", name: "Marco", avatarUrl: "https://a/x.png" },
      projectId: "p1",
      projectName: "Shiki",
      teamKey: "BSK",
    });
    expect(issue.labels).toEqual([
      { id: "l1", name: "soak 24h", color: "#f00", group: "Soak" },
      { id: "l2", name: "bug", color: "#0f0" },
    ]);
  });

  it("tolerates missing optional fields", () => {
    const issue = toBoardIssue({ id: "i2", identifier: "BSK-2", title: "t", url: "u", assignee: null, labels: null, project: null, state: null, team: null, priority: null });
    expect(issue).toMatchObject({ priority: 0, assignee: null, labels: [], stateName: "", teamId: "", branchName: "" });
    expect(issue.projectId).toBeUndefined();
  });
});

describe("fetchBoardIssues", () => {
  const now = () => Date.parse("2026-10-16T00:00:00.000Z");

  // Only the team (and project) issues, open ones plus the recently closed.
  it("filters by team, project and the done window", async () => {
    fetchMock.mockResolvedValueOnce(reply({ issues: { nodes: [rawIssue()], pageInfo: { hasNextPage: false, endCursor: null } } }));
    const board = await fetchBoardIssues("k", "conn", "team-bsk", "p1", now);
    expect(board).toMatchObject({ truncated: false });
    expect(board.issues.map((i) => i.identifier)).toEqual(["BSK-1"]);
    const { variables } = sentBody();
    const since = new Date(now() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
    expect(variables).toMatchObject({
      first: 100,
      after: null,
      filter: {
        team: { id: { eq: "team-bsk" } },
        project: { id: { eq: "p1" } },
        or: [{ state: { type: { nin: ["completed", "canceled", "duplicate"] } } }, { updatedAt: { gt: since } }],
      },
    });
  });

  it("follows pages, and flags a board cut at the page limit", async () => {
    const page = (n: number, next: boolean) => reply({
      issues: { nodes: [rawIssue({ id: `i${n}`, identifier: `BSK-${n}` })], pageInfo: { hasNextPage: next, endCursor: next ? `c${n}` : null } },
    });
    fetchMock.mockResolvedValueOnce(page(1, true)).mockResolvedValueOnce(page(2, true)).mockResolvedValueOnce(page(3, true));
    const board = await fetchBoardIssues("k", "conn", "team-bsk", undefined, now);
    expect(board.truncated).toBe(true);
    expect(board.issues).toHaveLength(3);
    expect(sentBody(1).variables?.after).toBe("c1");
    // Without a project the whole team is shown.
    expect((sentBody().variables?.filter as Record<string, unknown>).project).toBeUndefined();
  });

  // Polling every minute from several tabs must not hit Linear every time.
  it("is cached per connection/team/project for BOARD_TTL_MS", async () => {
    fetchMock.mockResolvedValue(reply({ issues: { nodes: [], pageInfo: { hasNextPage: false } } }));
    await fetchBoardIssues("k", "conn", "team-bsk");
    await fetchBoardIssues("k", "conn", "team-bsk");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchBoardIssues("k", "other-conn", "team-bsk");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(BOARD_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(boardCacheKey("c", "t")).toBe("c:board:t:*");
    expect(boardCacheKey("c", "t", "p")).toBe("c:board:t:p");
  });
});

describe("viewer, projects and issue updates", () => {
  it("reads the viewer (display name first) and caches it", async () => {
    fetchMock.mockResolvedValueOnce(reply({ viewer: { id: "u1", name: "marco", displayName: "Marco M", avatarUrl: null } }));
    expect(await fetchLinearViewer("k", "conn")).toEqual({ id: "u1", name: "Marco M", avatarUrl: null });
    await fetchLinearViewer("k", "conn");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists a team's projects by name, and fails on an unknown team", async () => {
    fetchMock.mockResolvedValueOnce(reply({ team: { projects: { nodes: [{ id: "p2", name: "Shiki", state: "started" }, { id: "p1", name: "Bskts", state: null }] } } }));
    expect(await fetchTeamProjects("k", "conn", "team-bsk")).toEqual([
      { id: "p1", name: "Bskts", state: "" },
      { id: "p2", name: "Shiki", state: "started" },
    ]);
    expect(sentBody().variables).toEqual({ teamId: "team-bsk" });
    fetchMock.mockResolvedValueOnce(reply({ team: null }));
    await expect(fetchTeamProjects("k", "conn", "nope")).rejects.toThrow("Team not found");
  });

  it("updates assignee/state and returns the issue with its description", async () => {
    fetchMock.mockResolvedValueOnce(reply({ issueUpdate: { success: true, issue: rawIssue({ description: "Steps" }) } }));
    const issue = await updateLinearIssue("k", "i1", { assigneeId: "u1", stateId: "st-progress" });
    expect(issue).toMatchObject({ identifier: "BSK-1", description: "Steps" });
    expect(sentBody().variables).toEqual({ id: "i1", input: { assigneeId: "u1", stateId: "st-progress" } });
    fetchMock.mockResolvedValueOnce(reply({ issueUpdate: { success: false, issue: null } }));
    await expect(updateLinearIssue("k", "i1", {})).rejects.toThrow("did not update");
  });

  it("fetches one issue, or fails when it does not exist", async () => {
    fetchMock.mockResolvedValueOnce(reply({ issue: rawIssue({ description: null }) }));
    expect(await fetchIssue("k", "i1")).toMatchObject({ id: "i1", description: "" });
    fetchMock.mockResolvedValueOnce(reply({ issue: null }));
    await expect(fetchIssue("k", "x")).rejects.toThrow("Issue not found");
  });
});
