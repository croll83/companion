import type { Hono } from "hono";
import {
  GLOBAL_DOMAIN,
  ensureGlobalDomain,
  getDomain,
  setDomainLinear,
  type DomainInfo,
  type DomainLinearLink,
  type DomainLinearRule,
} from "../domain-store.js";
import { getConnection } from "../linear-connections.js";
import { linearCache } from "../linear-cache.js";
import { resolveTransitionRule, type EffectiveTransitionRule } from "../domain-linear.js";
import { fetchLinearTeamStates, transitionLinearIssue, type LinearTeam } from "./linear-routes.js";
import {
  HIDDEN_STATE_TYPES,
  boardCacheKey,
  fetchBoardIssues,
  fetchIssue,
  fetchLinearViewer,
  fetchTeamProjects,
  firstStartedState,
  sortBoardStates,
  updateLinearIssue,
} from "../linear-board.js";
import { getAllLinearIssues } from "../session-linear-issues.js";
import { getAllNames } from "../session-names.js";

/**
 * A domain's Linear link and board:
 *  - GET/PUT/DELETE /domains/:slug/linear: the link (connection, team,
 *    optional project) and the per-domain transition rules, validated
 *    against Linear before they are saved;
 *  - GET /domains/:slug/linear/board: the team's states as columns and the
 *    issues of the project (or team), each with the Companion sessions
 *    linked to it;
 *  - POST …/issues/:id/state and …/issues/:id/take: move an issue, or assign
 *    it to the connection's user and start it.
 * Responses carry ids and names only, never the connection's API key.
 */

/** The sessions the board lists under each issue. */
export interface BoardSessionSource {
  listSessions(): { sessionId: string; archived?: boolean; backendType?: string; domain?: string }[];
}

export interface DomainLinearView extends DomainLinearLink {
  connectionName: string;
  workspaceName: string;
  /** The link points at a connection that no longer exists. */
  broken?: "connection_missing";
}

function linkView(link: DomainLinearLink): DomainLinearView {
  const conn = getConnection(link.connectionId);
  return {
    ...link,
    connectionName: conn?.name ?? "",
    workspaceName: conn?.workspaceName ?? "",
    ...(conn ? {} : { broken: "connection_missing" as const }),
  };
}

function findDomain(slug: string): DomainInfo | undefined {
  return slug === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(slug);
}

type Fail = { ok: false; status: 400 | 404 | 409 | 502; error: string; reason?: string };

/** The domain, its link, the link's API key and team (states included), or why the board cannot load. */
async function linkedTeam(slug: string): Promise<
  { ok: true; domain: DomainInfo; link: DomainLinearLink; apiKey: string; team: LinearTeam } | Fail
> {
  const domain = findDomain(slug);
  if (!domain) return { ok: false, status: 404, error: "Domain not found" };
  const link = domain.linear;
  if (!link) return { ok: false, status: 404, error: "This domain is not linked to Linear", reason: "not_linked" };
  const conn = getConnection(link.connectionId);
  if (!conn?.apiKey.trim()) {
    return { ok: false, status: 409, error: "The Linear connection of this domain was removed", reason: "connection_missing" };
  }
  const teams = await fetchLinearTeamStates(conn.apiKey.trim(), conn.id);
  if (teams.length === 0) return { ok: false, status: 502, error: "Could not read the teams from Linear" };
  const team = teams.find((t) => t.id === link.teamId);
  if (!team) return { ok: false, status: 409, error: "The linked team is no longer in this workspace", reason: "team_missing" };
  return { ok: true, domain, link, apiKey: conn.apiKey.trim(), team };
}

/**
 * A rule from the request: null = back to the connection's setting
 * (undefined), {enabled:false} = off, {enabled:true, stateId} = a state of
 * the team. Returns an error string when the state is not the team's.
 */
