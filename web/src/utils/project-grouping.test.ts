import { describe, it, expect } from "vitest";
import {
  extractProjectKey,
  extractProjectLabel,
  groupSessionsByDomain,
  groupSessionsByProject,
  uniqueFolderLabels,
  type SessionItem,
} from "./project-grouping.js";

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

describe("extractProjectKey", () => {
  // Sessions are grouped by their own folder, never by the git repo root
  // (domains work): a worktree is its own group.
  it("keys a worktree on its own folder, not on its repo root", () => {
    expect(extractProjectKey("/home/user/myapp-wt-1234")).toBe("/home/user/myapp-wt-1234");
  });

  it("falls back to cwd when repoRoot is undefined", () => {
    expect(extractProjectKey("/home/user/projects/myapp")).toBe(
      "/home/user/projects/myapp",
    );
  });

  it("removes trailing slashes", () => {
    expect(extractProjectKey("/home/user/myapp/")).toBe("/home/user/myapp");
  });

  it("returns / for empty cwd", () => {
    expect(extractProjectKey("")).toBe("/");
  });

  // A session in a repo subfolder loads that subfolder's CLAUDE.md and
  // skills, so it is grouped there, not under the repo root.
  it("keys a repo subfolder on itself", () => {
    expect(extractProjectKey("/home/user/myapp/web")).toBe("/home/user/myapp/web");
  });

});

describe("extractProjectLabel", () => {
  it("returns last path component for normal paths", () => {
    expect(extractProjectLabel("/home/user/projects/myapp")).toBe("myapp");
  });

  it("returns / for root path", () => {
    expect(extractProjectLabel("/")).toBe("/");
  });

  it("handles single component path", () => {
    expect(extractProjectLabel("/myapp")).toBe("myapp");
  });

  it("handles deep nested paths", () => {
    expect(extractProjectLabel("/a/b/c/d/e")).toBe("e");
  });
});

