/**
 * Telegram bridge — child process (spawned & supervised by telegram-bridge-manager).
 *
 * Acts as a headless "browser" client on companion's WS: bridges Telegram
 * groups/topics (or DMs) to companion sessions. Human msg → coalesce (debounce)
 * → user_message over WS → wait for `result` → post the answer back.
 *
 * Config is read from companion's own files (no IPC): the bot token from
 * settings.json, the per-session bindings from session-telegram-bindings.json,
 * the companion auth token from auth.json. On SIGHUP it reloads the bindings and
 * reconciles live connections (add new, drop removed, update allowlist).
 *
 * Runs standalone under Bun (`bun telegram-bridge-child.ts`); imports only node
 * built-ins + the shared binding type, so it never pulls in server internals.
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import type { TelegramBinding } from "./session-telegram-bindings.js";
import { cliWorking, cpuTicks } from "./cli-liveness.js";

// ── Paths / config ───────────────────────────────────────────────────────────
const COMPANION_HOME = process.env.COMPANION_HOME || join(homedir(), ".companion");
const COMPANION_PORT = process.env.COMPANION_PORT || "3456";
const SETTINGS_FILE = join(COMPANION_HOME, "settings.json");
const AUTH_FILE = join(COMPANION_HOME, "auth.json");
const BINDINGS_FILE = join(COMPANION_HOME, "session-telegram-bindings.json");
const LAUNCHER_FILE = join(COMPANION_HOME, "sessions", "launcher.json");
const AUDIT_LOG = join(COMPANION_HOME, "telegram-bridge", "audit.jsonl");

const DEBOUNCE_MS = Number(process.env.TG_DEBOUNCE_MS) || 4000;
// Generous cap: a single coalesced turn (e.g. Ema pasting a large Codex output
// that Telegram split into several messages). Guards against runaway input.
const MAX_INPUT_CHARS = Number(process.env.TG_MAX_INPUT_CHARS) || 100000;
// Hard cap on how long we wait for a turn's `result`. Raised well above real
// task durations (a full suite+build can run 30+ min) so a legit long turn still
// gets its answer delivered instead of a spurious timeout. Env-overridable.
const TURN_TIMEOUT_MS = Number(process.env.TG_TURN_TIMEOUT_MS) || 90 * 60 * 1000;
// One-time \"still working\" heads-up so a long turn doesn't look dead. Does NOT
// resolve the turn — the real result is still forwarded whenever it lands.
const TURN_ACK_MS = Number(process.env.TG_TURN_ACK_MS) || 10 * 60 * 1000;
// A relaunch KILLS the CLI, which makes companion emit `cli_disconnected` — the
// very event we also relaunch on. Without this cooldown the second relaunch
// lands on the freshly spawned CLI ~0ms after `--resume`, which cli-launcher
// reads as a failed resume and CLEARS cliSessionId: the session then restarts
// with no context and the in-flight message is lost. One relaunch per window.
const RELAUNCH_COOLDOWN_MS = Number(process.env.TG_RELAUNCH_COOLDOWN_MS) || 120 * 1000;
// A live CLI starts streaming within seconds of receiving a message. Total
// silence for this long means the message never landed (sent into a CLI that
// was dying/being relaunched) — fail fast instead of burning the full
// TURN_TIMEOUT_MS, which would also block every message queued behind it.
// This is deliberately NOT a general inactivity timeout: a turn that has
// started may legitimately go quiet for a long time inside one tool call.
const FIRST_ACTIVITY_MS = Number(process.env.TG_FIRST_ACTIVITY_MS) || 3 * 60 * 1000;
// Rolling mid-turn stall guard: a turn that HAS started (streamed frames) then
// goes silent this long has deadlocked inside the CLI (observed: the model turn
// after a tool_result never resumes; process idle, no network, no tool child).
// Reset on every frame. Kept above BASH_MAX_TIMEOUT_MS's 10-min ceiling so a
// legitimately long synchronous tool can't trip it, yet far below TURN_TIMEOUT_MS
// so recovery is minutes, not 90.
const STALL_MS = Number(process.env.TG_STALL_MS) || 12 * 60 * 1000;
const TG_CHUNK = 3900;
const FABLE_PREFIX = "🐟 Fable →\n";
// Cap queued turns so a flood while a turn is running can't grow memory unbounded.
const MAX_QUEUE = Number(process.env.TG_MAX_QUEUE) || 20;
// Telegram getFile serves files up to 20 MB — cap downloads accordingly.
const MAX_FILE_BYTES = Number(process.env.TG_MAX_FILE_BYTES) || 20 * 1024 * 1024;
const IMAGE_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

interface Attachment { media_type: string; data: string } // base64 image for user_message.images

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(file, "utf-8")) as T; } catch { return fallback; }
}
function loadToken(): string {
  return (readJson<Record<string, unknown>>(SETTINGS_FILE, {}).telegramBotToken as string) || "";
}
function loadCompanionAuth(): string {
  return (readJson<Record<string, unknown>>(AUTH_FILE, {}).token as string) || "";
}
function loadBindings(): Record<string, TelegramBinding> {
  return readJson<Record<string, TelegramBinding>>(BINDINGS_FILE, {});
}
function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(COMPANION_HOME, "telegram-bridge"), { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch { /* best-effort */ }
}

