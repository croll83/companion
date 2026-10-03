import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// The module's boot is guarded by `import.meta.main`, so importing it here does
// not start the bot — only the pure helpers are exercised.
import { safeName } from "./telegram-bridge-child.js";

describe("safeName (attachment filename hardening)", () => {
  it("keeps a normal filename", () => {
    expect(safeName("report.pdf", ".pdf")).toBe("report.pdf");
  });

  it("strips directory components (basename)", () => {
    expect(safeName("/etc/passwd", ".bin")).toBe("passwd");
    expect(safeName("sub/dir/file.csv", ".csv")).toBe("file.csv");
  });

  it("neutralizes path-traversal names — never returns '.' or '..'", () => {
    // A traversal attempt must not escape or target the inbox directory itself.
    for (const evil of ["..", ".", "../../etc/passwd", "..\\..\\evil"]) {
      const out = safeName(evil, ".bin");
      expect(out).not.toBe("..");
      expect(out).not.toBe(".");
      expect(out.includes("/")).toBe(false);
      expect(out.includes("\\")).toBe(false);
    }
  });

  it("strips leading dots (no dotfiles / '..evil')", () => {
    expect(safeName("..evil", ".bin")).toBe("evil");
    expect(safeName(".bashrc", ".bin")).toBe("bashrc");
  });

  it("replaces shell/markdown metacharacters with underscores", () => {
    // Backticks/newlines would otherwise let a filename break the injected note.
    const out = safeName("a`whoami`\n$(id).pdf", ".pdf");
    expect(out).not.toMatch(/[`\n$()]/);
    expect(out.includes("/")).toBe(false);
  });

  it("falls back for empty / all-punctuation names", () => {
    expect(safeName("", ".pdf")).toMatch(/^file-\d+\.pdf$/);
    expect(safeName("...", ".bin")).toMatch(/^file-\d+\.bin$/);
  });

  it("caps length at 120 chars", () => {
    expect(safeName("x".repeat(500) + ".pdf", ".pdf").length).toBe(120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booted-worker tests.
//
// Everything except safeName is module-private and only reachable by running
// the module's boot path (reconcile → SessionBridge per binding → Telegram
// long-poll loop). The module runs that path on import only when it is the
// entry point (import.meta.main); under the test runner it does not, so we call
// the exported boot() directly. This is portable across Vitest/Vite versions,
// unlike faking import.meta.main.
//
// Each test boots a fresh module instance (vi.resetModules) against:
//   - a temp COMPANION_HOME holding settings.json / auth.json / bindings,
//   - a fake WebSocket (companion WS) the test drives frame by frame,
//   - a fake fetch standing in for the Telegram Bot API, the Telegram file
//     server and companion's relaunch endpoint,
//   - fake timers, with tiny env-configured debounce/ack/stall/timeout values.
// ─────────────────────────────────────────────────────────────────────────────

const liveness = vi.hoisted(() => ({
  cliWorking: vi.fn((_pid: number | null, _prev: unknown) => ({ working: false, sample: null as { ticks: number; at: number } | null })),
  cpuTicks: vi.fn((_pid: number): number | null => null),
}));
vi.mock("./cli-liveness.js", () => liveness);

const realSetImmediate = setImmediate;
/** Drain pending promise chains (fake fetch resolves via microtasks only). */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => realSetImmediate(r));
}

const T = {
  DEBOUNCE: 100,
  ACK: 1000,
  FIRST_ACTIVITY: 2000,
  STALL: 3000,
  TIMEOUT: 20000,
  COOLDOWN: 5000,
  MAX_QUEUE: 2,
  MAX_FILE: 1000,
  MAX_INPUT: 2000,
};
const ENV: Record<string, string> = {
  COMPANION_PORT: "4567",
  TG_DEBOUNCE_MS: String(T.DEBOUNCE),
  TG_TURN_ACK_MS: String(T.ACK),
  TG_FIRST_ACTIVITY_MS: String(T.FIRST_ACTIVITY),
  TG_STALL_MS: String(T.STALL),
  TG_TURN_TIMEOUT_MS: String(T.TIMEOUT),
  TG_RELAUNCH_COOLDOWN_MS: String(T.COOLDOWN),
  TG_MAX_QUEUE: String(T.MAX_QUEUE),
  TG_MAX_FILE_BYTES: String(T.MAX_FILE),
  TG_MAX_INPUT_CHARS: String(T.MAX_INPUT),
};

const TOKEN = "T0K";
const BOT_ID = 999;
const CHAT = -1001;
const TOPIC = 7;
const USER = 42;
const SID = "sess1111-aaaa-bbbb";
const SID2 = "sess2222-cccc-dddd";

class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  sent: any[] = [];
  closed = false;
  throwOnSend = false;
  private listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void { (this.listeners[type] ??= []).push(fn); }
  send(s: string): void {
    if (this.throwOnSend) throw new Error("socket gone");
    this.sent.push(JSON.parse(s));
  }
  close(): void { this.closed = true; this.emit("close"); }
  emit(type: string, data?: unknown): void { for (const fn of this.listeners[type] ?? []) fn({ data }); }
  open(): void { this.emit("open"); }
  frame(obj: unknown): void { this.emit("message", typeof obj === "string" ? obj : JSON.stringify(obj)); }
  userMessages(): any[] { return this.sent.filter((f) => f.type === "user_message"); }
}

interface TgFile { file_path?: string; file_size?: number; status?: number; bytes?: Buffer }
const tgState = {
  calls: [] as { method: string; body: any }[],
  sendMessageReplies: [] as any[],
  throwMethods: new Set<string>(),
  files: {} as Record<string, TgFile>,
  relaunches: [] as { url: string; init: any }[],
  relaunchError: false,
};
let poll: { res: (v: unknown) => void; rej: (e: unknown) => void } | null = null;
let pollWaiters: (() => void)[] = [];
let updateSeq = 0;
let msgSeq = 0;

async function fakeFetch(input: unknown, init?: any): Promise<any> {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1")) {
    tgState.relaunches.push({ url, init });
    if (tgState.relaunchError) throw new Error("ECONNREFUSED");
    return { status: 200 };
  }
  const filePrefix = `https://api.telegram.org/file/bot${TOKEN}/`;
  if (url.startsWith(filePrefix)) {
    const f = Object.values(tgState.files).find((x) => x.file_path === url.slice(filePrefix.length))!;
    const bytes = f.bytes ?? Buffer.from("");
    return { ok: (f.status ?? 200) < 400, status: f.status ?? 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  }
  if (url.includes("/getUpdates")) {
    return new Promise((res, rej) => {
      poll = { res, rej };
      for (const w of pollWaiters.splice(0)) w();
    });
  }
  const method = url.split("/").pop()!;
  const body = init?.body ? JSON.parse(init.body) : {};
  tgState.calls.push({ method, body });
  if (tgState.throwMethods.has(method)) throw new Error(`${method} network down`);
  let reply: any = { ok: true, result: true };
  if (method === "getMe") reply = { ok: true, result: { id: BOT_ID, username: "FableBot" } };
  if (method === "sendMessage" && tgState.sendMessageReplies.length) reply = tgState.sendMessageReplies.shift();
  if (method === "getFile") reply = { ok: true, result: tgState.files[body.file_id] ?? {} };
  return { status: reply.ok ? 200 : 400, json: async () => reply };
}

function waitPoll(): Promise<void> {
  if (poll) return Promise.resolve();
  return new Promise((r) => pollWaiters.push(r));
}
/** Hand updates to the long-poll loop; resolves once they were all handled (loop polls again). */
async function deliver(...updates: any[]): Promise<void> {
  await waitPoll();
  const p = poll!; poll = null;
  const next = waitPoll();
  p.res({ json: async () => ({ ok: true, result: updates.map((u) => ({ update_id: ++updateSeq, ...u })) }) });
  await next;
}

function binding(over: Record<string, unknown> = {}) {
  return { groupId: CHAT, topicId: TOPIC, allowlist: [USER], requireMention: false, enabled: true, ...over };
}
function textMsg(text: string, extra: Record<string, unknown> = {}) {
  return { message: { message_id: ++msgSeq, chat: { id: CHAT, type: "supergroup" }, message_thread_id: TOPIC, from: { id: USER, username: "marco" }, text, ...extra } };
}
function mediaMsg(extra: Record<string, unknown>) {
  return { message: { message_id: ++msgSeq, chat: { id: CHAT, type: "supergroup" }, message_thread_id: TOPIC, from: { id: USER, username: "marco" }, ...extra } };
}
const sentTexts = () => tgState.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string);
const reactions = () => tgState.calls.filter((c) => c.method === "setMessageReaction");

let home = "";
let handlers: Record<string, (...a: unknown[]) => void> = {};
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

async function importBooted(): Promise<unknown> {
  vi.resetModules();
  const origOn = process.on.bind(process);
  const onSpy = vi.spyOn(process, "on").mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => {
    if (ev === "SIGHUP" || ev === "SIGTERM") { handlers[ev] = fn; return process; }
    return origOn(ev, fn);
  }) as any);
  try {
    // The module is side-effect free on import (its boot is guarded by
    // import.meta.main). We call the exported boot() to run the same startup
    // path the entry point runs — portable across Vitest/Vite versions.
    const mod = await import("./telegram-bridge-child.js");
    (mod as { boot: () => void }).boot();
    return mod;
  } finally {
    onSpy.mockRestore();
  }
}

async function boot(opts: { bindings?: Record<string, unknown>; token?: string; launcher?: unknown } = {}): Promise<FakeWS> {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ telegramBotToken: opts.token ?? TOKEN }));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ token: "s3c ret" }));
  writeFileSync(join(home, "session-telegram-bindings.json"), JSON.stringify(opts.bindings ?? { [SID]: binding() }));
  if (opts.launcher !== undefined) {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "launcher.json"), JSON.stringify(opts.launcher));
  }
  await importBooted();
  await waitPoll(); // getMe answered, loop parked on getUpdates
  const ws = FakeWS.instances[0];
  ws?.open();
  return ws;
}

