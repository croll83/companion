import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

/**
 * The domain ↔ Linear API: link a domain to a team/project (validated
 * against Linear), per-domain rules, the board, moving and taking issues.
 * The registry lives in a temp dir; Linear is a fake answering by GraphQL
 * operation name (no real API call, no real key); session links and names
 * are mocked so nothing reads the real ~/.companion.
 */

const h = vi.hoisted(() => ({
  home: "",
  connections: {} as Record<string, Record<string, unknown>>,
  links: {} as Record<string, { id: string }>,
  names: {} as Record<string, string>,
}));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("../linear-connections.js", () => ({
  getConnection: (id: string) => h.connections[id] ?? null,
  resolveApiKey: () => null,
}));
vi.mock("../session-linear-issues.js", () => ({
  getAllLinearIssues: () => h.links,
  getLinearIssue: () => undefined,
  setLinearIssue: () => {},
  removeLinearIssue: () => {},
}));
vi.mock("../session-names.js", () => ({ getAllNames: () => h.names }));
vi.mock("../settings-manager.js", () => ({
  getSettings: () => ({
    linearApiKey: "",
    linearAutoTransition: false,
    linearAutoTransitionStateId: "",
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateId: "",
    linearArchiveTransitionStateName: "",
  }),
}));

import { registerDomainLinearRoutes } from "./domain-linear-routes.js";
import { createDomain, getDomain, setDomainLinear } from "../domain-store.js";
import { _resetForTest as resetCache } from "../linear-cache.js";

const SECRET = "lin_api_SECRET_never_returned";

const teams = [
  {
    id: "team-bsk",
    key: "BSK",
    name: "Bskts",
    states: {
      nodes: [
        { id: "st-review", name: "In Review", type: "started", position: 3 },
        { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
        { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "st-progress", name: "In Progress", type: "started", position: 2 },
        { id: "st-prod", name: "In prod", type: "completed", position: 7 },
        { id: "st-cancel", name: "Canceled", type: "canceled", position: 8 },
      ],
    },
  },
  { id: "team-other", key: "OTH", name: "Other", states: { nodes: [{ id: "st-x", name: "Todo", type: "unstarted", position: 0 }] } },
];

const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  identifier: "BSK-1",
  title: "Soak the release",
  url: "https://linear.app/bskts/issue/BSK-1",
  branchName: "marco/bsk-1-soak",
  priority: 2,
  priorityLabel: "High",
  updatedAt: "2026-10-15T00:00:00.000Z",
  state: { id: "st-todo", name: "Todo", type: "unstarted" },
  assignee: null,
  labels: { nodes: [{ id: "l1", name: "soak 24h", color: "#f00", parent: { name: "Soak" } }] },
  team: { id: "team-bsk", key: "BSK", name: "Bskts" },
  project: { id: "p-bskts", name: "Bskts" },
  description: "desc",
  ...over,
});

/** Fake Linear: answers by operation name; records every call. */
const linear = {
  calls: [] as { op: string; variables?: Record<string, unknown>; auth: string }[],
  issue: issue(),
  failBoard: false,
  noTeams: false,
};
const fetchMock = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
  const { query, variables } = JSON.parse(init.body) as { query: string; variables?: Record<string, unknown> };
  const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
  linear.calls.push({ op, variables, auth: init.headers.Authorization });
  const ok = (data: unknown) => ({ ok: true, statusText: "OK", json: async () => ({ data }) });
  switch (op) {
    case "CompanionWorkflowStates":
      return ok({ teams: { nodes: linear.noTeams ? [] : teams } });
    case "CompanionTeamProjects":
      return ok({ team: variables?.teamId === "team-bsk" ? { projects: { nodes: [{ id: "p-bskts", name: "Bskts", state: "started" }, { id: "p-shiki", name: "Shiki", state: "started" }] } } : null });
    case "CompanionViewer":
      return ok({ viewer: { id: "u-marco", name: "marco", displayName: "Marco", avatarUrl: null } });
    case "CompanionDomainBoard":
      if (linear.failBoard) return { ok: true, statusText: "OK", json: async () => ({ errors: [{ message: "Rate limited" }] }) };
      return ok({ issues: { nodes: [issue(), issue({ id: "i2", identifier: "BSK-2", assignee: { id: "u-ema", name: "ema", displayName: "Ema" } })], pageInfo: { hasNextPage: false } } });
    case "CompanionBoardIssue":
      return ok({ issue: linear.issue });
    case "CompanionBoardIssueUpdate": {
      const input = variables?.input as { stateId?: string; assigneeId?: string };
      const state = teams[0].states.nodes.find((s) => s.id === input.stateId) ?? linear.issue.state;
      return ok({ issueUpdate: { success: true, issue: { ...linear.issue, state, assignee: { id: input.assigneeId, name: "marco", displayName: "Marco" } } } });
    }
    case "CompanionTransitionIssue":
      return ok({ issueUpdate: { success: true, issue: { id: variables?.issueId, identifier: "BSK-1", state: { name: "In Review", type: "started" } } } });
    default:
      throw new Error(`unexpected Linear operation ${op}`);
  }
});

