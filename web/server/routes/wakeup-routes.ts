import type { Hono } from "hono";
import type { WakeupScheduler } from "../wakeup-scheduler.js";

/**
 * Scheduled messages into a session ("wake-ups"):
 *   GET    /sessions/:id/wakeups              list (pending and recently spent)
 *   POST   /sessions/:id/wakeups              create {message, at | cron, createdBy?}
 *   DELETE /sessions/:id/wakeups/:wakeupId    cancel
 */
export function registerWakeupRoutes(api: Hono, wakeups: WakeupScheduler): void {
  api.get("/sessions/:id/wakeups", (c) => {
    return c.json({ wakeups: wakeups.listForSession(c.req.param("id")) });
  });

  api.post("/sessions/:id/wakeups", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = wakeups.create({
      sessionId: c.req.param("id"),
      message: body.message,
      at: body.at,
      cron: body.cron,
      createdBy: body.createdBy,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ wakeup: result.wakeup }, 201);
  });

  api.delete("/sessions/:id/wakeups/:wakeupId", (c) => {
    const cancelled = wakeups.cancel(c.req.param("id"), c.req.param("wakeupId"));
    if (!cancelled) return c.json({ error: "Wake-up not found" }, 404);
    return c.json({ ok: true });
  });
}
