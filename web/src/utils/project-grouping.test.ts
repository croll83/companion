import { describe, it, expect } from "vitest";
import { groupSessionsByDomain, type SessionItem } from "./project-grouping.js";

function makeItem(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: "s1",
    model: "claude-sonnet-4-6",
    cwd: "/home/user/projects/myapp",
    gitBranch: "",
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    isReconnecting: false,
    status: null,
    sdkState: null,
    createdAt: 1000,
    archived: false,
    backendType: "claude",
    repoRoot: "",
    permCount: 0,
    ...overrides,
  };
}

const ids = (list: SessionItem[]) => list.map((s) => s.id);

describe("groupSessionsByDomain", () => {
  // Sidebar: domain first (GLOBAL on top, then by name), then its sessions.
  // There is no folder level: sessions of one domain in different folders
  // sit in the same list.
  it("groups by domain with GLOBAL first, sessions directly inside, whatever their folder", () => {
    const groups = groupSessionsByDomain([
      makeItem({ id: "s1", cwd: "/h/companion_domain_herd/one", domain: "herd", status: "running", permCount: 1, createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/repos/herd-app", domain: "herd", createdAt: 200, unread: true }),
      makeItem({ id: "s3", cwd: "/home/u/old", legacyMemory: true }),
      makeItem({ id: "s4", cwd: "/home/u/new", domain: "global" }),
      makeItem({ id: "s5", cwd: "/x", domain: "alpha" }),
    ], [
      { slug: "herd", name: "Herd" },
      { slug: "global", name: "GLOBAL" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.sessionCount])).toEqual([
      ["global", "GLOBAL", 2],
      ["alpha", "alpha", 1],
      ["herd", "Herd", 2],
    ]);
    const herd = groups[2];
    expect(ids(herd.sessions)).toEqual(["s2", "s1"]);
    expect(herd.runningCount).toBe(1);
    expect(herd.permCount).toBe(1);
    // The header's badge: sessions with a result not seen yet.
    expect(herd.unreadCount).toBe(1);
    expect(groups[0].unreadCount).toBe(0);
    // Without the domain list (not loaded yet) GLOBAL still gets its name.
    expect(groupSessionsByDomain([makeItem({ domain: "global" })], [])[0].label).toBe("GLOBAL");
  });

  it("returns an empty list for no sessions", () => {
    expect(groupSessionsByDomain([], [])).toEqual([]);
  });

  // Sessions are ordered by creation only, newest first, so a row never
  // jumps when its session starts or stops running.
  it("sorts a domain's sessions by createdAt desc regardless of status", () => {
    const [g] = groupSessionsByDomain([
      makeItem({ id: "s1", createdAt: 300, status: null }),
      makeItem({ id: "s2", createdAt: 100, status: "running" }),
      makeItem({ id: "s3", createdAt: 200, status: "compacting" }),
    ], []);
    expect(ids(g.sessions)).toEqual(["s1", "s3", "s2"]);
  });

  it("does not reorder sessions when one starts running", () => {
    const before = groupSessionsByDomain([
      makeItem({ id: "s1", createdAt: 300 }),
      makeItem({ id: "s2", createdAt: 200 }),
      makeItem({ id: "s3", createdAt: 100 }),
    ], []);
    const after = groupSessionsByDomain([
      makeItem({ id: "s1", createdAt: 300 }),
      makeItem({ id: "s2", createdAt: 200 }),
      makeItem({ id: "s3", createdAt: 100, status: "running" }),
    ], []);
    expect(ids(after[0].sessions)).toEqual(ids(before[0].sessions));
  });

  it("adds up running sessions and pending permissions per domain", () => {
    const groups = groupSessionsByDomain([
      makeItem({ id: "s1", domain: "a", status: "running", permCount: 1 }),
      makeItem({ id: "s2", domain: "a", status: "running", permCount: 2 }),
      makeItem({ id: "s3", domain: "a", status: "idle" }),
      makeItem({ id: "s4", domain: "b", status: "running" }),
    ], []);
    expect(groups.map((g) => [g.key, g.runningCount, g.permCount])).toEqual([["a", 2, 3], ["b", 1, 0]]);
  });

  it("does not mutate the input list", () => {
    const input = [makeItem({ id: "s1", createdAt: 1 }), makeItem({ id: "s2", createdAt: 2 })];
    groupSessionsByDomain(input, []);
    expect(ids(input)).toEqual(["s1", "s2"]);
  });
});