describe("groupSessionsByProject", () => {
  it("groups sessions sharing the same cwd into one group", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/home/user/myapp" }),
      makeItem({ id: "s2", cwd: "/home/user/myapp" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[0].label).toBe("myapp");
  });

  it("keeps a worktree session apart from its parent repo", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/home/user/myapp", repoRoot: "/home/user/myapp" }),
      makeItem({ id: "s2", cwd: "/home/user/myapp-wt-1234", repoRoot: "/home/user/myapp" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(["myapp", "myapp-wt-1234"]);
  });

  it("sorts groups alphabetically by label", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/zebra", createdAt: 200 }),
      makeItem({ id: "s2", cwd: "/a/alpha", createdAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].label).toBe("alpha");
    expect(groups[1].label).toBe("zebra");
  });

  it("sorts sessions within group by createdAt desc regardless of status", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 100, status: "running" }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 200, status: null }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
  });

  it("handles sessions with empty cwd as a separate group", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app" }),
      makeItem({ id: "s2", cwd: "" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
  });

  it("computes aggregate runningCount and permCount", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", status: "running", permCount: 1 }),
      makeItem({ id: "s2", cwd: "/a/app", status: "running", permCount: 2 }),
      makeItem({ id: "s3", cwd: "/a/app", status: null, permCount: 0 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].runningCount).toBe(2);
    expect(groups[0].permCount).toBe(3);
  });

  it("creates separate groups for different directories", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app1" }),
      makeItem({ id: "s2", cwd: "/a/app2" }),
      makeItem({ id: "s3", cwd: "/a/app1" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
  });

  it("does not reorder sessions when status changes from idle to running", () => {
    // Simulate initial state: all idle, ordered by createdAt
    const sessionsIdle = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: null }),
    ];
    const groupsBefore = groupSessionsByProject(sessionsIdle);
    const orderBefore = groupsBefore[0].sessions.map((s) => s.id);

    // Simulate s3 (oldest) starting to run
    const sessionsWithRunning = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: "running" }),
    ];
    const groupsAfter = groupSessionsByProject(sessionsWithRunning);
    const orderAfter = groupsAfter[0].sessions.map((s) => s.id);

    expect(orderBefore).toEqual(orderAfter);
  });

  it("maintains stable order with mixed running/idle/compacting statuses", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 500, status: "idle" }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 400, status: "running" }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 300, status: "compacting" }),
      makeItem({ id: "s4", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s5", cwd: "/a/app", createdAt: 100, status: "running" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("tracks mostRecentActivity as max createdAt in group", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 500 }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 300 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].mostRecentActivity).toBe(500);
  });

  it("returns empty array for empty input", () => {
    expect(groupSessionsByProject([])).toEqual([]);
  });

  it("handles a single session as its own group", () => {
    const sessions = [makeItem({ id: "s1", cwd: "/a/solo" })];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(1);
    expect(groups[0].label).toBe("solo");
  });

  it("order is stable across repeated calls with same input", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: "running" }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: "running" }),
      makeItem({ id: "s4", cwd: "/b/other", createdAt: 400, status: null }),
    ];
    const first = groupSessionsByProject(sessions);
    const second = groupSessionsByProject(sessions);
    expect(first.map((g) => g.key)).toEqual(second.map((g) => g.key));
    for (let i = 0; i < first.length; i++) {
      expect(first[i].sessions.map((s) => s.id)).toEqual(second[i].sessions.map((s) => s.id));
    }
  });

  it("sessions with identical createdAt maintain consistent order", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions).toHaveLength(3);
  });

  it("groups across multiple projects each sort independently by createdAt", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/proj-a", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/proj-b", createdAt: 400 }),
      makeItem({ id: "s3", cwd: "/a/proj-a", createdAt: 300 }),
      makeItem({ id: "s4", cwd: "/a/proj-b", createdAt: 200 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].label).toBe("proj-a");
    expect(groups[1].label).toBe("proj-b");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s3", "s1"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s2", "s4"]);
  });

  it("gives every worktree of a repo its own group", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/home/user/repo", repoRoot: "/home/user/repo", createdAt: 300 }),
      makeItem({ id: "s2", cwd: "/home/user/repo-wt-feat1", repoRoot: "/home/user/repo", createdAt: 200 }),
      makeItem({ id: "s3", cwd: "/home/user/repo-wt-feat2", repoRoot: "/home/user/repo", createdAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([["s1"], ["s2"], ["s3"]]);
  });

  // Two folders with the same name must not look the same in the sidebar.
  it("disambiguates folders that share a name", () => {
    const groups = groupSessionsByProject([
      makeItem({ id: "s1", cwd: "/home/u/herd/web" }),
      makeItem({ id: "s2", cwd: "/home/u/fork/web" }),
      makeItem({ id: "s3", cwd: "/home/u/solo" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["fork/web", "herd/web", "solo"]);
    expect(groups[0].title).toBe("/home/u/fork/web");
  });

});

describe("uniqueFolderLabels", () => {
  it("names folders inside the domain folder by their relative path", () => {
    const labels = uniqueFolderLabels(["/h/companion_domain_x/a", "/h/companion_domain_x", "/h/companion_domain_x/a/b", "/repo/web"], "/h/companion_domain_x/");
    expect(Object.fromEntries(labels)).toEqual({
      "/h/companion_domain_x/a": "a",
      "/h/companion_domain_x": "(domain folder)",
      "/h/companion_domain_x/a/b": "a/b",
      "/repo/web": "web",
    });
  });

  it("extends only the clashing labels, as far as needed", () => {
    const labels = uniqueFolderLabels(["/a/x/web", "/b/x/web", "/c/web", "/"]);
    expect(Object.fromEntries(labels)).toEqual({ "/a/x/web": "a/x/web", "/b/x/web": "b/x/web", "/c/web": "c/web", "/": "/" });
  });
});

describe("groupSessionsByDomain", () => {
  // Sidebar: domain first (GLOBAL on top), then the session's own folder.
  it("groups by domain, then by folder, with GLOBAL first", () => {
    const groups = groupSessionsByDomain([
      makeItem({ id: "s1", cwd: "/h/companion_domain_herd/one", domain: "herd", status: "running", permCount: 1 }),
      makeItem({ id: "s2", cwd: "/repos/herd-app", domain: "herd" }),
      makeItem({ id: "s3", cwd: "/home/u/old", legacyMemory: true }),
      makeItem({ id: "s4", cwd: "/home/u/new", domain: "global" }),
      makeItem({ id: "s5", cwd: "/x", domain: "alpha" }),
    ], [
      { slug: "herd", name: "Herd", path: "/h/companion_domain_herd" },
      { slug: "global", name: "GLOBAL", path: "/h/companion_domain_global" },
    ]);
    expect(groups.map((g) => [g.key, g.label, g.sessionCount])).toEqual([
      ["global", "GLOBAL", 2],
      ["alpha", "alpha", 1],
      ["herd", "Herd", 2],
    ]);
    const herd = groups[2];
    expect(herd.groups.map((g) => g.label)).toEqual(["herd-app", "one"]);
    expect(herd.runningCount).toBe(1);
    expect(herd.permCount).toBe(1);
    expect(groupSessionsByDomain([makeItem({ domain: "global" })], [])[0].label).toBe("GLOBAL");
  });
});
