import type { BoardIssue, BoardLabel, BoardState, LinearIssue, TakenIssue } from "../api.js";

/**
 * Pure helpers of the domain Linear board (DomainBoard.tsx) and the hand-off
 * from the board's "Take it" to the Home page, which then starts a session
 * in the domain linked to the issue through its usual flow.
 */

/** "Soak: soak 24h" for a label of a group, the bare name otherwise. */
export function labelText(label: BoardLabel): string {
  return label.group ? `${label.group}: ${label.name}` : label.name;
}

/**
 * The columns to show and their issues. Canceled/duplicate states only with
 * `showHidden`; `mineId` keeps the issues assigned to that user. Issues in a
 * state the board does not show are left out.
 */
export function boardColumns(
  states: BoardState[],
  issues: BoardIssue[],
  opts: { showHidden: boolean; mineId?: string },
): { state: BoardState; issues: BoardIssue[] }[] {
  const shown = states.filter((s) => opts.showHidden || !s.hidden);
  const kept = opts.mineId ? issues.filter((i) => i.assignee?.id === opts.mineId) : issues;
  return shown.map((state) => ({
    state,
    issues: kept
      .filter((i) => i.stateId === state.id)
      // Urgent first (1), "no priority" (0) last, then most recently updated.
      .sort((a, b) => rankPriority(a.priority) - rankPriority(b.priority) || b.updatedAt.localeCompare(a.updatedAt)),
  }));
}

function rankPriority(p: number): number {
  return p > 0 ? p : 5;
}

/** Initials for an avatar without a picture ("Marco Monaco" → "MM"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** A taken board issue in the shape the Home page links to a new session. */
export function toLinearIssue(issue: TakenIssue, connectionId: string): LinearIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    branchName: issue.branchName,
    priorityLabel: issue.priorityLabel,
    stateName: issue.stateName,
    stateType: issue.stateType,
    teamName: issue.teamName,
    teamKey: issue.teamKey,
    teamId: issue.teamId,
    assigneeName: issue.assignee?.name,
    connectionId,
  };
}

// ── Hand-off to the Home page ───────────────────────────────────────────────

const HANDOFF_KEY = "cc-linear-handoff";

export interface LinearHandoff {
  domain: string;
  connectionId: string;
  issue: LinearIssue;
}

/** Remember the issue to start a session on; the Home page picks it up once. */
export function setLinearHandoff(handoff: LinearHandoff): void {
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
}

/** The pending hand-off, removed as it is read (a reload does not repeat it). */
export function takeLinearHandoff(): LinearHandoff | null {
  const raw = sessionStorage.getItem(HANDOFF_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(HANDOFF_KEY);
  try {
    const parsed = JSON.parse(raw) as Partial<LinearHandoff>;
    if (typeof parsed.domain !== "string" || typeof parsed.connectionId !== "string" || !parsed.issue?.id) return null;
    return parsed as LinearHandoff;
  } catch {
    return null;
  }
}