// ── Telegram REST ────────────────────────────────────────────────────────────
let BOT_ID: number | null = null;
let BOT_USERNAME: string | null = null;
const BOT_TOKEN = loadToken();
const COMPANION_AUTH = loadCompanionAuth();
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(`${TG}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!j.ok) console.error(`[tg] ${method} failed: ${j.description || res.status}`);
    return j;
  } catch (e) {
    console.error(`[tg] ${method} error:`, (e as Error).message);
    return { ok: false };
  }
}
async function sendText(chatId: number, topicId: number | null, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += TG_CHUNK) {
    await tg("sendMessage", {
      chat_id: chatId,
      message_thread_id: topicId ?? undefined,
      text: text.slice(i, i + TG_CHUNK),
      disable_web_page_preview: true,
    });
  }
}
async function react(chatId: number, messageId: number, emoji: string): Promise<void> {
  await tg("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: "emoji", emoji }] : [] });
}
async function typing(chatId: number, topicId: number | null): Promise<void> {
  await tg("sendChatAction", { chat_id: chatId, message_thread_id: topicId ?? undefined, action: "typing" });
}

/** Download a Telegram file (getFile → file server). Enforces the size cap. */
async function downloadTelegramFile(fileId: string): Promise<Buffer | null> {
  const info = await tg("getFile", { file_id: fileId });
  const filePath: string | undefined = info.result?.file_path;
  const size: number | undefined = info.result?.file_size;
  if (!filePath) return null;
  if (typeof size === "number" && size > MAX_FILE_BYTES) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length <= MAX_FILE_BYTES ? buf : null;
}

/**
 * Safe filename for a downloaded attachment. Defends against path traversal:
 * `basename` drops any directory component, the char whitelist strips separators
 * and shell/markdown metacharacters, and leading dots are removed so a name of
 * "." / ".." / "..evil" can never escape or target the inbox dir itself.
 */
export function safeName(name: string | undefined, fallbackExt: string): string {
  let base = basename(name || "")
    .replace(/[^\w.\- ]+/g, "_")   // strip separators + metacharacters
    .replace(/^[.\s]+/, "")         // no leading dots/spaces (., .., dotfiles)
    .trim();
  if (!base || base === "." || base === "..") base = `file-${Date.now()}${fallbackExt.replace(/[^\w.]/g, "") || ".bin"}`;
  return base.slice(0, 120);
}

// ── Per-session bridge over companion WS ─────────────────────────────────────
class SessionBridge {
  sessionId: string;
  binding: TelegramBinding;
  private ws: WebSocket | null = null;
  private connected = false;
  private disposed = false;
  private turn: { resolve: (t: string) => void; timers: ReturnType<typeof setTimeout>[]; relaunched: boolean; sawActivity: boolean; stallTimer?: ReturnType<typeof setTimeout>; startTimer?: ReturnType<typeof setTimeout>; cpu: number | null } | null = null;
  private lastRelaunchAt = 0;
  private buffer: string[] = [];
  private pendingImages: Attachment[] = [];
  private bufferFrom: number | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: { text: string; images: Attachment[] }[] = [];
  private stopped = false;
  cwd: string | null = null;

  constructor(sessionId: string, binding: TelegramBinding) {
    this.sessionId = sessionId;
    this.binding = binding;
    this.connect();
  }

  update(binding: TelegramBinding): void { this.binding = binding; }

  private connect(): void {
    if (this.disposed) return;
    const url = `ws://127.0.0.1:${COMPANION_PORT}/ws/browser/${this.sessionId}?token=${encodeURIComponent(COMPANION_AUTH)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("open", () => { this.connected = true; console.log(`[ws] open ${this.sessionId.slice(0, 8)}`); });
    ws.addEventListener("close", () => {
      this.connected = false;
      if (!this.disposed) setTimeout(() => this.connect(), 2000);
    });
    ws.addEventListener("error", () => { /* close handler reconnects */ });
    ws.addEventListener("message", (ev: MessageEvent) => this.onWsMessage(ev.data as string));
  }

  private onWsMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "session_init" && m.session?.cwd) this.cwd = m.session.cwd;
    // Any sign the CLI actually picked the turn up (see FIRST_ACTIVITY_MS).
    if (this.turn && (m.type === "assistant" || m.type === "stream_event" || m.type === "system_event" || m.type === "result" || m.type === "permission_request")) {
      this.turn.sawActivity = true;
      this.bumpStall();
    }
    if (m.type === "result" && this.turn) {
      const d = m.data || {};
      let text: string;
      if (d.is_error) text = `⚠️ Errore turno (${d.subtype || "?"}): ${(d.errors || []).join("; ") || d.result || "no detail"}`;
      else if (d.stop_reason === "refusal") text = `⚠️ Fable ha rifiutato (${d.stop_details?.category || "policy"}).`;
      else text = d.result || "(nessun testo nel result)";
      const t = this.turn; this.turn = null;
      this.clearTurnTimers(t);
      t.resolve(text);
    }
    // CLI died mid-turn (crash / idle-kill): proactively relaunch it — like the
    // web UI does on send — so the session recovers instead of hanging until the
    // hard cap. Once per turn, to avoid a relaunch loop.
    if (m.type === "cli_disconnected" && this.turn && !this.turn.relaunched) {
      this.turn.relaunched = true;
      void this.requestRelaunch("cli disconnected mid-turn");
    }
  }

  /** Clear every timer attached to a turn (fixed set + the rolling stall timer). */
  private clearTurnTimers(t: { timers: ReturnType<typeof setTimeout>[]; stallTimer?: ReturnType<typeof setTimeout>; startTimer?: ReturnType<typeof setTimeout> }): void {
    for (const tm of t.timers) clearTimeout(tm);
    if (t.stallTimer) clearTimeout(t.stallTimer);
    if (t.startTimer) clearTimeout(t.startTimer);
  }

  /**
   * (Re)arm the rolling mid-turn stall timer. Called on every inbound frame once
   * a turn has started: as long as the CLI keeps streaming, this keeps sliding
   * forward. If it ever fires, the turn produced nothing for STALL_MS despite
   * having started — a CLI-internal deadlock — so relaunch and free the queue.
   */
  private bumpStall(): void {
    const t = this.turn;
    if (!t) return;
    if (t.stallTimer) clearTimeout(t.stallTimer);
    t.stallTimer = setTimeout(() => {
      if (this.turn !== t) return;
      if (this.busyGuard("mid-turn stall", t)) { this.bumpStall(); return; }
      this.turn = null;
      this.clearTurnTimers(t);
      void this.requestRelaunch("mid-turn stall");
      t.resolve(`⚠️ turno bloccato: nessuna attività per ${Math.round(STALL_MS / 60000)} min dopo l'avvio. Ho ripristinato la sessione — rimanda il messaggio.`);
    }, STALL_MS);
  }

  /**
   * A coalesce window is currently open for this user — used to accept
   * continuation parts of a message that Telegram split (or rapid follow-ups)
   * without re-requiring the @mention on every part.
   */
  continuationOpen(fromId: number): boolean {
    return this.debounceTimer !== null && this.bufferFrom === fromId;
  }

  /** Directory where downloaded Telegram files land (inside the session cwd). */
  inboxDir(): string {
    const base = this.cwd || join(COMPANION_HOME, "telegram-bridge", this.sessionId);
    return join(base, ".telegram-inbox");
  }

  ingest(text: string, fromId: number, chatId: number, messageId: number, image?: Attachment): void {
    if (this.stopped || !this.binding.enabled) return;
    if (text) this.buffer.push(text);
    if (image) this.pendingImages.push(image);
    this.bufferFrom = fromId;
    react(chatId, messageId, "👀").catch(() => {});
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushBuffer(), DEBOUNCE_MS);
  }

  private flushBuffer(): void {
    this.debounceTimer = null;
    this.bufferFrom = null;
    if (this.buffer.length === 0 && this.pendingImages.length === 0) return;
    const payload = {
      text: this.buffer.join("\n").slice(0, MAX_INPUT_CHARS),
      images: this.pendingImages,
    };
    this.buffer = [];
    this.pendingImages = [];
    if (this.turn) {
      audit({ dir: "queued", session: this.sessionId, text: payload.text.slice(0, 200), depth: this.queue.length + 1 });
      if (this.queue.length >= MAX_QUEUE) {
        void sendText(this.binding.groupId, this.binding.topicId, "⚠️ troppi messaggi in coda — aspetta che finisca il turno.");
        return;
      }
      this.queue.push(payload);
      return;
    }
    void this.runTurn(payload);
  }

  private async runTurn(payload: { text: string; images: Attachment[] }): Promise<void> {
    if (this.stopped || this.disposed) return;
    const { groupId, topicId } = this.binding;
    audit({ dir: "in", session: this.sessionId, text: payload.text, images: payload.images.length });
    await typing(groupId, topicId).catch(() => {});
    if (!this.connected) await new Promise((r) => setTimeout(r, 500));
    const client_msg_id = `tg-${Date.now()}-${Math.floor(performance.now())}`;
    const frame = {
      type: "user_message",
      content: payload.text,
      images: payload.images.length ? payload.images : undefined,
      client_msg_id,
    };
    try { this.ws?.send(JSON.stringify(frame)); }
    catch (e) { await sendText(groupId, topicId, `⚠️ invio fallito: ${(e as Error).message}`); return; }

    const answer = await new Promise<string>((resolve) => {
      // One-time heads-up: the turn is long but alive. Keep waiting.
      const ackTimer = setTimeout(() => {
        void sendText(groupId, topicId, "⏳ turno lungo — sto ancora elaborando, ti mando la risposta appena pronta.");
      }, TURN_ACK_MS);
      // Hard cap: give up, but first relaunch the CLI so a wedged turn can't keep
      // blocking every following message queued on this session.
      // Message never taken up → recover in minutes, not in TURN_TIMEOUT_MS.
      // No-activity guard: if the turn produces NO frame at all, the message was
      // likely dropped (dead CLI / stdin race). But defer while the CLI is
      // provably working (slow --resume init) — re-check instead of killing it.
      const armStart = (): ReturnType<typeof setTimeout> => setTimeout(() => {
        const t = this.turn;
        if (!t || t.sawActivity) return;
        if (this.busyGuard("no activity after send", t)) { t.startTimer = armStart(); return; }
        this.turn = null;
        this.clearTurnTimers(t);
        void this.requestRelaunch("no activity after send");
        t.resolve("⚠️ il messaggio non è stato preso in carico dal CLI (nessuna attività). Ho ripristinato la sessione — rimandalo.");
      }, FIRST_ACTIVITY_MS);
      const startTimer = armStart();
      const hardTimer = setTimeout(() => {
        const t = this.turn; if (!t) return;
        this.turn = null;
        this.clearTurnTimers(t);
        void this.requestRelaunch("turn timeout");
        resolve(`⚠️ timeout: nessun result entro ${Math.round(TURN_TIMEOUT_MS / 60000)} min. Ho ripristinato la sessione, riprova il messaggio.`);
      }, TURN_TIMEOUT_MS);
      const pid0 = this.cliPid();
      this.turn = { resolve, timers: [ackTimer, hardTimer], relaunched: false, sawActivity: false, stallTimer: undefined, startTimer, cpu: pid0 ? cpuTicks(pid0) : null };
    });
    audit({ dir: "out", session: this.sessionId, chars: answer.length });
    await sendText(groupId, topicId, FABLE_PREFIX + answer);
    if (this.queue.length) { const next = this.queue.shift()!; void this.runTurn(next); }
  }

  /**
   * Ask companion to relaunch this session's CLI (POST /api/sessions/:id/relaunch),
   * exactly what the web UI does on send to a dead session. Kills a wedged/dead
   * CLI and respawns it with --resume so the next message hits a live process.
   * Localhost → server auth-bypasses, but we send the bearer token anyway.
   */
  /** This session's live CLI pid from companion's launcher state, or null. */
  private cliPid(): number | null {
    try {
      const arr = JSON.parse(readFileSync(LAUNCHER_FILE, "utf-8")) as Array<{ sessionId?: string; pid?: number }>;
      const e = Array.isArray(arr) ? arr.find((x) => x.sessionId === this.sessionId) : null;
      return e && typeof e.pid === "number" ? e.pid : null;
    } catch { return null; }
  }

  /**
   * A stall/no-activity relaunch must NOT fire while the CLI is provably working
   * (an API connection or a running tool): that is exactly what was killing CLIs
   * mid --resume or mid long tool and corrupting the session. Returns true if the
   * relaunch was suppressed because the CLI is busy (caller should just re-arm).
   */
  private busyGuard(reason: string, t: { cpu: number | null }): boolean {
    const r = cliWorking(this.cliPid(), t.cpu);
    t.cpu = r.ticks;
    if (r.working) {
      console.log(`[relaunch] ${this.sessionId.slice(0, 8)} DEFERRED (${reason}) — CLI is working (tool child or CPU active)`);
      return true;
    }
    return false;
  }

  private async requestRelaunch(reason: string): Promise<void> {
    const since = Date.now() - this.lastRelaunchAt;
    if (since < RELAUNCH_COOLDOWN_MS) {
      console.log(`[relaunch] ${this.sessionId.slice(0, 8)} SKIPPED (${reason}) — ${Math.round(since / 1000)}s since last relaunch`);
      return;
    }
    this.lastRelaunchAt = Date.now();
    try {
      const res = await fetch(
        `http://127.0.0.1:${COMPANION_PORT}/api/sessions/${this.sessionId}/relaunch`,
        { method: "POST", headers: { authorization: `Bearer ${COMPANION_AUTH}` } },
      );
      console.log(`[relaunch] ${this.sessionId.slice(0, 8)} (${reason}) → ${res.status}`);
    } catch (e) {
      console.error(`[relaunch] ${this.sessionId.slice(0, 8)} failed:`, (e as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    this.buffer = []; this.queue = [];
    try { this.ws?.send(JSON.stringify({ type: "interrupt", client_msg_id: `tg-stop-${Date.now()}` })); } catch { /* noop */ }
  }
  resume(): void { this.stopped = false; }
  statusLine(): string {
    return `sessione ${this.sessionId.slice(0, 8)} | ws:${this.connected ? "connesso" : "giù"} | turno:${this.turn ? "in corso" : "idle"} | coda:${this.queue.length} | ${this.stopped ? "STOPPATO" : this.binding.enabled ? "attivo" : "disabilitato"}`;
  }
  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.turn) this.clearTurnTimers(this.turn);
    try { this.ws?.close(); } catch { /* noop */ }
  }
}

