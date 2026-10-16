import { linearCache } from "./linear-cache.js";
import type { LinearTeamState } from "./routes/linear-routes.js";

/**
 * Linear reads and writes behind a domain's board (domain-linear-routes.ts).
 *
 * Everything is read live from Linear with the connection's own API key, so
 * two Companion installs (each with its own key) on the same workspace see
 * the same issues, states and assignees: nothing about the board is stored
 * locally. Reads go through linearCache (shared TTLs, in-flight dedup) to stay
 * far from Linear's rate limit even with several open tabs polling.
 */

const LINEAR_URL = "https://api.linear.app/graphql";

/** One GraphQL call; throws with Linear's first error message. */
export async function linearGraphql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  }).catch((e: unknown) => {
    throw new Error(`Failed to connect to Linear: ${e instanceof Error ? e.message : String(e)}`);
  });
  const json = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || (json.errors && json.errors.length > 0) || !json.data) {
    throw new Error(json.errors?.[0]?.message || response.statusText || "Linear request failed");
  }
  return json.data;
}

// ── Viewer ──────────────────────────────────────────────────────────────────

export interface LinearViewer {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** The user the connection's API key belongs to ("me" on the board). */
export function fetchLinearViewer(apiKey: string, connectionId: string): Promise<LinearViewer> {
  return linearCache.getOrFetch(`${connectionId}:viewer`, 300_000, async () => {
    const data = await linearGraphql<{ viewer?: { id?: string; name?: string | null; displayName?: string | null; avatarUrl?: string | null } }>(
      apiKey,
      "query CompanionViewer { viewer { id name displayName avatarUrl } }",
    );
    return {
      id: data.viewer?.id || "",
      name: data.viewer?.displayName || data.viewer?.name || "",
      avatarUrl: data.viewer?.avatarUrl || null,
    };
  });
}

// ── Team projects ───────────────────────────────────────────────────────────

export interface LinearTeamProject {
  id: string;
  name: string;
  state: string;
}

/** The projects of one team (for the domain link picker and its validation). */
export function fetchTeamProjects(apiKey: string, connectionId: string, teamId: string): Promise<LinearTeamProject[]> {
  return linearCache.getOrFetch(`${connectionId}:team-projects:${teamId}`, 300_000, async () => {
    const data = await linearGraphql<{ team?: { projects?: { nodes?: Array<{ id?: string; name?: string | null; state?: string | null }> } } | null }>(
      apiKey,
      `query CompanionTeamProjects($teamId: String!) {
        team(id: $teamId) { projects(first: 100) { nodes { id name state } } }
      }`,
      { teamId },
    );
    if (!data.team) throw new Error("Team not found");
    return (data.team.projects?.nodes || [])
      .map((p) => ({ id: p.id || "", name: p.name || "", state: p.state || "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

// ── Board ───────────────────────────────────────────────────────────────────

/** Workflow state types in board order; the last two are hidden unless asked for. */
const STATE_TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];
export const HIDDEN_STATE_TYPES = new Set(["canceled", "cancelled", "duplicate"]);

/** The team's states as board columns: by type (backlog → completed → canceled), then Linear's position. */
export function sortBoardStates(states: LinearTeamState[]): LinearTeamState[] {
  const rank = (t: string) => {
    const i = STATE_TYPE_ORDER.indexOf(t === "cancelled" ? "canceled" : t);
    return i < 0 ? STATE_TYPE_ORDER.length : i;
  };
  return [...states].sort((a, b) => rank(a.type) - rank(b.type) || (a.position ?? 0) - (b.position ?? 0));
}

/** The first "started" state of a team (what "Take it" moves an issue to). */
export function firstStartedState(states: LinearTeamState[]): LinearTeamState | undefined {
  return sortBoardStates(states).find((s) => s.type === "started");
}

export interface BoardLabel {
  id: string;
  name: string;
  color: string;
  /** The label group ("Soak" for "soak 24h"), when the label belongs to one. */
  group?: string;
}

export interface BoardIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  /** 0 = none, 1 = urgent … 4 = low (Linear's scale). */
  priority: number;
  priorityLabel: string;
  stateId: string;
  stateName: string;
  stateType: string;
  updatedAt: string;
  assignee: { id: string; name: string; avatarUrl: string | null } | null;
  labels: BoardLabel[];
  teamId: string;
  teamKey: string;
  teamName: string;
  projectId?: string;
  projectName?: string;
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  updatedAt?: string | null;
  description?: string | null;
  state?: { id?: string; name?: string | null; type?: string | null } | null;
  assignee?: { id?: string; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  labels?: { nodes?: Array<{ id: string; name: string; color?: string | null; parent?: { name?: string | null } | null }> } | null;
  team?: { id?: string; key?: string | null; name?: string | null } | null;
  project?: { id?: string; name?: string | null } | null;
}

const ISSUE_FIELDS = `
  id identifier title url branchName priority priorityLabel updatedAt
  state { id name type }
  assignee { id name displayName avatarUrl }
  labels(first: 10) { nodes { id name color parent { name } } }
  team { id key name }
  project { id name }
`;

export function toBoardIssue(raw: RawIssue): BoardIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    branchName: raw.branchName || "",
    priority: typeof raw.priority === "number" ? raw.priority : 0,
    priorityLabel: raw.priorityLabel || "",
    stateId: raw.state?.id || "",
    stateName: raw.state?.name || "",
    stateType: raw.state?.type || "",
    updatedAt: raw.updatedAt || "",
    assignee: raw.assignee?.id
      ? { id: raw.assignee.id, name: raw.assignee.displayName || raw.assignee.name || "", avatarUrl: raw.assignee.avatarUrl || null }
      : null,
    labels: (raw.labels?.nodes || []).map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color || "",
      ...(l.parent?.name ? { group: l.parent.name } : {}),
    })),
    teamId: raw.team?.id || "",
    teamKey: raw.team?.key || "",
    teamName: raw.team?.name || "",
    ...(raw.project?.id ? { projectId: raw.project.id, projectName: raw.project.name || "" } : {}),
  };
}

/** Completed and canceled issues older than this are left off the board (they pile up forever). */
export const DONE_WINDOW_DAYS = 14;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
export const BOARD_TTL_MS = 30_000;

export function boardCacheKey(connectionId: string, teamId: string, projectId?: string): string {
  return `${connectionId}:board:${teamId}:${projectId || "*"}`;
}

export interface BoardIssues {
  issues: BoardIssue[];
  /** More issues than the board fetches (MAX_PAGES × PAGE_SIZE): the oldest are left out. */
  truncated: boolean;
}

/**
 * The issues of a team (or of one project of it): every open one, plus the
 * ones completed or canceled in the last DONE_WINDOW_DAYS. Most recently
 * updated first, at most MAX_PAGES pages.
 */
export function fetchBoardIssues(
  apiKey: string,
  connectionId: string,
  teamId: string,
  projectId?: string,
  now: () => number = Date.now,
): Promise<BoardIssues> {
  return linearCache.getOrFetch(boardCacheKey(connectionId, teamId, projectId), BOARD_TTL_MS, async () => {
    const since = new Date(now() - DONE_WINDOW_DAYS * 86_400_000).toISOString();
    const filter: Record<string, unknown> = {
      team: { id: { eq: teamId } },
      ...(projectId ? { project: { id: { eq: projectId } } } : {}),
      or: [
        { state: { type: { nin: ["completed", "canceled", "duplicate"] } } },
        { updatedAt: { gt: since } },
      ],
    };
    const issues: BoardIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: { issues?: { nodes?: RawIssue[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } =
        await linearGraphql(
          apiKey,
          `query CompanionDomainBoard($filter: IssueFilter!, $first: Int!, $after: String) {
            issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
              nodes { ${ISSUE_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { filter, first: PAGE_SIZE, after },
        );
      issues.push(...(data.issues?.nodes || []).map(toBoardIssue));
      const info = data.issues?.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) return { issues, truncated: false };
      after = info.endCursor;
    }
    return { issues, truncated: true };
  });
}

/** Full issue (with description) in the shape the Home page links to a session. */
export interface TakenIssue extends BoardIssue {
  description: string;
}

/**
 * Update an issue (assignee and/or state) and return it as the board shows
 * it, with its description (the new session's first message carries it).
 */
export async function updateLinearIssue(
  apiKey: string,
  issueId: string,
  input: { assigneeId?: string; stateId?: string },
): Promise<TakenIssue> {
  const data = await linearGraphql<{ issueUpdate?: { success?: boolean; issue?: RawIssue | null } }>(
    apiKey,
    `mutation CompanionBoardIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} description } }
    }`,
    { id: issueId, input },
  );
  const issue = data.issueUpdate?.issue;
  if (!data.issueUpdate?.success || !issue) throw new Error("Linear did not update the issue");
  return { ...toBoardIssue(issue), description: issue.description || "" };
}

/** One issue of the team, fresh (for "Take it" to check its current state). */
export async function fetchIssue(apiKey: string, issueId: string): Promise<TakenIssue> {
  const data = await linearGraphql<{ issue?: RawIssue | null }>(
    apiKey,
    `query CompanionBoardIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description } }`,
    { id: issueId },
  );
  if (!data.issue) throw new Error("Issue not found");
  return { ...toBoardIssue(data.issue), description: data.issue.description || "" };
}