let tmp: string;
let app: Hono;
let sessions: { sessionId: string; archived?: boolean; backendType?: string; domain?: string }[];
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

const send = (method: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "domain-linear-routes-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  h.connections = {
    "conn-bskts": {
      id: "conn-bskts", name: "Bskts", apiKey: SECRET, workspaceName: "bskts",
      autoTransition: true, autoTransitionStateId: "st-todo", autoTransitionStateName: "Todo",
      archiveTransition: false, archiveTransitionStateId: "", archiveTransitionStateName: "",
    },
  };
  h.links = {};
  h.names = {};
  linear.calls = [];
  linear.issue = issue();
  linear.failBoard = false;
  linear.noTeams = false;
  sessions = [];
  resetCache();
  vi.stubGlobal("fetch", fetchMock);
  app = new Hono();
  registerDomainLinearRoutes(app, { listSessions: () => sessions });
  createDomain({ name: "Herd" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

const linkHerd = () => setDomainLinear("herd", { connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", projectId: "p-bskts", projectName: "Bskts" });

describe("PUT/GET/DELETE /domains/:slug/linear", () => {
  it("links a domain after checking the team and project exist, and never returns the key", async () => {
    const res = await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk", projectId: "p-bskts" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).link).toEqual({
      connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", teamName: "Bskts",
      projectId: "p-bskts", projectName: "Bskts", connectionName: "Bskts", workspaceName: "bskts",
    });
    expect(linear.calls.every((c) => c.auth === SECRET)).toBe(true);

    const got = await app.request("/domains/herd/linear");
    const gotText = await got.text();
    expect(gotText).not.toContain(SECRET);
    // No own rules yet: the connection's apply (migration of today's behaviour).
    expect(JSON.parse(gotText).rules).toEqual({
      start: { enabled: true, stateId: "st-todo", stateName: "Todo", source: "connection" },
      archive: { enabled: false, stateId: "", stateName: "", source: "connection" },
    });
  });

  it("links GLOBAL too, and a whole team without a project", async () => {
    const res = await app.request("/domains/global/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk" }));
    expect(res.status).toBe(200);
    expect((await res.json()).link.projectId).toBeUndefined();
    expect(linear.calls.map((c) => c.op)).not.toContain("CompanionTeamProjects");
  });

  it("refuses unknown domains, connections, teams, projects and states", async () => {
    expect((await app.request("/domains/nope/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk" }))).status).toBe(404);
    expect((await app.request("/domains/herd/linear", send("PUT", { teamId: "team-bsk" }))).status).toBe(400);
    expect((await app.request("/domains/herd/linear", send("PUT", { connectionId: "gone", teamId: "team-bsk" }))).status).toBe(400);
    const badTeam = await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-x" }));
    expect(badTeam.status).toBe(400);
    expect((await badTeam.json()).error).toContain("team-x");
    const badProject = await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk", projectId: "p-hermes" }));
    expect((await badProject.json()).error).toContain("No project");
    // A state of another team is not a valid target for this team's rule.
    const badState = await app.request("/domains/herd/linear", send("PUT", {
      connectionId: "conn-bskts", teamId: "team-bsk", autoTransition: { enabled: true, stateId: "st-x" },
    }));
    expect(badState.status).toBe(400);
    expect((await app.request("/domains/herd/linear", send("PUT", {
      connectionId: "conn-bskts", teamId: "team-bsk", autoTransition: "on",
    }))).status).toBe(400);
    expect((await app.request("/domains/herd/linear", send("PUT", {
      connectionId: "conn-bskts", teamId: "team-bsk", autoTransition: { enabled: "yes" },
    }))).status).toBe(400);
    expect(getDomain("herd")?.linear).toBeUndefined();
  });

  it("reports Linear being unreachable when it cannot list the teams", async () => {
    linear.noTeams = true;
    expect((await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk" }))).status).toBe(502);
  });

  // Per-domain rules: target state picked among the linked team's states.
  it("saves rules, keeps them when the team stays, drops them when it changes", async () => {
    let res = await app.request("/domains/herd/linear", send("PUT", {
      connectionId: "conn-bskts", teamId: "team-bsk",
      autoTransition: { enabled: true, stateId: "st-progress" },
      archiveTransition: { enabled: false },
    }));
    expect((await res.json()).link).toMatchObject({
      autoTransition: { enabled: true, stateId: "st-progress", stateName: "In Progress" },
      archiveTransition: { enabled: false, stateId: "", stateName: "" },
    });
    const rules = (await (await app.request("/domains/herd/linear")).json()).rules;
    expect(rules.start).toMatchObject({ stateId: "st-progress", source: "domain" });
    expect(rules.archive).toMatchObject({ enabled: false, source: "domain" });

    // Same team, project added, rules not in the request: kept.
    await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk", projectId: "p-shiki" }));
    expect(getDomain("herd")?.linear?.autoTransition?.stateId).toBe("st-progress");
    // null = back to the connection's setting.
    await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-bsk", autoTransition: null }));
    expect(getDomain("herd")?.linear?.autoTransition).toBeUndefined();
    expect(getDomain("herd")?.linear?.archiveTransition).toBeDefined();
    // Another team: its states differ, so the rules go.
    res = await app.request("/domains/herd/linear", send("PUT", { connectionId: "conn-bskts", teamId: "team-other" }));
    expect(res.status).toBe(200);
    expect(getDomain("herd")?.linear?.archiveTransition).toBeUndefined();
  });

  it("unlinks, and reports a link whose connection was removed as broken", async () => {
    linkHerd();
    delete h.connections["conn-bskts"];
    expect((await (await app.request("/domains/herd/linear")).json()).link).toMatchObject({ broken: "connection_missing", connectionName: "" });
    expect((await app.request("/domains/herd/linear", send("DELETE"))).status).toBe(200);
    expect(await (await app.request("/domains/herd/linear")).json()).toEqual({ link: null });
    expect((await app.request("/domains/nope/linear", send("DELETE"))).status).toBe(404);
    expect((await app.request("/domains/nope/linear")).status).toBe(404);
  });
});