function parseRule(raw: unknown, team: LinearTeam): DomainLinearRule | undefined | string {
  if (raw === null) return undefined;
  if (!raw || typeof raw !== "object") return "a rule must be null or {enabled, stateId}";
  const r = raw as { enabled?: unknown; stateId?: unknown };
  if (typeof r.enabled !== "boolean") return "enabled must be a boolean";
  if (!r.enabled) return { enabled: false, stateId: "", stateName: "" };
  const state = team.states.find((s) => s.id === r.stateId);
  if (!state) return `No state "${String(r.stateId)}" in team ${team.key}`;
  return { enabled: true, stateId: state.id, stateName: state.name };
}

function ruleView(rule: EffectiveTransitionRule) {
  return { enabled: rule.enabled, stateId: rule.stateId, stateName: rule.stateName, source: rule.source };
}

export function registerDomainLinearRoutes(api: Hono, sessions: BoardSessionSource): void {
  api.get("/domains/:slug/linear", (c) => {
    const domain = findDomain(c.req.param("slug"));
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const link = domain.linear;
    if (!link) return c.json({ link: null });
    return c.json({
      link: linkView(link),
      // What actually applies (own rule, else the connection's), for the Linear tab.
      rules: {
        start: ruleView(resolveTransitionRule("start", { link, connectionId: link.connectionId, teamId: link.teamId })),
        archive: ruleView(resolveTransitionRule("archive", { link, connectionId: link.connectionId, teamId: link.teamId })),
      },
    });
  });

  api.put("/domains/:slug/linear", async (c) => {
    const slug = c.req.param("slug");
    const domain = findDomain(slug);
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
    const teamId = typeof body.teamId === "string" ? body.teamId.trim() : "";
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!connectionId || !teamId) return c.json({ error: "connectionId and teamId are required" }, 400);
    const conn = getConnection(connectionId);
    if (!conn?.apiKey.trim()) return c.json({ error: "Linear connection not found" }, 400);
    const apiKey = conn.apiKey.trim();

    const teams = await fetchLinearTeamStates(apiKey, conn.id);
    if (teams.length === 0) return c.json({ error: "Could not read the teams from Linear" }, 502);
    const team = teams.find((t) => t.id === teamId);
    if (!team) return c.json({ error: `No team "${teamId}" in workspace ${conn.workspaceName || conn.name}` }, 400);

    const link: DomainLinearLink = { connectionId, teamId, teamKey: team.key, teamName: team.name };
    if (projectId) {
      let projects;
      try {
        projects = await fetchTeamProjects(apiKey, conn.id, teamId);
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "Could not read the team's projects" }, 502);
      }
      const project = projects.find((p) => p.id === projectId);
      if (!project) return c.json({ error: `No project "${projectId}" in team ${team.key}` }, 400);
      link.projectId = project.id;
      link.projectName = project.name;
    }

    // Rules name states of one team: kept when the team does not change and
    // the request leaves them out, dropped (back to the connection's) otherwise.
    const sameTeam = domain.linear?.connectionId === connectionId && domain.linear.teamId === teamId;
    for (const key of ["autoTransition", "archiveTransition"] as const) {
      if (body[key] === undefined) {
        if (sameTeam && domain.linear?.[key]) link[key] = domain.linear[key];
        continue;
      }
      const rule = parseRule(body[key], team);
      if (typeof rule === "string") return c.json({ error: `${key}: ${rule}` }, 400);
      if (rule) link[key] = rule;
    }

    const result = setDomainLinear(slug, link);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ link: linkView(result.domain.linear!) });
  });

  api.delete("/domains/:slug/linear", (c) => {
    const slug = c.req.param("slug");
    if (!findDomain(slug)) return c.json({ error: "Domain not found" }, 404);
    const result = setDomainLinear(slug, null);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true });
  });

  // Projects of one team, for the link picker (teams come from GET /linear/states).
  api.get("/linear/teams/:teamId/projects", async (c) => {
    const conn = getConnection(c.req.query("connectionId") || "");
    if (!conn?.apiKey.trim()) return c.json({ error: "Linear connection not found" }, 400);
    try {
      return c.json({ projects: await fetchTeamProjects(conn.apiKey.trim(), conn.id, c.req.param("teamId")) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  api.get("/domains/:slug/linear/board", async (c) => {
    const r = await linkedTeam(c.req.param("slug"));
    if (!r.ok) return c.json({ error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, r.status);
    const { link, apiKey, team } = r;
    if (c.req.query("refresh") === "1") linearCache.invalidate(boardCacheKey(link.connectionId, link.teamId, link.projectId));
    try {
      const [viewer, board] = await Promise.all([
        fetchLinearViewer(apiKey, link.connectionId),
        fetchBoardIssues(apiKey, link.connectionId, link.teamId, link.projectId),
      ]);
      return c.json({
        link: linkView(link),
        team: { id: team.id, key: team.key, name: team.name },
        states: sortBoardStates(team.states).map((s) => ({ ...s, hidden: HIDDEN_STATE_TYPES.has(s.type) })),
        viewer,
        issues: board.issues,
        truncated: board.truncated,
        sessions: linkedSessions(sessions, new Set(board.issues.map((i) => i.id))),
        fetchedAt: Date.now(),
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });

  api.post("/domains/:slug/linear/issues/:issueId/state", async (c) => {
    const r = await linkedTeam(c.req.param("slug"));
    if (!r.ok) return c.json({ error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, r.status);
    const body = (await c.req.json().catch(() => ({}))) as { stateId?: unknown };
    const state = r.team.states.find((s) => s.id === body.stateId);
    if (!state) return c.json({ error: `No state "${String(body.stateId)}" in team ${r.team.key}` }, 400);
    const issueId = c.req.param("issueId");
    const result = await transitionLinearIssue(issueId, state.id, r.apiKey, r.link.connectionId);
    if (!result.ok) return c.json({ error: result.error }, 502);
    linearCache.invalidate(boardCacheKey(r.link.connectionId, r.link.teamId, r.link.projectId));
    return c.json({ ok: true, issue: result.issue });
  });

  // "Take it": assign to the connection's user and, when the issue has not
  // started yet, move it to the team's first "started" state. An issue
  // already started (or further) keeps its state: never moved backwards.
  api.post("/domains/:slug/linear/issues/:issueId/take", async (c) => {
    const r = await linkedTeam(c.req.param("slug"));
    if (!r.ok) return c.json({ error: r.error, ...(r.reason ? { reason: r.reason } : {}) }, r.status);
    const { link, apiKey, team } = r;
    try {
      const [viewer, current] = await Promise.all([
        fetchLinearViewer(apiKey, link.connectionId),
        fetchIssue(apiKey, c.req.param("issueId")),
      ]);
      if (current.teamId !== team.id) return c.json({ error: `${current.identifier} is not an issue of team ${team.key}` }, 400);
      if (!viewer.id) return c.json({ error: "Could not tell which Linear user this connection belongs to" }, 502);
      const started = firstStartedState(team.states);
      const notStarted = ["triage", "backlog", "unstarted"].includes(current.stateType);
      const stateId = notStarted && started ? started.id : undefined;
      const issue = await updateLinearIssue(apiKey, current.id, { assigneeId: viewer.id, ...(stateId ? { stateId } : {}) });
      linearCache.invalidate(boardCacheKey(link.connectionId, link.teamId, link.projectId));
      linearCache.invalidate(`${link.connectionId}:issue:${current.id}`);
      return c.json({ ok: true, issue, moved: !!stateId, connectionId: link.connectionId });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Linear request failed" }, 502);
    }
  });
}

/** issueId → the sessions linked to it (session-linear-issues.json), any domain, newest first. */
function linkedSessions(source: BoardSessionSource, issueIds: Set<string>) {
  const links = getAllLinearIssues();
  const names = getAllNames();
  const out: Record<string, { sessionId: string; name: string; archived: boolean; backendType: string; domain: string }[]> = {};
  for (const s of [...source.listSessions()].reverse()) {
    const issue = links[s.sessionId];
    if (!issue || !issueIds.has(issue.id)) continue;
    (out[issue.id] ??= []).push({
      sessionId: s.sessionId,
      name: names[s.sessionId] || s.sessionId.slice(0, 8),
      archived: !!s.archived,
      backendType: s.backendType || "claude",
      domain: s.domain || GLOBAL_DOMAIN,
    });
  }
  return out;
}
