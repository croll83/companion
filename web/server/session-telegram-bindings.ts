import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { COMPANION_HOME } from "./paths.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A Telegram bridge binding for a companion session. Persisted keyed by the
 * companion sessionId (stable) — NOT the CLI session id (which rotates). The
 * bridge child process reads these to route Telegram traffic to/from the
 * session's WebSocket.
 */
export interface TelegramBinding {
  /** Telegram chat id of the group/supergroup (negative for supergroups). */
  groupId: number;
  /** Forum topic id (message_thread_id), or null for a DM / the "General" topic. */
  topicId: number | null;
  /** Telegram numeric user ids allowed to drive this session. */
  allowlist: number[];
  /** When true (group binding) only respond if @-mentioned or replied-to. */
  requireMention: boolean;
  /** Master on/off without deleting the binding. */
  enabled: boolean;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(COMPANION_HOME, "session-telegram-bindings.json");

// ─── Store ───────────────────────────────────────────────────────────────────

let bindings: Record<string, TelegramBinding> = {};
let loaded = false;
let filePath = DEFAULT_PATH;

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      bindings = {};
      for (const [sessionId, value] of Object.entries(parsed)) {
        const norm = normalize(value);
        if (norm) bindings[sessionId] = norm;
      }
    }
  } catch {
    bindings = {};
  }
  loaded = true;
}

/** Coerce untrusted JSON into a valid TelegramBinding, or null if unusable. */
export function normalize(raw: unknown): TelegramBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.groupId !== "number" || !Number.isFinite(r.groupId)) return null;
  const topicId =
    typeof r.topicId === "number" && Number.isFinite(r.topicId) ? r.topicId : null;
  const allowlist = Array.isArray(r.allowlist)
    ? Array.from(
        new Set(
          r.allowlist.filter((x): x is number => typeof x === "number" && Number.isFinite(x)),
        ),
      )
    : [];
  return {
    groupId: r.groupId,
    topicId,
    allowlist,
    requireMention: typeof r.requireMention === "boolean" ? r.requireMention : topicId !== null,
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
  };
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(bindings, null, 2), "utf-8");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getBinding(sessionId: string): TelegramBinding | undefined {
  ensureLoaded();
  return bindings[sessionId];
}

export function setBinding(sessionId: string, binding: TelegramBinding): void {
  ensureLoaded();
  bindings[sessionId] = binding;
  persist();
}

export function removeBinding(sessionId: string): boolean {
  ensureLoaded();
  if (!(sessionId in bindings)) return false;
  delete bindings[sessionId];
  persist();
  return true;
}

export function getAllBindings(): Record<string, TelegramBinding> {
  ensureLoaded();
  return { ...bindings };
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  bindings = {};
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
}
