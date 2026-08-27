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
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TelegramBinding } from "./session-telegram-bindings.js";

// ── Paths / config ───────────────────────────────────────────────────────────
const COMPANION_HOME = process.env.COMPANION_HOME || join(homedir(), ".companion");
const COMPANION_PORT = process.env.COMPANION_PORT || "3456";
const SETTINGS_FILE = join(COMPANION_HOME, "settings.json");
const AUTH_FILE = join(COMPANION_HOME, "auth.json");
const BINDINGS_FILE = join(COMPANION_HOME, "session-telegram-bindings.json");
const AUDIT_LOG = join(COMPANION_HOME, "telegram-bridge", "audit.jsonl");

const DEBOUNCE_MS = Number(process.env.TG_DEBOUNCE_MS) || 4000;
// Generous cap: a single coalesced turn (e.g. Ema pasting a large Codex output
// that Telegram split into several messages). Guards against runaway input.
const MAX_INPUT_CHARS = Number(process.env.TG_MAX_INPUT_CHARS) || 100000;
const TURN_TIMEOUT_MS = 20 * 60 * 1000;
const TG_CHUNK = 3900;
const FABLE_PREFIX = "🐟 Fable →\n";

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

// ── Per-session bridge over companion WS ─────────────────────────────────────
class SessionBridge {
  sessionId: string;
  binding: TelegramBinding;
  private ws: WebSocket | null = null;
  private connected = false;
  private disposed = false;
  private turn: { resolve: (t: string) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private buffer: string[] = [];
  private bufferFrom: number | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  private stopped = false;

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
    if (m.type === "result" && this.turn) {
      const d = m.data || {};
      let text: string;
      if (d.is_error) text = `⚠️ Errore turno (${d.subtype || "?"}): ${(d.errors || []).join("; ") || d.result || "no detail"}`;
      else if (d.stop_reason === "refusal") text = `⚠️ Fable ha rifiutato (${d.stop_details?.category || "policy"}).`;
      else text = d.result || "(nessun testo nel result)";
      const t = this.turn; this.turn = null;
      clearTimeout(t.timer);
      t.resolve(text);
    }
  }

  /**
   * A coalesce window is currently open for this user — used to accept
   * continuation parts of a message that Telegram split (or rapid follow-ups)
   * without re-requiring the @mention on every part.
   */
  continuationOpen(fromId: number): boolean {
    return this.debounceTimer !== null && this.bufferFrom === fromId;
  }

  ingest(text: string, fromId: number, chatId: number, messageId: number): void {
    if (this.stopped || !this.binding.enabled) return;
    this.buffer.push(text);
    this.bufferFrom = fromId;
    react(chatId, messageId, "👀").catch(() => {});
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushBuffer(), DEBOUNCE_MS);
  }

  private flushBuffer(): void {
    this.debounceTimer = null;
    this.bufferFrom = null;
    if (this.buffer.length === 0) return;
    const coalesced = this.buffer.join("\n").slice(0, MAX_INPUT_CHARS);
    this.buffer = [];
    if (this.turn) { this.queue.push(coalesced); return; }
    void this.runTurn(coalesced);
  }

  private async runTurn(text: string): Promise<void> {
    if (this.stopped || this.disposed) return;
    const { groupId, topicId } = this.binding;
    audit({ dir: "in", session: this.sessionId, text });
    await typing(groupId, topicId).catch(() => {});
    if (!this.connected) await new Promise((r) => setTimeout(r, 500));
    const client_msg_id = `tg-${Date.now()}-${Math.floor(performance.now())}`;
    try { this.ws?.send(JSON.stringify({ type: "user_message", content: text, client_msg_id })); }
    catch (e) { await sendText(groupId, topicId, `⚠️ invio fallito: ${(e as Error).message}`); return; }

    const answer = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => { this.turn = null; resolve("⚠️ timeout: nessun result entro 20 min."); }, TURN_TIMEOUT_MS);
      this.turn = { resolve, timer };
    });
    audit({ dir: "out", session: this.sessionId, chars: answer.length });
    await sendText(groupId, topicId, FABLE_PREFIX + answer);
    if (this.queue.length) { const next = this.queue.shift()!; void this.runTurn(next); }
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
    if (this.turn) clearTimeout(this.turn.timer);
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
  if (!msg || !msg.text) return;
  const chatId: number = msg.chat?.id;
  const topicId: number | null = msg.message_thread_id ?? null;
  const br = findBridge(chatId, topicId);
  if (!br) {
    console.log(`[discover] chat.id=${chatId} type=${msg.chat?.type} topic=${topicId ?? "none"} from.id=${msg.from?.id} (@${msg.from?.username}) text=${JSON.stringify((msg.text || "").slice(0, 40))}`);
    return;
  }
  const fromId: number = msg.from?.id;
  if (!br.binding.allowlist.includes(fromId)) {
    console.log(`[unauthorized] session=${br.sessionId.slice(0, 8)} from.id=${fromId} (@${msg.from?.username})`);
    audit({ event: "unauthorized", session: br.sessionId, fromId, username: msg.from?.username });
    return;
  }

  let text: string = msg.text.trim();
  if (br.binding.requireMention && !text.startsWith("/")) {
    const isReplyToBot = msg.reply_to_message?.from?.id === BOT_ID;
    const mentions = (msg.entities || [])
      .filter((e: any) => e.type === "mention")
      .map((e: any) => (msg.text as string).slice(e.offset, e.offset + e.length).toLowerCase());
    const isTagged = !!BOT_USERNAME && mentions.includes(`@${BOT_USERNAME.toLowerCase()}`);
    if (isTagged) {
      // Strip the @mention so the model doesn't see it.
      if (BOT_USERNAME) text = text.replace(new RegExp(`@${BOT_USERNAME}\\b`, "ig"), "").replace(/\s{2,}/g, " ").trim();
      if (!text) { await sendText(br.binding.groupId, br.binding.topicId, "🐟 sì? scrivimi cosa serve nel tag."); return; }
    } else if (!isReplyToBot && !br.continuationOpen(fromId)) {
      // Not tagged, not a reply, and no open coalesce window from this user →
      // free chat in the topic. Ignore. (Continuation parts of a split paste
      // DO pass, because the first tagged part opened the window.)
      return;
    }
  }

  if (text === "/stop") { br.stop(); await sendText(br.binding.groupId, br.binding.topicId, "⏹️ bridge fermato. /resume per riprendere."); return; }
  if (text === "/resume") { br.resume(); await sendText(br.binding.groupId, br.binding.topicId, "▶️ bridge ripreso."); return; }
  if (text === "/status") { await sendText(br.binding.groupId, br.binding.topicId, "ℹ️ " + br.statusLine()); return; }
  if (text.startsWith("/")) return;

  br.ingest(text, fromId, chatId, msg.message_id);
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
if (!BOT_TOKEN) {
  console.error("[bridge] no telegramBotToken in settings — exiting.");
  process.exit(0);
}
process.on("SIGHUP", () => { console.log("[bridge] SIGHUP — reloading bindings"); reconcile(); });
process.on("SIGTERM", () => { for (const br of bridges.values()) br.dispose(); process.exit(0); });
reconcile();
void pollLoop();
