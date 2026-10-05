import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionStore } from "./execution-store.js";
import type { AgentExecution } from "./agent-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let testDir: string;

/** Create a test execution fixture with sensible defaults. */
function makeExecution(overrides: Partial<AgentExecution> = {}): AgentExecution {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-1",
    triggerType: "manual",
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  // Create a unique temp directory for each test
  testDir = join(tmpdir(), `execution-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
});

afterEach(() => {
  // Clean up temp directory after each test
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ExecutionStore", () => {
  it("creates the storage directory on construction", () => {
    // The constructor should create the directory if it doesn't exist
    const store = new ExecutionStore(testDir);
    expect(existsSync(testDir)).toBe(true);
  });

  it("appends an execution to a daily JSONL file", () => {
    const store = new ExecutionStore(testDir);
    const exec = makeExecution({ startedAt: new Date("2026-03-04T12:00:00Z").getTime() });

    store.append(exec);

    // Verify the file exists and contains the execution
    const files = readdirSync(testDir);
    expect(files).toContain("executions-2026-03-04.jsonl");

    const content = readFileSync(join(testDir, "executions-2026-03-04.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).sessionId).toBe(exec.sessionId);
  });

  it("groups executions into daily files based on startedAt timestamp", () => {
    const store = new ExecutionStore(testDir);

    // Two executions on different days
    store.append(makeExecution({ startedAt: new Date("2026-03-01T10:00:00Z").getTime() }));
    store.append(makeExecution({ startedAt: new Date("2026-03-02T10:00:00Z").getTime() }));

    const files = readdirSync(testDir).sort();
    expect(files).toEqual(["executions-2026-03-01.jsonl", "executions-2026-03-02.jsonl"]);
  });

  it("appends multiple executions to the same daily file", () => {
    const store = new ExecutionStore(testDir);
    const day = new Date("2026-03-04T00:00:00Z").getTime();

    store.append(makeExecution({ startedAt: day + 1000 }));
    store.append(makeExecution({ startedAt: day + 2000 }));
    store.append(makeExecution({ startedAt: day + 3000 }));

    const content = readFileSync(join(testDir, "executions-2026-03-04.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  describe("list()", () => {
    it("returns all executions sorted by startedAt descending", () => {
      const store = new ExecutionStore(testDir);
      const exec1 = makeExecution({ startedAt: 1000, agentId: "a1" });
      const exec2 = makeExecution({ startedAt: 3000, agentId: "a2" });
      const exec3 = makeExecution({ startedAt: 2000, agentId: "a3" });

      store.append(exec1);
      store.append(exec2);
      store.append(exec3);

      const result = store.list();
      // Most recent first
      expect(result.executions.map((e) => e.agentId)).toEqual(["a2", "a3", "a1"]);
      expect(result.total).toBe(3);
    });

    it("filters by agentId", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ agentId: "agent-a", startedAt: 1000 }));
      store.append(makeExecution({ agentId: "agent-b", startedAt: 2000 }));
      store.append(makeExecution({ agentId: "agent-a", startedAt: 3000 }));

      const result = store.list({ agentId: "agent-a" });
      expect(result.executions).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.executions.every((e) => e.agentId === "agent-a")).toBe(true);
    });

    it("filters by triggerType", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ triggerType: "manual", startedAt: 1000 }));
      store.append(makeExecution({ triggerType: "webhook", startedAt: 2000 }));
      store.append(makeExecution({ triggerType: "linear", startedAt: 3000 }));

      const result = store.list({ triggerType: "linear" });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].triggerType).toBe("linear");
    });

    it("filters by status: running (no completedAt)", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ startedAt: 1000 })); // running — no completedAt
      store.append(makeExecution({ startedAt: 2000, completedAt: 3000, success: true }));

      const result = store.list({ status: "running" });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].completedAt).toBeUndefined();
    });

    it("filters by status: success", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ startedAt: 1000, success: true }));
      store.append(makeExecution({ startedAt: 2000, error: "fail" }));

      const result = store.list({ status: "success" });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].success).toBe(true);
    });

    it("filters by status: error", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ startedAt: 1000, success: true }));
      store.append(makeExecution({ startedAt: 2000, error: "something broke" }));

      const result = store.list({ status: "error" });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].error).toBe("something broke");
    });

    it("paginates results with limit and offset", () => {
      const store = new ExecutionStore(testDir);
      for (let i = 0; i < 10; i++) {
        store.append(makeExecution({ startedAt: i * 1000 }));
      }

      const page1 = store.list({ limit: 3, offset: 0 });
      expect(page1.executions).toHaveLength(3);
      expect(page1.total).toBe(10);

      const page2 = store.list({ limit: 3, offset: 3 });
      expect(page2.executions).toHaveLength(3);

      // No overlap between pages
      const ids1 = page1.executions.map((e) => e.sessionId);
      const ids2 = page2.executions.map((e) => e.sessionId);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it("defaults to limit=50 and offset=0", () => {
      const store = new ExecutionStore(testDir);
      for (let i = 0; i < 60; i++) {
        store.append(makeExecution({ startedAt: i }));
      }

      const result = store.list();
      expect(result.executions).toHaveLength(50);
      expect(result.total).toBe(60);
    });
  });

  describe("update()", () => {
    it("updates a cached execution by sessionId", () => {
      const store = new ExecutionStore(testDir);
      const exec = makeExecution({ sessionId: "update-me", startedAt: 1000 });
      store.append(exec);

      store.update("update-me", { completedAt: 5000, success: true });

      const result = store.list();
      const updated = result.executions.find((e) => e.sessionId === "update-me");
      expect(updated?.completedAt).toBe(5000);
      expect(updated?.success).toBe(true);
    });

    it("does nothing if sessionId is not in cache", () => {
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ sessionId: "exists", startedAt: 1000 }));

      // Should not throw
      store.update("does-not-exist", { completedAt: 5000 });

      const result = store.list();
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].sessionId).toBe("exists");
    });

    it("persists updates to disk as a new JSONL line", () => {
      // When update() is called, it should append the updated record to the daily file.
      // This ensures updates survive server restarts.
      const store = new ExecutionStore(testDir);
      const exec = makeExecution({
        sessionId: "persist-update",
        startedAt: new Date("2026-03-04T12:00:00Z").getTime(),
      });
      store.append(exec);

      store.update("persist-update", { completedAt: Date.now(), success: true });

      // The daily file should now have 2 lines: original + updated
      const content = readFileSync(join(testDir, "executions-2026-03-04.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);

      // The second line should have the updated fields
      const updatedRecord = JSON.parse(lines[1]);
      expect(updatedRecord.sessionId).toBe("persist-update");
      expect(updatedRecord.success).toBe(true);
      expect(updatedRecord.completedAt).toBeDefined();
    });

    it("deduplicates by sessionId when reloading from disk", () => {
      // After update() appends a second line with the same sessionId,
      // a newly constructed store should dedup and only load the latest version.
      const store = new ExecutionStore(testDir);
      const exec = makeExecution({
        sessionId: "dedup-test",
        startedAt: new Date("2026-03-04T12:00:00Z").getTime(),
      });
      store.append(exec);
      store.update("dedup-test", { completedAt: 99999, success: true });

      // Create a new store that reloads from disk
      const store2 = new ExecutionStore(testDir);
      const result = store2.list();

      // Should have exactly 1 execution (deduped), not 2
      const matching = result.executions.filter((e) => e.sessionId === "dedup-test");
      expect(matching).toHaveLength(1);
      // Should have the updated fields from the most recent line
      expect(matching[0].completedAt).toBe(99999);
      expect(matching[0].success).toBe(true);
    });
  });

  describe("disk persistence and reload", () => {
    it("loads existing executions from disk on construction", () => {
      // Seed the directory with a JSONL file
      mkdirSync(testDir, { recursive: true });
      const exec = makeExecution({ startedAt: 1234567890 });
      writeFileSync(
        join(testDir, "executions-2009-02-13.jsonl"),
        JSON.stringify(exec) + "\n",
        "utf-8",
      );

      // Create a new store — it should load the seeded data
      const store = new ExecutionStore(testDir);
      const result = store.list();
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].sessionId).toBe(exec.sessionId);
    });

    it("skips malformed JSONL lines without crashing", () => {
      mkdirSync(testDir, { recursive: true });
      const exec = makeExecution({ startedAt: 1000 });
      const content = `not valid json\n${JSON.stringify(exec)}\nalso not json\n`;
      writeFileSync(join(testDir, "executions-2026-01-01.jsonl"), content, "utf-8");

      const store = new ExecutionStore(testDir);
      const result = store.list();
      // Only the valid line should be loaded
      expect(result.executions).toHaveLength(1);
    });

    it("limits in-memory cache to MAX_CACHE_SIZE", () => {
      const store = new ExecutionStore(testDir);

      // Append more than 200 executions
      for (let i = 0; i < 210; i++) {
        store.append(makeExecution({ startedAt: i }));
      }

      // The cache should be capped at 200
      const result = store.list({ limit: 300 });
      expect(result.total).toBeLessThanOrEqual(200);
    });
  });

  it("exposes the storage directory path", () => {
    const store = new ExecutionStore(testDir);
    expect(store.directory).toBe(testDir);
  });

  describe("legacy location (pre-COMPANION_HOME ~/.companion/executions)", () => {
    it("merges the legacy directory's history, newer lines in the current dir winning", () => {
      // Older versions always wrote to ~/.companion/executions even with a
      // custom COMPANION_HOME: their runs must still show in the Runs page.
      const legacyDir = `${testDir}-legacy`;
      mkdirSync(legacyDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      const old = makeExecution({ sessionId: "old", startedAt: 1000 });
      const shared = makeExecution({ sessionId: "shared", startedAt: 2000 });
      writeFileSync(join(legacyDir, "executions-2026-01-01.jsonl"), `${JSON.stringify(old)}\n${JSON.stringify(shared)}\n`);
      writeFileSync(join(testDir, "executions-2026-01-01.jsonl"), `${JSON.stringify({ ...shared, completedAt: 3000, success: true })}\n`);

      try {
        const store = new ExecutionStore(testDir, legacyDir);
        const ids = store.list().executions.map((e) => e.sessionId).sort();
        expect(ids).toEqual(["old", "shared"]);
        expect(store.list().executions.find((e) => e.sessionId === "shared")?.success).toBe(true);
      } finally {
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    // Review finding: an isolated instance (own COMPANION_HOME) read the live
    // service's ~/.companion/executions as "legacy", closed its open runs as
    // interrupted and (via own()-less cleanup) removed their temp folders.
    // Runs known only from the legacy dir are display-only: never finalized,
    // never updated, not in own(). A run this store also wrote is its own.
    it("never acts on runs known only from the legacy directory", () => {
      const legacyDir = `${testDir}-legacy`;
      mkdirSync(legacyDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
      const foreignRun = makeExecution({ sessionId: "live-sess-1", startedAt: 1000, tempCwd: "/tmp/companion-agent-victim" });
      const migrated = makeExecution({ sessionId: "migrated", startedAt: 1000 });
      const legacyContent = `${JSON.stringify(foreignRun)}\n${JSON.stringify(migrated)}\n`;
      writeFileSync(join(legacyDir, "executions-2026-01-01.jsonl"), legacyContent);
      writeFileSync(join(testDir, "executions-2026-01-01.jsonl"), `${JSON.stringify(migrated)}\n`);

      try {
        const store = new ExecutionStore(testDir, legacyDir);
        // Shown in the history...
        expect(store.list().executions.map((e) => e.sessionId).sort()).toEqual(["live-sess-1", "migrated"]);
        // ...but only the store's own open run is closed.
        expect(store.finalizeInterrupted("Interrupted")).toBe(1);
        expect(store.own().map((e) => e.sessionId)).toEqual(["migrated"]);
        store.update("live-sess-1", { completedAt: 5, success: false });
        expect(store.list().executions.find((e) => e.sessionId === "live-sess-1")?.completedAt).toBeUndefined();
        // Nothing about the foreign run is written anywhere.
        expect(readFileSync(join(legacyDir, "executions-2026-01-01.jsonl"), "utf-8")).toBe(legacyContent);
        expect(readFileSync(join(testDir, "executions-2026-01-01.jsonl"), "utf-8")).not.toContain("live-sess-1");
        // A fresh load agrees.
        expect(new ExecutionStore(testDir, legacyDir).own().map((e) => e.sessionId)).toEqual(["migrated"]);
      } finally {
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("tolerates a missing legacy directory and never writes to it", () => {
      const legacyDir = `${testDir}-absent`;
      const store = new ExecutionStore(testDir, legacyDir);
      store.append(makeExecution({ startedAt: 1000 }));
      expect(existsSync(legacyDir)).toBe(false);
      expect(readdirSync(testDir)).toHaveLength(1);
    });
  });

  describe("finalizeInterrupted()", () => {
    it("closes runs still marked running as failed, and persists that", () => {
      // After a restart no open run can ever report a result.
      const store = new ExecutionStore(testDir);
      store.append(makeExecution({ sessionId: "open", startedAt: 1000 }));
      store.append(makeExecution({ sessionId: "done", startedAt: 1000, completedAt: 2000, success: true }));

      expect(store.finalizeInterrupted("Interrupted")).toBe(1);

      const reloaded = new ExecutionStore(testDir).list().executions;
      const open = reloaded.find((e) => e.sessionId === "open")!;
      expect(open.completedAt).toBeGreaterThan(0);
      expect(open.success).toBe(false);
      expect(open.error).toBe("Interrupted");
      expect(reloaded.find((e) => e.sessionId === "done")!.success).toBe(true);
    });
  });

  it("all() returns every cached execution without pagination", () => {
    const store = new ExecutionStore(testDir);
    for (let i = 0; i < 60; i++) store.append(makeExecution({ startedAt: i }));
    expect(store.all()).toHaveLength(60);
  });

  it("status=error also matches failed runs without an error message", () => {
    const store = new ExecutionStore(testDir);
    store.append(makeExecution({ sessionId: "f", startedAt: 1, completedAt: 2, success: false }));
    store.append(makeExecution({ sessionId: "r", startedAt: 1 }));
    expect(store.list({ status: "error" }).executions.map((e) => e.sessionId)).toEqual(["f"]);
  });
});