describe("GET /linear/teams/:teamId/projects", () => {
  it("lists the projects of a team for the picker", async () => {
    const res = await app.request("/linear/teams/team-bsk/projects?connectionId=conn-bskts");
    expect((await res.json()).projects.map((p: { name: string }) => p.name)).toEqual(["Bskts", "Shiki"]);
    expect((await app.request("/linear/teams/team-bsk/projects?connectionId=gone")).status).toBe(400);
    expect((await app.request("/linear/teams/team-x/projects?connectionId=conn-bskts")).status).toBe(502);
  });
});

describe("GET /domains/:slug/linear/board", () => {
  it("explains why there is no board", async () => {
    let res = await app.request("/domains/herd/linear/board");
    expect(res.status).toBe(404);
    expect((await res.json()).reason).toBe("not_linked");
    expect((await app.request("/domains/nope/linear/board")).status).toBe(404);
    setDomainLinear("herd", { connectionId: "gone", teamId: "team-bsk" });
    res = await app.request("/domains/herd/linear/board");
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("connection_missing");
    setDomainLinear("herd", { connectionId: "conn-bskts", teamId: "team-deleted" });
    expect((await (await app.request("/domains/herd/linear/board")).json()).reason).toBe("team_missing");
    linear.noTeams = true;
    resetCache();
    expect((await app.request("/domains/herd/linear/board")).status).toBe(502);
  });

  it("returns ordered columns, issues, viewer and linked sessions, without the key", async () => {
    linkHerd();
    sessions = [
      { sessionId: "s-old", domain: "herd", backendType: "codex", archived: true },
      { sessionId: "s-new", domain: "herd" },
      { sessionId: "s-unlinked", domain: "herd" },
    ];
    h.links = { "s-old": { id: "i1" }, "s-new": { id: "i1" }, "s-elsewhere": { id: "i9" } };
    h.names = { "s-new": "Brave Falcon" };
    const res = await app.request("/domains/herd/linear/board");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body.states.map((s: { name: string }) => s.name)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "In prod", "Canceled"]);
    expect(body.states.find((s: { name: string }) => s.name === "Canceled").hidden).toBe(true);
    expect(body.states.find((s: { name: string }) => s.name === "In prod").hidden).toBe(false);
    expect(body.viewer).toEqual({ id: "u-marco", name: "Marco", avatarUrl: null });
    expect(body.team).toEqual({ id: "team-bsk", key: "BSK", name: "Bskts" });
    expect(body.issues.map((i: { identifier: string }) => i.identifier)).toEqual(["BSK-1", "BSK-2"]);
    expect(body.issues[0].labels[0]).toEqual({ id: "l1", name: "soak 24h", color: "#f00", group: "Soak" });
    // Sessions linked to the issue, newest first, Codex and Claude alike.
    expect(body.sessions).toEqual({
      i1: [
        { sessionId: "s-new", name: "Brave Falcon", archived: false, backendType: "claude", domain: "herd" },
        { sessionId: "s-old", name: "s-old", archived: true, backendType: "codex", domain: "herd" },
      ],
    });
    // The project filter went to Linear.
    const boardCall = linear.calls.find((c) => c.op === "CompanionDomainBoard");
    expect(boardCall?.variables?.filter).toMatchObject({ team: { id: { eq: "team-bsk" } }, project: { id: { eq: "p-bskts" } } });
  });

  // Polling hits the cache; the Refresh button (refresh=1) goes to Linear.
  it("serves polls from the cache and refetches on refresh=1", async () => {
    linkHerd();
    await app.request("/domains/herd/linear/board");
    await app.request("/domains/herd/linear/board");
    expect(linear.calls.filter((c) => c.op === "CompanionDomainBoard")).toHaveLength(1);
    await app.request("/domains/herd/linear/board?refresh=1");
    expect(linear.calls.filter((c) => c.op === "CompanionDomainBoard")).toHaveLength(2);
  });

  it("passes Linear errors through as 502", async () => {
    linkHerd();
    linear.failBoard = true;
    const res = await app.request("/domains/herd/linear/board");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Rate limited");
  });
});

