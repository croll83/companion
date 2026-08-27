import type { Hono } from "hono";
import { getSettings } from "../settings-manager.js";
import { telegramBridgeManager } from "../telegram-bridge-manager.js";
import {
  getBinding,
  setBinding,
  removeBinding,
  getAllBindings,
  normalize,
} from "../session-telegram-bindings.js";

/**
 * Per-session Telegram bridge configuration. A binding maps a companion session
 * to a Telegram group+topic (or DM) with an allowlist of numeric user ids.
 * Mutations poke the bridge child (SIGHUP) so it reloads without a restart.
 */
export function registerTelegramRoutes(api: Hono): void {
  // Global status: is a bot token set, is the bridge child running.
  api.get("/telegram/status", (c) => {
    return c.json({
      tokenConfigured: !!getSettings().telegramBotToken.trim(),
      running: telegramBridgeManager.isRunning(),
      boundSessionIds: Object.keys(getAllBindings()),
    });
  });

  // Best-effort resolve of a @username → numeric id via Telegram getChat.
  // Unreliable for arbitrary users (Bot API limitation) — the reliable path is
  // to have the user send one message and read the id from the bridge log.
  api.post("/telegram/resolve-username", async (c) => {
    const token = getSettings().telegramBotToken.trim();
    if (!token) return c.json({ error: "No bot token configured" }, 400);
    const body = await c.req.json().catch(() => ({} as { username?: string }));
    let username = typeof body.username === "string" ? body.username.trim() : "";
    if (!username) return c.json({ error: "username is required" }, 400);
    if (!username.startsWith("@")) username = "@" + username;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: username }),
      });
      const j = await res.json();
      if (!j.ok || typeof j.result?.id !== "number") {
        return c.json({ error: "Could not resolve — have the user send a message to the bot instead", detail: j.description }, 404);
      }
      return c.json({ id: j.result.id, username: j.result.username ?? null });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  api.get("/sessions/:id/telegram", (c) => {
    const id = c.req.param("id");
    return c.json({ binding: getBinding(id) ?? null });
  });

  api.put("/sessions/:id/telegram", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.groupId !== "number" || !Number.isFinite(body.groupId)) {
      return c.json({ error: "groupId (number) is required" }, 400);
    }
    if (body.topicId !== undefined && body.topicId !== null && typeof body.topicId !== "number") {
      return c.json({ error: "topicId must be a number or null" }, 400);
    }
    if (body.allowlist !== undefined && !Array.isArray(body.allowlist)) {
      return c.json({ error: "allowlist must be an array of numeric user ids" }, 400);
    }
    const binding = normalize(body);
    if (!binding) return c.json({ error: "invalid binding" }, 400);
    if (binding.allowlist.length === 0) {
      return c.json({ error: "allowlist must contain at least one numeric user id" }, 400);
    }
    setBinding(id, binding);
    telegramBridgeManager.reload();
    return c.json({ ok: true, binding });
  });

  api.delete("/sessions/:id/telegram", (c) => {
    const id = c.req.param("id");
    const removed = removeBinding(id);
    telegramBridgeManager.reload();
    return c.json({ ok: true, removed });
  });
}
