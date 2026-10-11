export interface SessionItem {
  id: string;
  model: string;
  cwd: string;
  gitBranch: string;
  gitAhead: number;
  gitBehind: number;
  linesAdded: number;
  linesRemoved: number;
  isConnected: boolean;
  isReconnecting: boolean;
  status: "idle" | "running" | "compacting" | null;
  sdkState: "starting" | "connected" | "running" | "exited" | null;
  createdAt: number;
  archived: boolean;
  backendType: "claude" | "codex";
  repoRoot: string;
  permCount: number;
  agentId?: string;
  agentName?: string;
}

export interface ProjectGroup {
  key: string;
  label: string;
  sessions: SessionItem[];
  runningCount: number;
  permCount: number;
  mostRecentActivity: number;
}

/**
 * Extracts a project key from a session's folder.
 *
 * Sessions are grouped by their own folder, never by a parent or the git
 * repo root: a session in ~/dev goes under "dev", one in ~/dev/herd under
 * "herd", one in ~/dev/herd/feature-1 under "feature-1". The folder is what
 * Claude Code scopes CLAUDE.md, skills and settings to, so the grouping
 * matches what each session actually loads.
 */
export function extractProjectKey(cwd: string): string {
  return cwd.replace(/\/+$/, "") || "/";
}

/**
 * Extracts a display label from a project key (last path component).
 */
export function extractProjectLabel(projectKey: string): string {
  if (projectKey === "/") return "/";
  const parts = projectKey.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts[parts.length - 1];
}

/**
 * Groups sessions by project directory, sorts groups by most recent activity,
 * and sorts sessions within each group (running first, then by createdAt desc).
 */
export function groupSessionsByProject(
  sessions: SessionItem[],
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  for (const session of sessions) {
    const key = extractProjectKey(session.cwd);
    const label = extractProjectLabel(key);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label,
        sessions: [],
        runningCount: 0,
        permCount: 0,
        mostRecentActivity: 0,
      });
    }

    const group = groups.get(key)!;
    group.sessions.push(session);
    if (session.status === "running") group.runningCount++;
    group.permCount += session.permCount;
    group.mostRecentActivity = Math.max(group.mostRecentActivity, session.createdAt);
  }

  // Sort groups alphabetically by label (stable, predictable order)
  const sorted = Array.from(groups.values()).sort(
    (a, b) => a.label.localeCompare(b.label),
  );

  // Within each group, sort sessions by createdAt desc (stable order, no reordering on status change)
  for (const group of sorted) {
    group.sessions.sort((a, b) => b.createdAt - a.createdAt);
  }

  return sorted;
}
