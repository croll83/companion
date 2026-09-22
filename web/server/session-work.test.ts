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
});