/** Deliver messages, let the debounce fire, and let runTurn send its frame. */
async function sendAndFlush(...updates: any[]): Promise<void> {
  await deliver(...updates);
  await vi.advanceTimersByTimeAsync(T.DEBOUNCE);
  await flush();
}
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}
function readAudit(): any[] {
  const f = join(home, "telegram-bridge", "audit.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tg-child-"));
  for (const [k, v] of Object.entries({ ...ENV, COMPANION_HOME: home })) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  FakeWS.instances = [];
  tgState.calls = []; tgState.sendMessageReplies = []; tgState.throwMethods = new Set(); tgState.files = {};
  tgState.relaunches = []; tgState.relaunchError = false;
  poll = null; pollWaiters = []; handlers = {};
  liveness.cliWorking.mockReset().mockReturnValue({ working: false, sample: null });
  liveness.cpuTicks.mockReset().mockReturnValue(null);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  // Stop every bridge of the booted instance so no timers/reconnects leak.
  try { handlers.SIGTERM && vi.spyOn(process, "exit").mockImplementation((() => undefined) as any) && handlers.SIGTERM(); } catch { /* noop */ }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

const logged = (spy: ReturnType<typeof vi.spyOn>, needle: string) =>
  spy.mock.calls.some((args: unknown[]) => args.map(String).join(" ").includes(needle));

