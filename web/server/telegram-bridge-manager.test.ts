import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Token state is controlled per test; the manager reads it on every decision.
const settingsState = vi.hoisted(() => ({ token: "123:ABC" }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ telegramBotToken: settingsState.token }),
}));
vi.mock("./paths.js", () => ({ COMPANION_HOME: "/tmp/companion-home-test" }));

// ─── Bun.spawn mock ─────────────────────────────────────────────────────────
// Each fake child exposes an `exit(code)` helper that resolves `exited`, so a
// test can simulate a crash or clean exit at a chosen (fake) time.
interface FakeProc {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  exited: Promise<number>;
  exit: (code: number) => Promise<void>;
}
let procs: FakeProc[] = [];
let nextPid = 1000;
const mockSpawn = vi.fn((_cmd: string[], _opts: unknown): FakeProc => {
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolve = r; });
  const proc: FakeProc = {
    pid: nextPid++,
    kill: vi.fn(),
    exited,
    exit: async (code: number) => {
      resolve(code);
      // Let the .then() handler in the manager run.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  procs.push(proc);
  return proc;
});
vi.stubGlobal("Bun", { spawn: mockSpawn });

type Manager = typeof import("./telegram-bridge-manager.js")["telegramBridgeManager"];
let manager: Manager;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  settingsState.token = "123:ABC";
  procs = [];
  mockSpawn.mockClear();
  // The module exports a singleton — re-import for a fresh instance per test.
  vi.resetModules();
  manager = (await import("./telegram-bridge-manager.js")).telegramBridgeManager;
});

afterEach(() => {
  manager.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("start / sync", () => {
  it("spawns the bridge child with port and COMPANION_HOME in env when a token is set", () => {
    manager.start(4567);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, opts] = mockSpawn.mock.calls[0] as [string[], { env: Record<string, string>; stdin: string }];
    expect(cmd[0]).toBe("bun");
    expect(cmd[1]).toMatch(/telegram-bridge-child\.ts$/);
    expect(opts.env.COMPANION_PORT).toBe("4567");
    expect(opts.env.COMPANION_HOME).toBe("/tmp/companion-home-test");
    expect(opts.stdin).toBe("ignore");
    expect(manager.isRunning()).toBe(true);
  });

  it("does not spawn when the token is blank (whitespace only)", () => {
    settingsState.token = "   ";
    manager.start(3456);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(manager.isRunning()).toBe(false);
  });

  it("sync is idempotent while the child is running (no double spawn)", () => {
    manager.start(3456);
    manager.sync();
    manager.sync();
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("sync stops the running child once the token is cleared", () => {
    manager.start(3456);
    settingsState.token = "";
    manager.sync();
    expect(procs[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.isRunning()).toBe(false);
  });
});

describe("reload", () => {
  it("sends SIGHUP to a running child instead of respawning", () => {
    manager.start(3456);
    manager.reload();
    expect(procs[0].kill).toHaveBeenCalledWith("SIGHUP");
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("spawns the child when none is running and a token is set", () => {
    settingsState.token = "";
    manager.start(3456);
    settingsState.token = "123:ABC";
    manager.reload();
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(manager.isRunning()).toBe(true);
  });

  it("stops the child when the token has been removed", () => {
    manager.start(3456);
    settingsState.token = "";
    manager.reload();
    expect(procs[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.isRunning()).toBe(false);
  });

  it("swallows a kill error on SIGHUP (child already dead)", () => {
    manager.start(3456);
    procs[0].kill.mockImplementation(() => { throw new Error("ESRCH"); });
    expect(() => manager.reload()).not.toThrow();
  });
});

describe("stop", () => {
  it("SIGTERMs the child and does not restart it when it then exits", async () => {
    manager.start(3456);
    const proc = procs[0];
    manager.stop();
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    await proc.exit(143);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(manager.isRunning()).toBe(false);
  });

  it("swallows a kill error on SIGTERM", () => {
    manager.start(3456);
    procs[0].kill.mockImplementation(() => { throw new Error("ESRCH"); });
    expect(() => manager.stop()).not.toThrow();
    expect(manager.isRunning()).toBe(false);
  });

  it("cancels a pending restart timer", async () => {
    manager.start(3456);
    await procs[0].exit(1); // crash → restart scheduled
    manager.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});

describe("crash supervision", () => {
  it("restarts a crashed child after the initial 5s delay", async () => {
    manager.start(3456);
    await procs[0].exit(1);
    expect(manager.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(4999);
    expect(mockSpawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(manager.isRunning()).toBe(true);
  });

  it("treats a quick exit with code 0 as a crash (avoids silent death on startup)", async () => {
    manager.start(3456);
    await procs[0].exit(0); // uptime < 5s
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("does not restart after a clean exit following a healthy run", async () => {
    manager.start(3456);
    vi.advanceTimersByTime(6000); // uptime >= 5s
    await procs[0].exit(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(manager.isRunning()).toBe(false);
  });

  it("doubles the backoff on repeated quick crashes, capped at 60s", async () => {
    manager.start(3456);
    // Expected delays: 5s, 10s, 20s, 40s, 60s, 60s
    const delays = [5000, 10000, 20000, 40000, 60000, 60000];
    for (let i = 0; i < delays.length; i++) {
      await procs[i].exit(1);
      await vi.advanceTimersByTimeAsync(delays[i] - 1);
      expect(mockSpawn).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockSpawn).toHaveBeenCalledTimes(i + 2);
    }
  });

  it("resets the backoff to 5s after a healthy run that then crashes", async () => {
    manager.start(3456);
    // Two quick crashes push the delay up (5s, then 10s).
    await procs[0].exit(1);
    await vi.advanceTimersByTimeAsync(5000);
    await procs[1].exit(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(mockSpawn).toHaveBeenCalledTimes(3);

    // Healthy run, then crash → delay back to 5s.
    vi.advanceTimersByTime(6000);
    await procs[2].exit(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it("does not respawn on the restart timer if the token was cleared meanwhile", async () => {
    manager.start(3456);
    await procs[0].exit(1);
    settingsState.token = "";
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(manager.isRunning()).toBe(false);
  });
});

describe("spawn failure", () => {
  it("logs and schedules a retry when Bun.spawn throws", async () => {
    mockSpawn.mockImplementationOnce(() => { throw new Error("ENOENT bun"); });
    manager.start(3456);
    expect(manager.isRunning()).toBe(false);
    expect(console.error).toHaveBeenCalledWith("[tg-manager] spawn failed:", "ENOENT bun");

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(manager.isRunning()).toBe(true);
  });
});