// ── Registry: reconcile bindings → live bridges ──────────────────────────────
const bridges = new Map<string, SessionBridge>(); // sessionId → bridge
const routeIndex = new Map<string, string>();      // `${chatId}:${topicId ?? ""}` → sessionId

function routeKey(chatId: number, topicId: number | null): string {
  return `${chatId}:${topicId ?? ""}`;
}

function reconcile(): void {
  const bindings = loadBindings();
  const wanted = new Set(Object.keys(bindings));
  // Remove bridges whose binding is gone.
  for (const [sessionId, br] of bridges) {
    if (!wanted.has(sessionId)) { br.dispose(); bridges.delete(sessionId); }
  }
  // Add/update.
  for (const [sessionId, binding] of Object.entries(bindings)) {
    const existing = bridges.get(sessionId);
    if (existing) existing.update(binding);
    else bridges.set(sessionId, new SessionBridge(sessionId, binding));
  }
  // Rebuild route index.
  routeIndex.clear();
  for (const [sessionId, binding] of Object.entries(bindings)) {
    routeIndex.set(routeKey(binding.groupId, binding.topicId), sessionId);
  }
  console.log(`[reconcile] ${bridges.size} binding attive: ${[...routeIndex.keys()].join(", ") || "(nessuna)"}`);
}