describe("boot", () => {
  it("exits cleanly when settings.json has no bot token", async () => {
    writeFileSync(join(home, "settings.json"), "{}");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit-called"); }) as any);
    await expect(importBooted()).rejects.toThrow("exit-called");
    expect(exit).toHaveBeenCalledWith(0);
    expect(logged(errSpy, "no telegramBotToken")).toBe(true);
    // Never reached the poll loop / WS.
    expect(tgState.calls).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(0);
  });

  it("identifies the bot, opens one companion WS per binding with the encoded auth token, and registers signal handlers", async () => {
    const ws = await boot();
    expect(tgState.calls[0]).toMatchObject({ method: "getMe" });
    expect((fetch as any).mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(ws.url).toBe(`ws://127.0.0.1:4567/ws/browser/${SID}?token=s3c%20ret`);
    expect(Object.keys(handlers).sort()).toEqual(["SIGHUP", "SIGTERM"]);
    expect(logged(logSpy, "@FableBot (id 999) up.")).toBe(true);
    expect(logged(logSpy, `[reconcile] 1 binding attive: ${CHAT}:${TOPIC}`)).toBe(true);
  });

  it("starts with no bindings and logs '(nessuna)' when the bindings file is unreadable", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ telegramBotToken: TOKEN }));
    writeFileSync(join(home, "session-telegram-bindings.json"), "{not json");
    await importBooted();
    await waitPoll();
    expect(FakeWS.instances).toHaveLength(0);
    expect(logged(logSpy, "(nessuna)")).toBe(true);
  });
});

