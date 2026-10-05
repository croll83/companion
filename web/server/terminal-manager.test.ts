/**
 * Tests for TerminalManager: host PTY shells driven by browser WebSockets.
 *
 * Bun.spawn is stubbed with a fake process that exposes the `terminal` PTY
 * handle Bun attaches when spawning with the `terminal` option, so the tests
 * can drive output, exit and resize without a real shell. Validates:
 * - a login shell is spawned in the requested host cwd (no container path)
 * - PTY output fans out to every attached browser socket, exit is reported
 * - input / resize messages from the browser reach the PTY
 * - kill, orphan cleanup and getInfo bookkeeping
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge.js";
import { TerminalManager } from "./terminal-manager.js";

interface FakeProc {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
  kill: ReturnType<typeof vi.fn>;
  terminal: { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  resolveExit: (code: number) => void;
  options: {
    cwd?: string;
    env: Record<string, string | undefined>;
    terminal: { cols: number; rows: number; data: (t: unknown, d: Uint8Array) => void; exit: () => void };
  };
  cmd: string[];
}

let procs: FakeProc[];

function socket(terminalId: string): ServerWebSocket<SocketData> {
  return {
    data: { kind: "terminal", terminalId },
    send: vi.fn(),
    sendBinary: vi.fn(),
  } as unknown as ServerWebSocket<SocketData>;
}

beforeEach(() => {
  procs = [];
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("Bun", {
    spawn: vi.fn((cmd: string[], options: FakeProc["options"]) => {
      let resolveExit!: (code: number) => void;
      const proc: FakeProc = {
        pid: 40000 + procs.length,
        exitCode: null,
        exited: new Promise<number>((r) => { resolveExit = r; }),
        kill: vi.fn(),
        terminal: { write: vi.fn(), resize: vi.fn(), close: vi.fn() },
        resolveExit: (code) => resolveExit(code),
        options,
        cmd,
      };
      procs.push(proc);
      return proc;
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalManager.spawn", () => {
  it("spawns a login shell in the host cwd with the requested size", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo", 120, 40);

    expect(procs).toHaveLength(1);
    const proc = procs[0];
    expect(proc.cmd).toHaveLength(2);
    expect(proc.cmd[1]).toBe("-l");
    expect(proc.options.cwd).toBe("/repo");
    expect(proc.options.env.TERM).toBe("xterm-256color");
    expect(proc.options.env.CLAUDECODE).toBeUndefined();
    expect(proc.options.terminal.cols).toBe(120);
    expect(proc.options.terminal.rows).toBe(40);
    expect(mgr.getInfo(id)).toEqual({ id, cwd: "/repo" });
  });

  it("uses $SHELL when it exists", () => {
    vi.stubEnv("SHELL", "/bin/sh");
    new TerminalManager().spawn("/repo");
    expect(procs[0].cmd[0]).toBe("/bin/sh");
    vi.unstubAllEnvs();
  });
});

describe("TerminalManager I/O", () => {
  it("broadcasts PTY output to attached sockets and reports exit", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");
    const a = socket(id);
    const b = socket(id);
    mgr.addBrowserSocket(a);
    mgr.addBrowserSocket(b);

    const chunk = new Uint8Array([104, 105]);
    procs[0].options.terminal.data(null, chunk);
    expect(a.sendBinary).toHaveBeenCalledWith(chunk);
    expect(b.sendBinary).toHaveBeenCalledWith(chunk);

    procs[0].exitCode = 2;
    procs[0].options.terminal.exit();
    expect(a.send).toHaveBeenCalledWith(JSON.stringify({ type: "exit", exitCode: 2 }));
  });

  it("writes browser input to the PTY and applies resizes", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");
    const ws = socket(id);

    mgr.handleBrowserMessage(ws, JSON.stringify({ type: "input", data: "ls\r" }));
    mgr.handleBrowserMessage(ws, Buffer.from(JSON.stringify({ type: "resize", cols: 100, rows: 30 })));
    mgr.handleBrowserMessage(ws, "not json");

    expect(procs[0].terminal.write).toHaveBeenCalledWith("ls\r");
    expect(procs[0].terminal.resize).toHaveBeenCalledWith(100, 30);
  });

  it("ignores messages from non-terminal sockets and unknown terminals", () => {
    const mgr = new TerminalManager();
    mgr.spawn("/repo");
    const browser = { data: { kind: "browser", sessionId: "s1" } } as unknown as ServerWebSocket<SocketData>;

    mgr.handleBrowserMessage(browser, JSON.stringify({ type: "input", data: "x" }));
    mgr.handleBrowserMessage(socket("missing"), JSON.stringify({ type: "input", data: "x" }));
    mgr.addBrowserSocket(browser);
    mgr.removeBrowserSocket(socket("missing"));

    expect(procs[0].terminal.write).not.toHaveBeenCalled();
  });
});

describe("TerminalManager lifecycle", () => {
  it("kill terminates the process and forgets the terminal", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");

    mgr.kill(id);
    expect(procs[0].kill).toHaveBeenCalled();
    expect(mgr.getInfo(id)).toBeNull();
    expect(mgr.getInfo()).toBeNull();
    // Killing again is a no-op.
    mgr.kill(id);
    expect(procs[0].kill).toHaveBeenCalledTimes(1);
  });

  it("kills a terminal whose last browser left after the grace period", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");
    const ws = socket(id);
    mgr.addBrowserSocket(ws);

    mgr.removeBrowserSocket(ws);
    vi.advanceTimersByTime(4_999);
    expect(procs[0].kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(procs[0].kill).toHaveBeenCalled();
  });

  it("a browser reconnecting within the grace period keeps the terminal", () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");
    const ws = socket(id);
    mgr.addBrowserSocket(ws);
    mgr.removeBrowserSocket(ws);
    mgr.addBrowserSocket(socket(id));

    vi.advanceTimersByTime(10_000);
    expect(procs[0].kill).not.toHaveBeenCalled();
    expect(mgr.getInfo()).toEqual({ id, cwd: "/repo" });
  });

  it("drops the terminal when its process exits", async () => {
    const mgr = new TerminalManager();
    const id = mgr.spawn("/repo");

    procs[0].resolveExit(0);
    await vi.runAllTimersAsync();
    expect(mgr.getInfo(id)).toBeNull();
  });
});
