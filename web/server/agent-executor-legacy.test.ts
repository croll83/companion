import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AgentExecutor + the REAL ExecutionStore when COMPANION_HOME is not the
 * default, so the history of the old location (~/.companion/executions) is
 * read too. That location may belong to ANOTHER instance that is running
 * right now (the live service, seen from an isolated test instance): its
 * open runs must not be closed as "interrupted" and the temp folders of its
 * running agents must not be removed.
 *
 * Reproduces the review finding: the isolated instance logged "Closed 6
 * run(s) interrupted by a server restart" for the live service's runs, and
 * startAll() removed a live run's temp folder because its session is unknown
 * to the isolated instance.
 */

const h = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || "/tmp"}/agent-executor-legacy-${process.pid}-${Date.now()}`;
  return { base, home: `${base}/home`, legacyRoot: `${base}/legacy-home` };
});
vi.mock("./paths.js", () => ({
  COMPANION_HOME: h.home,
  legacyStatePath: (rel: string) => `${h.legacyRoot}/${rel}`,
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({ timeZone: "UTC" }) }));

import { AgentExecutor } from "./agent-executor.js";

const dirs: string[] = [];

afterEach(() => {
  rmSync(h.base, { recursive: true, force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("history read from the legacy location", () => {
  it("is never closed or cleaned up by this instance", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // A temp folder of a run the other instance is still running.
    const victim = mkdtempSync(join(tmpdir(), "companion-agent-victim-"));
    dirs.push(victim);
    writeFileSync(join(victim, "work.txt"), "in progress");
    const legacyDir = `${h.legacyRoot}/executions`;
    mkdirSync(legacyDir, { recursive: true });
    const run = { sessionId: "live-sess-1", agentId: "verif-hook", triggerType: "webhook", startedAt: Date.now(), tempCwd: victim };
    const legacyFile = join(legacyDir, "executions-2026-10-05.jsonl");
    writeFileSync(legacyFile, `${JSON.stringify(run)}\n`);

    // This instance knows none of the other instance's sessions.
    const launcher = { getSession: () => undefined, listSessions: () => [] };
    const executor = new AgentExecutor(launcher as never, {} as never);
    executor.startAll();

    expect(existsSync(join(victim, "work.txt"))).toBe(true);
    expect(readFileSync(legacyFile, "utf-8")).toBe(`${JSON.stringify(run)}\n`);
    // Still listed (the Runs page shows the old history), still open.
    const listed = executor.listAllExecutions({ limit: 10 }).executions;
    expect(listed).toHaveLength(1);
    expect(listed[0].completedAt).toBeUndefined();
    expect(executor.getRunResult("live-sess-1", 100)).toBeNull();
    executor.handleSessionClosed("live-sess-1");
    expect(existsSync(victim)).toBe(true);
    executor.destroy();
  });
});