describe("text turn round-trip", () => {
  it("acks with 👀, coalesces messages in the debounce window into one user_message, and posts the result as Telegram HTML", async () => {
    const ws = await boot();
    await deliver(textMsg("first"), textMsg("second"));
    expect(reactions().map((r) => r.body.reaction[0].emoji)).toEqual(["👀", "👀"]);
    expect(ws.userMessages()).toHaveLength(0); // still inside the debounce window
    await advance(T.DEBOUNCE);
    expect(tgState.calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing" && c.body.message_thread_id === TOPIC)).toBe(true);
    const [frame] = ws.userMessages();
    expect(frame.content).toBe("first\nsecond");
    expect(frame.images).toBeUndefined();
    expect(frame.client_msg_id).toMatch(/^tg-\d+-\d+$/);

    ws.frame({ type: "result", data: { result: "**done**" } });
    await flush();
    const send = tgState.calls.find((c) => c.method === "sendMessage")!;
    expect(send.body).toMatchObject({ chat_id: CHAT, message_thread_id: TOPIC, parse_mode: "HTML", disable_web_page_preview: true });
    expect(send.body.text).toContain("🐟 Fable →");
    expect(send.body.text).toContain("<b>done</b>");
    // Both directions are audited.
    const dirs = readAudit().map((e) => e.dir).filter(Boolean);
    expect(dirs).toEqual(["in", "out"]);
  });

  it("resends as plain text when Telegram rejects the HTML markup (the answer must never be lost)", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    tgState.sendMessageReplies.push({ ok: false, description: "Bad Request: can't parse entities" });
    ws.frame({ type: "result", data: { result: "**bold** and `code`" } });
    await flush();
    const sends = tgState.calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1].body.parse_mode).toBeUndefined();
    expect(sends[1].body.text).not.toMatch(/<[^>]+>/);
    expect(sends[1].body.text).toContain("bold and code");
    expect(logged(warnSpy, "HTML rejected (Bad Request: can't parse entities)")).toBe(true);
    expect(logged(errSpy, "[tg] sendMessage failed: Bad Request")).toBe(true);
  });

  it.each([
    [{ is_error: true, subtype: "error_during_execution", errors: ["boom", "bang"] }, "Errore turno (error_during_execution): boom; bang"],
    [{ is_error: true }, "Errore turno (?): no detail"],
    [{ is_error: true, result: "rate limited" }, "rate limited"],
    [{ stop_reason: "refusal", stop_details: { category: "cyber" } }, "Fable ha rifiutato (cyber)"],
    [{ stop_reason: "refusal" }, "Fable ha rifiutato (policy)"],
    [{}, "(nessun testo nel result)"],
  ])("formats result %j for the user", async (data, expected) => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "result", data });
    await flush();
    expect(sentTexts().at(-1)).toContain(expected);
  });

  it("caps the coalesced input at TG_MAX_INPUT_CHARS", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("x".repeat(T.MAX_INPUT + 500)));
    expect(ws.userMessages()[0].content).toHaveLength(T.MAX_INPUT);
  });

  it("ignores non-JSON WS frames and result frames when no turn is active", async () => {
    const ws = await boot();
    ws.frame("not json{");
    ws.frame({ type: "result", data: { result: "stray" } });
    await flush();
    expect(sentTexts()).toHaveLength(0);
  });

  it("waits briefly for the WS to open before sending when it is not yet connected", async () => {
    await importBootedWithBinding();
    const ws = FakeWS.instances[0]; // never opened
    await deliver(textMsg("hi"));
    await advance(T.DEBOUNCE);
    expect(ws.userMessages()).toHaveLength(0);
    await advance(500);
    expect(ws.userMessages()).toHaveLength(1);
  });

  it("reports a failed WS send back to the chat instead of hanging", async () => {
    const ws = await boot();
    ws.throwOnSend = true;
    await sendAndFlush(textMsg("hi"));
    expect(sentTexts().at(-1)).toContain("invio fallito: socket gone");
    // No turn was registered: /status shows idle.
    ws.throwOnSend = false;
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("turno:idle");
  });
});

async function importBootedWithBinding(): Promise<void> {
  writeFileSync(join(home, "settings.json"), JSON.stringify({ telegramBotToken: TOKEN }));
  writeFileSync(join(home, "auth.json"), JSON.stringify({ token: "s3c ret" }));
  writeFileSync(join(home, "session-telegram-bindings.json"), JSON.stringify({ [SID]: binding() }));
  await importBooted();
  await waitPoll();
}

describe("queueing", () => {
  it("queues messages arriving mid-turn, runs them after the result, and refuses beyond TG_MAX_QUEUE", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("one"));
    expect(ws.userMessages()).toHaveLength(1);
    await sendAndFlush(textMsg("two"));
    await sendAndFlush(textMsg("three"));
    expect(ws.userMessages()).toHaveLength(1); // both queued (depth 1, 2)
    await sendAndFlush(textMsg("four"));        // queue full
    expect(sentTexts().at(-1)).toContain("troppi messaggi in coda");
    expect(readAudit().filter((e) => e.dir === "queued").map((e) => e.depth)).toEqual([1, 2, 3]);

    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("turno:in corso | coda:2");

    ws.frame({ type: "result", data: { result: "r1" } });
    await flush();
    expect(ws.userMessages().map((f) => f.content)).toEqual(["one", "two"]);
    ws.frame({ type: "result", data: { result: "r2" } });
    await flush();
    expect(ws.userMessages().map((f) => f.content)).toEqual(["one", "two", "three"]);
  });
});