describe("moving and taking issues", () => {
  it("moves an issue to a state of the team and invalidates the board", async () => {
    linkHerd();
    await app.request("/domains/herd/linear/board");
    const res = await app.request("/domains/herd/linear/issues/i1/state", send("POST", { stateId: "st-review" }));
    expect(res.status).toBe(200);
    expect((await res.json()).issue).toMatchObject({ stateName: "In Review" });
    expect(linear.calls.find((c) => c.op === "CompanionTransitionIssue")?.variables).toEqual({ issueId: "i1", stateId: "st-review" });
    await app.request("/domains/herd/linear/board");
    expect(linear.calls.filter((c) => c.op === "CompanionDomainBoard")).toHaveLength(2);
  });

  it("refuses a state of another team, and an unlinked domain", async () => {
    linkHerd();
    expect((await app.request("/domains/herd/linear/issues/i1/state", send("POST", { stateId: "st-x" }))).status).toBe(400);
    setDomainLinear("herd", null);
    expect((await app.request("/domains/herd/linear/issues/i1/state", send("POST", { stateId: "st-review" }))).status).toBe(404);
    expect((await app.request("/domains/herd/linear/issues/i1/take", send("POST"))).status).toBe(404);
  });

  // Take it = assign to me + first "started" state (In Progress, not In Review).
  it("takes an issue: assigns it to the connection's user and starts it", async () => {
    linkHerd();
    const res = await app.request("/domains/herd/linear/issues/i1/take", send("POST"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, moved: true, connectionId: "conn-bskts" });
    expect(body.issue).toMatchObject({ identifier: "BSK-1", stateName: "In Progress", description: "desc", branchName: "marco/bsk-1-soak" });
    expect(linear.calls.find((c) => c.op === "CompanionBoardIssueUpdate")?.variables).toEqual({
      id: "i1", input: { assigneeId: "u-marco", stateId: "st-progress" },
    });
  });

  // Never moved backwards: an issue already in review only gets the assignee.
  it("only assigns an issue that has already started", async () => {
    linkHerd();
    linear.issue = issue({ state: { id: "st-review", name: "In Review", type: "started" } });
    const body = await (await app.request("/domains/herd/linear/issues/i1/take", send("POST"))).json();
    expect(body.moved).toBe(false);
    expect(linear.calls.find((c) => c.op === "CompanionBoardIssueUpdate")?.variables).toEqual({ id: "i1", input: { assigneeId: "u-marco" } });
  });

  it("refuses to take an issue of another team", async () => {
    linkHerd();
    linear.issue = issue({ team: { id: "team-other", key: "OTH", name: "Other" } });
    const res = await app.request("/domains/herd/linear/issues/i1/take", send("POST"));
    expect(res.status).toBe(400);
    expect(linear.calls.map((c) => c.op)).not.toContain("CompanionBoardIssueUpdate");
  });
});
