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
  /** Delivered a result the user has not seen yet. */
  unread?: boolean;
  /** Doing work that must not be interrupted (turn, tool call, background work). */
  busy?: boolean;
  agentId?: string;
  agentName?: string;
  /** Domain slug (absent = GLOBAL). */
  domain?: string;
  /** From before domains (keeps its own folder memory). */
  legacyMemory?: boolean;
  /** Runs on a local provider (badge "LO"). */
  local?: import("../types.js").SdkSessionInfo["local"];
}

export interface DomainRef {
  slug: string;
  name: string;
}

export interface DomainGroup {
  /** Domain slug. */
  key: string;
  label: string;
  /** The domain's sessions, newest first. */
  sessions: SessionItem[];
  sessionCount: number;
  runningCount: number;
  permCount: number;
  /** Sessions with a result the user has not seen (the header's badge). */
  unreadCount: number;
}

/**
 * Sidebar grouping: by domain (GLOBAL first, then by name), and inside a
 * domain its sessions, newest first. There is no folder level: the domain is
 * what sessions share (memory, skills, MCP servers), and each row already
 * shows its folder. The order is by creation only, so a session never moves
 * when it starts or stops running. Sessions without a domain are GLOBAL's.
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
    result.push({
      key: slug,
      label: ref?.name ?? (slug === "global" ? "GLOBAL" : slug),
      sessions: [...list].sort((a, b) => b.createdAt - a.createdAt),
      sessionCount: list.length,
      runningCount: list.filter((s) => s.status === "running").length,
      permCount: list.reduce((n, s) => n + s.permCount, 0),
      unreadCount: list.filter((s) => s.unread).length,
    });
  }
  return result.sort((a, b) => {
    if (a.key === "global") return -1;
    if (b.key === "global") return 1;
    return a.label.localeCompare(b.label);
  });
}