describe("turn watchdogs", () => {
  it("sends a one-time 'long turn' heads-up without resolving the turn", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "assistant" });
    await advance(T.ACK);
    expect(sentTexts().filter((t) => t.includes("turno lungo"))).toHaveLength(1);
    ws.frame({ type: "result", data: { result: "final" } });
    await flush();
    expect(sentTexts().at(-1)).toContain("final");
  });

  it("relaunches the CLI (force, bearer auth) and frees the turn when the message is never picked up", async () => {
    const ws = await boot({ launcher: [{ sessionId: "other", pid: 1 }, { sessionId: SID, pid: 4321 }] });
    liveness.cpuTicks.mockReturnValue(77);
    await sendAndFlush(textMsg("q"));
    expect(liveness.cpuTicks).toHaveBeenCalledWith(4321);
    await advance(T.FIRST_ACTIVITY);
    // The busy guard was consulted with the live pid and the turn's CPU baseline.
    expect(liveness.cliWorking).toHaveBeenCalledTimes(1);
    expect(liveness.cliWorking.mock.calls[0][0]).toBe(4321);
    expect(liveness.cliWorking.mock.calls[0][1]).toMatchObject({ ticks: 77 });
    expect(tgState.relaunches).toHaveLength(1);
    expect(tgState.relaunches[0].url).toBe(`http://127.0.0.1:4567/api/sessions/${SID}/relaunch?force=1`);
    expect(tgState.relaunches[0].init).toMatchObject({ method: "POST", headers: { authorization: "Bearer s3c ret" } });
    expect(sentTexts().at(-1)).toContain("non è stato preso in carico");
    expect(logged(logSpy, "(no activity after send) → 200")).toBe(true);
    // Late frames after the give-up are ignored.
    ws.frame({ type: "result", data: { result: "late" } });
    await flush();
    expect(sentTexts().some((t) => t.includes("late"))).toBe(false);
  });

  it("defers the no-activity relaunch while the CLI is provably working, then relaunches once it is idle", async () => {
    await boot({ launcher: { not: "an array" } });
    liveness.cliWorking.mockReturnValueOnce({ working: true, sample: { ticks: 5, at: 1 } });
    await sendAndFlush(textMsg("q"));
    await advance(T.FIRST_ACTIVITY);
    expect(tgState.relaunches).toHaveLength(0);
    expect(logged(logSpy, "DEFERRED (no activity after send)")).toBe(true);
    // Non-array launcher state → no pid.
    expect(liveness.cliWorking.mock.calls[0][0]).toBeNull();
    await advance(T.FIRST_ACTIVITY);
    expect(liveness.cliWorking.mock.calls[1][1]).toEqual({ ticks: 5, at: 1 }); // sample carried forward
    expect(tgState.relaunches).toHaveLength(1);
  });

  it("detects a mid-turn stall after activity and relaunches; every frame slides the stall window", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "stream_event" });
    await advance(T.STALL - 500);
    ws.frame({ type: "system_event" }); // keeps it alive
    await advance(T.STALL - 500);
    expect(tgState.relaunches).toHaveLength(0);
    // First-activity guard saw activity → never fired a relaunch on its own.
    await advance(500);
    expect(tgState.relaunches).toHaveLength(1);
    expect(sentTexts().at(-1)).toContain("turno bloccato");
  });

  it("re-arms the stall timer instead of relaunching while the CLI is busy", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "permission_request" });
    liveness.cliWorking.mockReturnValueOnce({ working: true, sample: null });
    await advance(T.STALL);
    expect(tgState.relaunches).toHaveLength(0);
    expect(logged(logSpy, "DEFERRED (mid-turn stall)")).toBe(true);
    await advance(T.STALL);
    expect(tgState.relaunches).toHaveLength(1);
  });

  it("hard-caps a turn that keeps streaming but never produces a result", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    for (let t = 0; t < T.TIMEOUT; t += 2500) {
      ws.frame({ type: "stream_event" });
      await advance(2500);
    }
    expect(tgState.relaunches).toHaveLength(1);
    expect(sentTexts().at(-1)).toContain("timeout: nessun result");
  });

  it("relaunches once when the CLI disconnects mid-turn, and the cooldown suppresses a second relaunch", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "cli_disconnected" });
    ws.frame({ type: "cli_disconnected" }); // same turn → no second relaunch
    await flush();
    expect(tgState.relaunches).toHaveLength(1);
    expect(logged(logSpy, "(cli disconnected mid-turn) → 200")).toBe(true);
    // Stall within the cooldown window: turn is freed but no extra relaunch.
    ws.frame({ type: "assistant" });
    await advance(T.STALL);
    expect(tgState.relaunches).toHaveLength(1);
    expect(logged(logSpy, "SKIPPED (mid-turn stall)")).toBe(true);
    expect(sentTexts().at(-1)).toContain("turno bloccato");
  });

  it("ignores cli_disconnected when no turn is running", async () => {
    const ws = await boot();
    ws.frame({ type: "cli_disconnected" });
    await flush();
    expect(tgState.relaunches).toHaveLength(0);
  });

  it("logs and survives a failed relaunch request", async () => {
    const ws = await boot();
    tgState.relaunchError = true;
    await sendAndFlush(textMsg("q"));
    ws.frame({ type: "cli_disconnected" });
    await flush();
    expect(logged(errSpy, "failed: ECONNREFUSED")).toBe(true);
  });
});