// ── Router: telegram update → bridge ─────────────────────────────────────────
function findBridge(chatId: number, topicId: number | null): SessionBridge | null {
  let sid = routeIndex.get(routeKey(chatId, topicId));
  if (!sid && topicId != null) sid = routeIndex.get(routeKey(chatId, null)); // DM/general fallback
  return sid ? bridges.get(sid) ?? null : null;
}

async function handleUpdate(u: any): Promise<void> {
  const msg = u.message;
  const hasPhoto = Array.isArray(msg?.photo) && msg.photo.length > 0;
  const hasDoc = !!msg?.document;
  if (!msg || (!msg.text && !msg.caption && !hasPhoto && !hasDoc)) return;
  const chatId: number = msg.chat?.id;
  const topicId: number | null = msg.message_thread_id ?? null;
  const br = findBridge(chatId, topicId);
  if (!br) {
    console.log(`[discover] chat.id=${chatId} type=${msg.chat?.type} topic=${topicId ?? "none"} from.id=${msg.from?.id} (@${msg.from?.username}) text=${JSON.stringify((msg.text || msg.caption || "").slice(0, 40))}`);
    return;
  }
  const fromId: number = msg.from?.id;
  if (!br.binding.allowlist.includes(fromId)) {
    console.log(`[unauthorized] session=${br.sessionId.slice(0, 8)} from.id=${fromId} (@${msg.from?.username})`);
    audit({ event: "unauthorized", session: br.sessionId, fromId, username: msg.from?.username });
    return;
  }

  const rawText: string = msg.text || msg.caption || "";
  let text: string = rawText.trim();
  if (br.binding.requireMention && !text.startsWith("/")) {
    const isReplyToBot = msg.reply_to_message?.from?.id === BOT_ID;
    const entities = msg.entities || msg.caption_entities || [];
    const mentions = entities
      .filter((e: any) => e.type === "mention")
      .map((e: any) => rawText.slice(e.offset, e.offset + e.length).toLowerCase());
    const isTagged = !!BOT_USERNAME && mentions.includes(`@${BOT_USERNAME.toLowerCase()}`);
    if (isTagged) {
      // Strip the @mention so the model doesn't see it.
      if (BOT_USERNAME) text = text.replace(new RegExp(`@${BOT_USERNAME}\\b`, "ig"), "").replace(/\s{2,}/g, " ").trim();
    } else if (!isReplyToBot && !br.continuationOpen(fromId)) {
      // Not tagged, not a reply, and no open coalesce window from this user →
      // free chat in the topic. Ignore. (Continuation parts of a split paste
      // DO pass, because the first tagged part opened the window.)
      return;
    }
  }

  // Commands only apply to plain-text messages.
  if (!hasPhoto && !hasDoc) {
    if (text === "/stop") { br.stop(); await sendText(br.binding.groupId, br.binding.topicId, "⏹️ bridge fermato. /resume per riprendere."); return; }
    if (text === "/resume") { br.resume(); await sendText(br.binding.groupId, br.binding.topicId, "▶️ bridge ripreso."); return; }
    if (text === "/status") { await sendText(br.binding.groupId, br.binding.topicId, "ℹ️ " + br.statusLine()); return; }
    if (text.startsWith("/")) return;
    if (!text) return;
    br.ingest(text, fromId, chatId, msg.message_id);
    return;
  }

  // ── Attachment: photo → inline image; document → saved to the session's inbox ──
  try {
    if (hasPhoto) {
      const largest = msg.photo[msg.photo.length - 1];
      const buf = await downloadTelegramFile(largest.file_id);
      if (!buf) { await sendText(br.binding.groupId, br.binding.topicId, `⚠️ immagine troppo grande o non scaricabile (max ${Math.round(MAX_FILE_BYTES / 1e6)}MB).`); return; }
      br.ingest(text || "Guarda questa immagine.", fromId, chatId, msg.message_id, { media_type: "image/jpeg", data: buf.toString("base64") });
    } else {
      const doc = msg.document;
      const buf = await downloadTelegramFile(doc.file_id);
      if (!buf) { await sendText(br.binding.groupId, br.binding.topicId, `⚠️ file troppo grande o non scaricabile (max ${Math.round(MAX_FILE_BYTES / 1e6)}MB).`); return; }
      const mime: string = doc.mime_type || "";
      // Small images sent as documents → inline; everything else → to disk.
      if (IMAGE_MEDIA.has(mime)) {
        br.ingest(text || "Guarda questa immagine.", fromId, chatId, msg.message_id, { media_type: mime, data: buf.toString("base64") });
      } else {
        const name = safeName(doc.file_name, extname(doc.file_name || "") || ".bin");
        const dir = br.inboxDir();
        mkdirSync(dir, { recursive: true });
        const savedPath = join(dir, name);
        writeFileSync(savedPath, buf);
        audit({ event: "file_saved", session: br.sessionId, path: savedPath, bytes: buf.length, mime });
        const note = `📎 File ricevuto via Telegram, salvato in \`${savedPath}\` (nome: ${name}${mime ? `, tipo: ${mime}` : ""}, ${buf.length} byte). Leggilo/analizzalo.`;
        br.ingest(text ? `${text}\n\n${note}` : note, fromId, chatId, msg.message_id);
      }
    }
  } catch (e) {
    await sendText(br.binding.groupId, br.binding.topicId, `⚠️ errore gestione file: ${(e as Error).message}`);
  }
}

// ── Telegram long-poll loop ──────────────────────────────────────────────────
async function pollLoop(): Promise<void> {
  const me = await tg("getMe", {});
  BOT_ID = me.result?.id ?? null;
  BOT_USERNAME = me.result?.username ?? null;
  console.log(`[bot] @${BOT_USERNAME} (id ${BOT_ID}) up.`);
  let offset = 0;
  const allowed = encodeURIComponent('["message"]');
  while (true) {
    try {
      const res = await fetch(`${TG}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${allowed}`);
      const j: any = await res.json();
      if (j.ok && j.result?.length) {
        for (const u of j.result) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { console.error("[handle] error:", (e as Error).message); }
        }
      }
    } catch (e) {
      console.error("[poll] error:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// Guarded so the module can be imported by tests without starting the bot.
if (import.meta.main) {
  if (!BOT_TOKEN) {
    console.error("[bridge] no telegramBotToken in settings — exiting.");
    process.exit(0);
  }
  process.on("SIGHUP", () => { console.log("[bridge] SIGHUP — reloading bindings"); reconcile(); });
  process.on("SIGTERM", () => { for (const br of bridges.values()) br.dispose(); process.exit(0); });
  reconcile();
  void pollLoop();
}
