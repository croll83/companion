// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { isSessionWorking, noteWorkFromCliMessage, clearWorkTracking } from "./session-work.js";
import { SessionStateMachine } from "./session-state-machine.js";
import type { Session } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";

function makeSession(phase: "ready" | "streaming" | "terminated" = "ready"): Session {
  return {
    id: "s1",
    openToolCalls: new Set<string>(),
    backgroundTasks: new Map(),
    pendingPermissions: new Map(),
    stateMachine: new SessionStateMachine("s1", phase),
  } as unknown as Session;
}

const toolUse = (id: string): BrowserIncomingMessage =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] } }) as unknown as BrowserIncomingMessage;

describe("session work detection", () => {
  let session: Session;
  beforeEach(() => { session = makeSession(); });

  it("treats an at-rest session with nothing outstanding as idle", () => {
    expect(isSessionWorking(session)).toBe(false);
  });

  it("counts a session with an unfinished tool call as working", () => {
    // The case the phase gate missed: a long Bash/MCP/sub-agent call emits
    // nothing for tens of minutes while the phase sits at "ready".
    noteWorkFromCliMessage(session, toolUse("t1"));
    expect(isSessionWorking(session)).toBe(true);
  });

  it("releases the session once the tool is summarised", () => {
    noteWorkFromCliMessage(session, toolUse("t1"));
    noteWorkFromCliMessage(session, { type: "tool_use_summary", summary: "done", tool_use_ids: ["t1"] } as BrowserIncomingMessage);
    expect(isSessionWorking(session)).toBe(false);
  });

  it("keeps a tool alive while it reports progress", () => {
    noteWorkFromCliMessage(session, { type: "tool_progress", tool_use_id: "t9", tool_name: "Bash", elapsed_time_seconds: 120 } as BrowserIncomingMessage);
    expect(isSessionWorking(session)).toBe(true);
  });

  it("sweeps stale tool calls at turn end so they cannot pin the session forever", () => {
    noteWorkFromCliMessage(session, toolUse("t1"));
    noteWorkFromCliMessage(session, toolUse("t2"));
    noteWorkFromCliMessage(session, { type: "result", data: {} } as unknown as BrowserIncomingMessage);
    expect(isSessionWorking(session)).toBe(false);
  });

  it("protects a session waiting on the user's approval", () => {
    session.pendingPermissions.set("r1", {} as never);
    expect(isSessionWorking(session)).toBe(true);
  });

  it("counts any non-at-rest phase as working", () => {
    expect(isSessionWorking(makeSession("streaming"))).toBe(true);
  });

  it("does not call a terminated session working", () => {
    expect(isSessionWorking(makeSession("terminated"))).toBe(false);
  });

  it("clearWorkTracking drops outstanding calls", () => {
    noteWorkFromCliMessage(session, toolUse("t1"));
    clearWorkTracking(session);
    expect(isSessionWorking(session)).toBe(false);
  });

  // ─── The CLI's own word on in-flight work ────────────────────────────────
  // Reproduced on CLI 2.1.288: a turn that launches `sleep 25` in the
  // background emits result + session_state idle at ~4s, while the task runs
  // until ~27s and the CLI wakes up again to handle it. Only
  // background_tasks_changed reveals that window.
  const bg = (...tasks: { task_id: string; ambient?: boolean }[]) =>
    ({ type: "background_tasks", tasks: tasks.map((t) => ({ task_type: "local_bash", description: "x", ...t })) }) as BrowserIncomingMessage;

  it("keeps a session working after its turn ended, while background work runs", () => {
    const s = makeSession("streaming");
    noteWorkFromCliMessage(s, bg({ task_id: "terraform-plan" }));
    noteWorkFromCliMessage(s, { type: "result", data: {} } as unknown as BrowserIncomingMessage);
    noteWorkFromCliMessage(s, { type: "cli_session_state", state: "idle" } as BrowserIncomingMessage);
    s.stateMachine.transition("ready", "turn_completed");
    clearWorkTracking(s, "turn"); // what the bridge does on reaching ready

    expect(isSessionWorking(s)).toBe(true);
  });

  it("treats the payload as the whole set: an empty one means done", () => {
    const s = makeSession();
    noteWorkFromCliMessage(s, bg({ task_id: "a" }, { task_id: "b" }));
    noteWorkFromCliMessage(s, bg({ task_id: "b" }));
    expect([...s.backgroundTasks.keys()]).toEqual(["b"]);
    noteWorkFromCliMessage(s, bg());
    expect(isSessionWorking(s)).toBe(false);
  });

  it("does not count ambient (housekeeping) tasks as work", () => {
    const s = makeSession();
    noteWorkFromCliMessage(s, bg({ task_id: "housekeeping", ambient: true }));
    expect(isSessionWorking(s)).toBe(false);
  });

  it("trusts the CLI's running / requires_action turn state", () => {
    const s = makeSession();
    noteWorkFromCliMessage(s, { type: "cli_session_state", state: "running" } as BrowserIncomingMessage);
    expect(isSessionWorking(s)).toBe(true);
    noteWorkFromCliMessage(s, { type: "cli_session_state", state: "requires_action" } as BrowserIncomingMessage);
    expect(isSessionWorking(s)).toBe(true);
    noteWorkFromCliMessage(s, { type: "cli_session_state", state: "idle" } as BrowserIncomingMessage);
    expect(isSessionWorking(s)).toBe(false);
  });

  it("forgets background work only when the CLI process itself is gone", () => {
    const s = makeSession();
    noteWorkFromCliMessage(s, bg({ task_id: "a" }));
    clearWorkTracking(s, "turn");
    expect(isSessionWorking(s)).toBe(true);
    clearWorkTracking(s, "process");
    expect(isSessionWorking(s)).toBe(false);
  });
});