describe("WS lifecycle", () => {
  it("reconnects 2s after the companion WS closes and reports ws:giù meanwhile", async () => {
    const ws = await boot();
    ws.emit("error");
    ws.emit("close");
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("ws:giù");
    expect(FakeWS.instances).toHaveLength(1);
    await advance(2000);
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1].url).toBe(ws.url);
  });

  it("uses session_init's cwd for the inbox and ignores session_init without one", async () => {
    const ws = await boot();
    const cwd = mkdtempSync(join(tmpdir(), "tg-cwd-"));
    try {
      ws.frame({ type: "session_init", session: {} });
      ws.frame({ type: "session_init", session: { cwd } });
      tgState.files.doc1 = { file_path: "documents/a.txt", file_size: 3, bytes: Buffer.from("abc") };
      await sendAndFlush(mediaMsg({ document: { file_id: "doc1", file_name: "a.txt", mime_type: "text/plain" } }));
      expect(readFileSync(join(cwd, ".telegram-inbox", "a.txt"), "utf-8")).toBe("abc");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("commands", () => {
  it("/stop interrupts the CLI, drops the pending buffer and ignores input until /resume", async () => {
    const ws = await boot();
    await deliver(textMsg("pending"));
    await deliver(textMsg("/stop"));
    expect(ws.sent.some((f) => f.type === "interrupt" && /^tg-stop-\d+$/.test(f.client_msg_id))).toBe(true);
    expect(sentTexts().at(-1)).toContain("bridge fermato");
    await advance(T.DEBOUNCE);
    expect(ws.userMessages()).toHaveLength(0);

    const reactsBefore = reactions().length;
    await sendAndFlush(textMsg("while stopped"));
    expect(reactions()).toHaveLength(reactsBefore); // not even acknowledged
    expect(ws.userMessages()).toHaveLength(0);
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("STOPPATO");

    await deliver(textMsg("/resume"));
    expect(sentTexts().at(-1)).toContain("bridge ripreso");
    await sendAndFlush(textMsg("back"));
    expect(ws.userMessages().map((f) => f.content)).toEqual(["back"]);
  });

  it("/status reports a healthy idle bridge", async () => {
    await boot();
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain(`sessione ${SID.slice(0, 8)} | ws:connesso | turno:idle | coda:0 | attivo`);
  });

  it("silently ignores unknown /commands and whitespace-only text", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("/unknown"), textMsg("   "));
    expect(reactions()).toHaveLength(0);
    expect(ws.userMessages()).toHaveLength(0);
    expect(sentTexts()).toHaveLength(0);
  });

  it("survives a /stop when the WS send throws", async () => {
    const ws = await boot();
    ws.throwOnSend = true;
    await deliver(textMsg("/stop"));
    expect(sentTexts().at(-1)).toContain("bridge fermato");
  });
});

describe("routing & authorization", () => {
  it("logs unknown chats for discovery and does nothing else", async () => {
    await boot();
    await deliver({ message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 1, username: "x" }, text: "hello there" } });
    expect(logged(logSpy, "[discover] chat.id=555 type=private topic=none from.id=1 (@x)")).toBe(true);
    expect(reactions()).toHaveLength(0);
  });

  it("rejects senders not on the allowlist and audits the attempt", async () => {
    await boot();
    await deliver(textMsg("hi", { from: { id: 13, username: "mallory" } }));
    expect(reactions()).toHaveLength(0);
    expect(readAudit()).toContainEqual(expect.objectContaining({ event: "unauthorized", session: SID, fromId: 13, username: "mallory" }));
  });

  it("falls back to the chat-level (topic-less) binding for messages inside a topic", async () => {
    const ws = await boot({ bindings: { [SID]: binding({ topicId: null }) } });
    await sendAndFlush(textMsg("in topic 55", { message_thread_id: 55 }));
    expect(ws.userMessages()[0].content).toBe("in topic 55");
    // Replies go to the binding's own (null) topic.
    ws.frame({ type: "result", data: { result: "ok" } });
    await flush();
    expect(tgState.calls.filter((c) => c.method === "sendMessage").at(-1)!.body.message_thread_id).toBeUndefined();
  });

  it("ignores updates without a message or without any usable content", async () => {
    await boot();
    await deliver({ edited_message: { text: "x" } }, mediaMsg({ sticker: { file_id: "s" } }), mediaMsg({ photo: [] }));
    expect(tgState.calls.filter((c) => c.method !== "getMe")).toHaveLength(0);
  });

  it("ignores a disabled binding", async () => {
    const ws = await boot({ bindings: { [SID]: binding({ enabled: false }) } });
    await sendAndFlush(textMsg("hi"));
    expect(ws.userMessages()).toHaveLength(0);
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("disabilitato");
  });
});

