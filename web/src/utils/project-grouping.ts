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
  /** Domain slug (absent = GLOBAL). */
  domain?: string;
  /** From before domains (keeps its own folder memory). */
  legacyMemory?: boolean;
}

export interface ProjectGroup {
  key: string;
  label: string;
  /** The full folder path, for the tooltip. */
  title?: string;
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

  // Labels must tell folders apart: two folders named "web" get "herd/web"
  // and "fork/web".
  const labels = uniqueFolderLabels([...groups.keys()]);
  for (const group of groups.values()) {
    group.label = labels.get(group.key) ?? group.label;
    group.title = group.key;
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

/**
 * Short, unambiguous labels for folder paths. A folder inside `base` (its
 * domain folder) is named by its path relative to it; any other folder by
 * its last path component, extended with parent components while two
 * folders would otherwise share a label.
 */
export function uniqueFolderLabels(keys: string[], base?: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = new Map<string, string[]>();
  const depth = new Map<string, number>();
  const root = base?.replace(/\/+$/, "");
  for (const key of keys) {
    if (root && (key === root || key.startsWith(`${root}/`))) {
      out.set(key, key === root ? "(domain folder)" : key.slice(root.length + 1));
      continue;
    }
    const segs = key.split("/").filter(Boolean);
    parts.set(key, segs);
    depth.set(key, 1);
  }
  const labelOf = (key: string) => {
    const segs = parts.get(key)!;
    return segs.length === 0 ? "/" : segs.slice(-(depth.get(key) ?? 1)).join("/");
  };
  for (let round = 0; round < 64; round++) {
    const byLabel = new Map<string, string[]>();
    for (const key of parts.keys()) {
      const label = labelOf(key);
      byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
    }
    let grew = false;
    for (const same of byLabel.values()) {
      if (same.length < 2) continue;
      for (const key of same) {
        if ((depth.get(key) ?? 1) < parts.get(key)!.length) {
          depth.set(key, (depth.get(key) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  for (const key of parts.keys()) out.set(key, labelOf(key));
  return out;
}

export interface DomainRef {
  slug: string;
  name: string;
  /** The domain folder, so folders inside it get short relative labels. */
  path?: string;
}

export interface DomainGroup {
  /** Domain slug. */
  key: string;
  label: string;
  /** Folder groups of the domain's sessions. */
  groups: ProjectGroup[];
  sessionCount: number;
  runningCount: number;
  permCount: number;
}

/**
 * Sidebar grouping: by domain (GLOBAL first, then by name), then by the
 * session's own folder. Sessions without a domain (legacy) are GLOBAL's.
 */
export function groupSessionsByDomain(sessions: SessionItem[], domains: DomainRef[]): DomainGroup[] {
  const buckets = new Map<string, SessionItem[]>();
  for (const session of sessions) {
    const slug = session.domain || "global";
    buckets.set(slug, [...(buckets.get(slug) ?? []), session]);
  }
  const result: DomainGroup[] = [];
  for (const [slug, list] of buckets) {
    const ref = domains.find((d) => d.slug === slug);
    const groups = groupSessionsByProject(list);
    const labels = uniqueFolderLabels(groups.map((g) => g.key), ref?.path);
    for (const g of groups) g.label = labels.get(g.key) ?? g.label;
    groups.sort((a, b) => a.label.localeCompare(b.label));
    result.push({
      key: slug,
      label: ref?.name ?? (slug === "global" ? "GLOBAL" : slug),
      groups,
      sessionCount: list.length,
      runningCount: groups.reduce((n, g) => n + g.runningCount, 0),
      permCount: groups.reduce((n, g) => n + g.permCount, 0),
    });
  }
  return result.sort((a, b) => {
    if (a.key === "global") return -1;
    if (b.key === "global") return 1;
    return a.label.localeCompare(b.label);
  });
}
