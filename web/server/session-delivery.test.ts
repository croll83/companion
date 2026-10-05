import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Delivering a message into an existing session through the REAL WsBridge:
 * a dead session (restored from disk after a restart) queues the message,
 * asks for a relaunch, and the queue reaches the CLI once it is back — the
 * path wake-ups and POST /sessions/:id/message rely on.
 */

if (typeof globalThis.Bun === "undefined") {
  (globalThis as { Bun?: unknown }).Bun = { hash: (s: string) => s.length };
}
vi.mock("node:child_process", () => ({ execSync: vi.fn(() => { throw new Error("no git"); }) }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ aiValidationEnabled: false, aiValidationAutoApprove: false, aiValidationAutoDeny: false, anthropicApiKey: "" }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import { deliverUserMessage, isTurnBusy } from "./session-delivery.js";
import type { SdkSessionInfo } from "./cli-launcher.js";

let dir: string;
let store: SessionStore;
let sessions: Map<string, Partial<SdkSessionInfo>>;
let alive: Set<string>;
const launcher = {
  getSession: (id: string) => sessions.get(id) as SdkSessionInfo | undefined,
  isAlive: (id: string) => alive.has(id),
};
const relaunches: string[] = [];
const onRelaunch = ({ sessionId }: { sessionId: string }) => { relaunches.push(sessionId); };

function stdioProc() {
  return {
    stdout: new ReadableStream<Uint8Array>({ start() {} }),
    stdin: { write: vi.fn(), end: vi.fn(), flush: vi.fn(), ref: vi.fn(), unref: vi.fn() },
    stderr: undefined,
    exited: new Promise<number>(() => {}),
    kill: vi.fn(),
    pid: 4242,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-delivery-test-"));
  store = new SessionStore(dir);
  sessions = new Map([["s1", { sessionId: "s1", backendType: "claude", state: "exited", cwd: "/w", createdAt: 1 }]]);
  alive = new Set();
  relaunches.length = 0;
  companionBus.on("session:relaunch-needed", onRelaunch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  companionBus.off("session:relaunch-needed", onRelaunch);
  vi.restoreAllMocks();
  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A bridge that knows "s1" only from disk, as after a server restart. */
function restartedBridge(): WsBridge {
  const before = new WsBridge();
  before.setStore(store);
  before.getOrCreateSession("s1", "claude");
  before.injectUserMessage("s1", "earlier message"); // persists the session
  const after = new WsBridge();
  after.setStore(store);
  after.restoreFromDisk();
  relaunches.length = 0;
  return after;
}

describe("deliverUserMessage", () => {
  // The relaunch path: a dead CLI gets the message queued (and in history),
  // a fresh relaunch budget and a relaunch request; once the relaunched CLI
  // attaches, the queued message is written to it.
  it("queues for a dead session, asks for a relaunch and delivers once the CLI is back", () => {
    const bridge = restartedBridge();
    const resetRelaunchBudget = vi.fn();

    const result = deliverUserMessage({ launcher, wsBridge: bridge, resetRelaunchBudget }, "s1", "[scheduled wake-up wk-1]\n\nwake up");

    expect(result).toEqual({ ok: true, delivery: "queued" });
    expect(resetRelaunchBudget).toHaveBeenCalledWith("s1");
    expect(relaunches).toContain("s1");
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.join("")).toContain("wake up");
    expect(session.messageHistory.some((m) => m.type === "user_message" && m.content.includes("wake up"))).toBe(true);

    // The orchestrator relaunched the CLI (stdio): the queue is flushed into it.
    const proc = stdioProc();
    bridge.handleCLIStdioReady("s1", proc as never);
    const written = proc.stdin.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("wake up");
    expect(bridge.getSession("s1")!.pendingMessages).toEqual([]);
  });

  // A session the bridge has never seen (nothing persisted yet) still gets
  // a place to queue, and a relaunch even though its phase says "starting".
  it("creates the bridge session when missing", () => {
    const bridge = new WsBridge();
    bridge.setStore(store);

    expect(deliverUserMessage({ launcher, wsBridge: bridge }, "s1", "hello")).toEqual({ ok: true, delivery: "queued" });
    expect(bridge.getSession("s1")?.pendingMessages.join("")).toContain("hello");
    // Asked at least once (the bridge may ask too; the orchestrator dedupes).
    expect(relaunches).toContain("s1");
  });

  it("hands the message to a live CLI without a relaunch", () => {
    const bridge = new WsBridge();
    bridge.setStore(store);
    alive.add("s1");
    const resetRelaunchBudget = vi.fn();
    const inject = vi.spyOn(bridge, "injectUserMessage");

    expect(deliverUserMessage({ launcher, wsBridge: bridge, resetRelaunchBudget }, "s1", "hi")).toEqual({ ok: true, delivery: "sent" });
    expect(inject).toHaveBeenCalledWith("s1", "hi");
    expect(resetRelaunchBudget).not.toHaveBeenCalled();
  });

  it("refuses unknown and archived sessions", () => {
    const bridge = new WsBridge();
    expect(deliverUserMessage({ launcher, wsBridge: bridge }, "nope", "x")).toEqual({ ok: false, status: 404, error: "Session not found" });
    sessions.set("old", { sessionId: "old", archived: true, cwd: "/", createdAt: 1, state: "exited" });
    expect(deliverUserMessage({ launcher, wsBridge: bridge }, "old", "x")).toEqual({ ok: false, status: 409, error: "Session is archived" });
    expect(bridge.getSession("old")).toBeUndefined();
    expect(relaunches).toEqual([]);
  });
});

describe("isTurnBusy", () => {
  // Busy only means "a turn is running in a live, connected CLI"; a dead or
  // disconnected CLI is never busy (delivery relaunches it instead).
  it("is true only for a connected CLI with a turn in flight", () => {
    const wsBridge = {
      isCliConnected: vi.fn(() => true),
      getSession: vi.fn(() => ({ pendingPermissions: new Map(), openToolCalls: new Set(), stateMachine: { phase: "streaming" } })),
    };
    alive.add("s1");
    expect(isTurnBusy({ launcher, wsBridge: wsBridge as never }, "s1")).toBe(true);

    wsBridge.getSession.mockReturnValue({ pendingPermissions: new Map(), openToolCalls: new Set(), stateMachine: { phase: "ready" } });
    expect(isTurnBusy({ launcher, wsBridge: wsBridge as never }, "s1")).toBe(false);

    wsBridge.getSession.mockReturnValue(undefined as never);
    expect(isTurnBusy({ launcher, wsBridge: wsBridge as never }, "s1")).toBe(false);

    wsBridge.isCliConnected.mockReturnValue(false);
    expect(isTurnBusy({ launcher, wsBridge: wsBridge as never }, "s1")).toBe(false);

    alive.delete("s1");
    wsBridge.isCliConnected.mockReturnValue(true);
    expect(isTurnBusy({ launcher, wsBridge: wsBridge as never }, "s1")).toBe(false);
  });
});