describe("requireMention (group bindings)", () => {
  const bindings = { [SID]: binding({ requireMention: true }) };

  it("ignores free chat that does not address the bot", async () => {
    const ws = await boot({ bindings });
    await sendAndFlush(textMsg("just chatting", { entities: [{ type: "mention", offset: 0, length: 4 }] }));
    expect(reactions()).toHaveLength(0);
    expect(ws.userMessages()).toHaveLength(0);
  });

  it("accepts an @mention and strips it from the text the model sees", async () => {
    const ws = await boot({ bindings });
    await sendAndFlush(textMsg("@FableBot  fai   questo", { entities: [{ type: "bot_command", offset: 0, length: 1 }, { type: "mention", offset: 0, length: 9 }] }));
    expect(ws.userMessages()[0].content).toBe("fai questo");
  });

  it("accepts a reply to the bot without a mention", async () => {
    const ws = await boot({ bindings });
    await sendAndFlush(textMsg("sì procedi", { reply_to_message: { from: { id: BOT_ID } } }));
    expect(ws.userMessages()[0].content).toBe("sì procedi");
  });

  it("accepts untagged continuation parts from the same user while the coalesce window is open", async () => {
    const ws = await boot({ bindings });
    await deliver(textMsg("@FableBot part one", { entities: [{ type: "mention", offset: 0, length: 9 }] }));
    await deliver(textMsg("part two"));                                        // same user → continuation
    await deliver(textMsg("intruder", { from: { id: 77, username: "o" } }));    // not allowlisted anyway
    await advance(T.DEBOUNCE);
    expect(ws.userMessages().map((f) => f.content)).toEqual(["part one\npart two"]);
    // Window closed → a later untagged message is free chat again.
    await sendAndFlush(textMsg("later"));
    expect(ws.userMessages()).toHaveLength(1);
  });

  it("lets commands through without a mention", async () => {
    await boot({ bindings });
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("ℹ️ sessione");
  });

  it("drops a message that is only the mention", async () => {
    const ws = await boot({ bindings });
    await sendAndFlush(textMsg("@FableBot", { entities: [{ type: "mention", offset: 0, length: 9 }] }));
    expect(ws.userMessages()).toHaveLength(0);
  });

  it("uses caption_entities for a tagged photo caption", async () => {
    const ws = await boot({ bindings });
    tgState.files.p1 = { file_path: "photos/p1.jpg", file_size: 3, bytes: Buffer.from("IMG") };
    await sendAndFlush(mediaMsg({ photo: [{ file_id: "p1" }], caption: "@FableBot guarda", caption_entities: [{ type: "mention", offset: 0, length: 9 }] }));
    expect(ws.userMessages()[0].content).toBe("guarda");
  });
});

describe("attachments", () => {
  it("inlines the largest photo size as a base64 JPEG with a default prompt", async () => {
    const ws = await boot();
    tgState.files.big = { file_path: "photos/big.jpg", file_size: 3, bytes: Buffer.from("IMG") };
    await sendAndFlush(mediaMsg({ photo: [{ file_id: "small" }, { file_id: "big" }] }));
    expect(tgState.calls.find((c) => c.method === "getFile")!.body.file_id).toBe("big");
    const [f] = ws.userMessages();
    expect(f.content).toBe("Guarda questa immagine.");
    expect(f.images).toEqual([{ media_type: "image/jpeg", data: Buffer.from("IMG").toString("base64") }]);
    expect(readAudit().find((e) => e.dir === "in").images).toBe(1);
  });

  it.each([
    ["no file_path from getFile", {}],
    ["declared size over the cap", { file_path: "photos/x.jpg", file_size: T.MAX_FILE + 1 }],
    ["file server error", { file_path: "photos/x.jpg", file_size: 3, status: 404 }],
    ["downloaded bytes over the cap", { file_path: "photos/x.jpg", bytes: Buffer.alloc(T.MAX_FILE + 1) }],
  ])("refuses a photo when %s", async (_label, file) => {
    const ws = await boot();
    tgState.files.x = file as TgFile;
    await sendAndFlush(mediaMsg({ photo: [{ file_id: "x" }], caption: "look" }));
    expect(sentTexts().at(-1)).toContain("immagine troppo grande o non scaricabile (max 0MB)");
    expect(ws.userMessages()).toHaveLength(0);
  });

  it("inlines image documents with their own media type and keeps the caption", async () => {
    const ws = await boot();
    tgState.files.d = { file_path: "documents/pic.png", file_size: 3, bytes: Buffer.from("PNG") };
    await sendAndFlush(mediaMsg({ document: { file_id: "d", file_name: "pic.png", mime_type: "image/png" }, caption: "cosa vedi?" }));
    const [f] = ws.userMessages();
    expect(f.content).toBe("cosa vedi?");
    expect(f.images).toEqual([{ media_type: "image/png", data: Buffer.from("PNG").toString("base64") }]);
  });

  it("saves other documents into the session inbox under a sanitized name and tells the model where", async () => {
    const ws = await boot();
    tgState.files.d = { file_path: "documents/r.pdf", file_size: 4, bytes: Buffer.from("%PDF") };
    await sendAndFlush(mediaMsg({ document: { file_id: "d", file_name: "../../evil.pdf", mime_type: "application/pdf" }, caption: "analizza" }));
    const saved = join(home, "telegram-bridge", SID, ".telegram-inbox", "evil.pdf");
    expect(readFileSync(saved, "utf-8")).toBe("%PDF");
    const [f] = ws.userMessages();
    expect(f.content.startsWith("analizza\n\n📎 File ricevuto via Telegram")).toBe(true);
    expect(f.content).toContain(`\`${saved}\``);
    expect(f.content).toContain("tipo: application/pdf, 4 byte");
    expect(readAudit()).toContainEqual(expect.objectContaining({ event: "file_saved", path: saved, bytes: 4, mime: "application/pdf" }));
  });

  it("names an anonymous, untyped document with a generated .bin name", async () => {
    const ws = await boot();
    tgState.files.d = { file_path: "documents/blob", file_size: 2, bytes: Buffer.from("xx") };
    await sendAndFlush(mediaMsg({ document: { file_id: "d" } }));
    const content: string = ws.userMessages()[0].content;
    expect(content).toMatch(/^📎 File ricevuto via Telegram, salvato in `.*\/file-\d+\.bin` \(nome: file-\d+\.bin, 2 byte\)/);
    expect(content).not.toContain("tipo:");
  });

  it("reports an undownloadable document", async () => {
    await boot();
    tgState.files.d = {};
    await deliver(mediaMsg({ document: { file_id: "d", file_name: "a.zip" } }));
    expect(sentTexts().at(-1)).toContain("file troppo grande o non scaricabile");
  });

  it("reports a filesystem error while saving instead of crashing the loop", async () => {
    const ws = await boot();
    // cwd points at a regular file → mkdir of the inbox fails with ENOTDIR.
    const notADir = join(home, "plainfile");
    writeFileSync(notADir, "");
    ws.frame({ type: "session_init", session: { cwd: notADir } });
    tgState.files.d = { file_path: "documents/a.txt", file_size: 1, bytes: Buffer.from("a") };
    await deliver(mediaMsg({ document: { file_id: "d", file_name: "a.txt", mime_type: "text/plain" } }));
    expect(sentTexts().at(-1)).toContain("errore gestione file");
    expect(ws.userMessages()).toHaveLength(0);
  });
});

describe("long-poll loop resilience", () => {
  it("advances the offset past handled updates", async () => {
    await boot();
    await deliver(textMsg("/status"), textMsg("/status"));
    const lastPoll = (fetch as any).mock.calls.map((c: unknown[]) => String(c[0])).filter((u: string) => u.includes("getUpdates")).at(-1);
    expect(lastPoll).toContain(`offset=${updateSeq + 1}&timeout=30&allowed_updates=${encodeURIComponent('["message"]')}`);
  });

  it("logs a handler error and keeps processing the rest of the batch", async () => {
    await boot({ bindings: { [SID]: binding({ requireMention: true }) } });
    // entities that is not an array makes the mention filter throw inside handleUpdate.
    await deliver(textMsg("boom", { entities: { bogus: true } }), textMsg("/status"));
    expect(logged(errSpy, "[handle] error:")).toBe(true);
    expect(sentTexts().at(-1)).toContain("ℹ️ sessione");
  });

  it("backs off 2s after a getUpdates failure, then polls again", async () => {
    await boot();
    const p = poll!; poll = null;
    p.rej(new Error("ETIMEDOUT"));
    await flush();
    expect(logged(errSpy, "[poll] error: ETIMEDOUT")).toBe(true);
    expect(poll).toBeNull();
    await advance(2000);
    expect(poll).not.toBeNull();
  });

  it("treats a Telegram network error as a failed call without breaking the turn", async () => {
    const ws = await boot();
    tgState.throwMethods.add("setMessageReaction");
    tgState.throwMethods.add("sendChatAction");
    await sendAndFlush(textMsg("hi"));
    expect(logged(errSpy, "[tg] setMessageReaction error: setMessageReaction network down")).toBe(true);
    expect(ws.userMessages()).toHaveLength(1);
  });
});

describe("signals", () => {
  it("SIGHUP reconciles: drops removed bindings, adds new ones, updates existing ones in place", async () => {
    const TOPIC2 = 8;
    await boot({ bindings: { [SID]: binding(), [SID2]: binding({ topicId: TOPIC2 }) } });
    const [ws1, ws2] = FakeWS.instances;
    const SID3 = "sess3333-eeee";
    writeFileSync(join(home, "session-telegram-bindings.json"), JSON.stringify({
      [SID]: binding({ enabled: false }),
      [SID3]: binding({ topicId: 9 }),
    }));
    handlers.SIGHUP();
    expect(ws2.closed).toBe(true);
    expect(ws1.closed).toBe(false); // same bridge, updated binding
    expect(FakeWS.instances).toHaveLength(3);
    expect(FakeWS.instances[2].url).toContain(`/ws/browser/${SID3}?`);
    // Removed binding's route is gone → discovery log.
    await deliver(textMsg("hello", { message_thread_id: TOPIC2 }));
    expect(logged(logSpy, `[discover] chat.id=${CHAT} type=supergroup topic=${TOPIC2}`)).toBe(true);
    // Updated binding takes effect on the existing bridge.
    await deliver(textMsg("/status"));
    expect(sentTexts().at(-1)).toContain("disabilitato");
    // A disposed bridge never reconnects.
    await advance(5000);
    expect(FakeWS.instances).toHaveLength(3);
  });

  it("SIGTERM disposes every bridge (incl. a running turn's timers) and exits 0", async () => {
    const ws = await boot();
    await sendAndFlush(textMsg("q"));
    await deliver(textMsg("queued-in-debounce"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
    handlers.SIGTERM();
    expect(exit).toHaveBeenCalledWith(0);
    expect(ws.closed).toBe(true);
    await advance(T.TIMEOUT * 2);
    expect(tgState.relaunches).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
