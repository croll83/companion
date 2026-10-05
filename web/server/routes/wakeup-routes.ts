import type { Context, Hono } from "hono";
import type { WakeupScheduler } from "../wakeup-scheduler.js";
import { mcpCallerOf } from "../companion-mcp-auth.js";

/**
 * Scheduled messages into a session ("wake-ups"):
 *   GET    /sessions/:id/wakeups              list (pending and recently spent)
 *   POST   /sessions/:id/wakeups              create {message, at | cron, createdBy?}
 *   DELETE /sessions/:id/wakeups/:wakeupId    cancel
 *
 * Called by a session's `companion` MCP server (MCP token), a request may
 * only concern that session's own wake-ups, and a new wake-up is recorded as
 * created by that session whatever the body says. Otherwise a session (or a
 * prompt injection in it) could read, cancel or push messages into the
 * wake-ups of any other session.
 */
export function registerWakeupRoutes(api: Hono, wakeups: WakeupScheduler): void {
  /** The calling MCP session (null for the user), and a 403 when it targets another session. */
  const callerOf = (c: Context): { caller: string | null; denied?: Response } => {
    const caller = mcpCallerOf(c.req.header("Authorization"));
    if (caller && caller !== c.req.param("id")) {
      return {
        caller,
        denied: c.json({
          error: "Companion MCP tools can only manage this session's own wake-ups. Ask the user to do it from the Companion UI.",
        }, 403),
      };
    }
    return { caller };
  };

  api.get("/sessions/:id/wakeups", (c) => {
    const { denied } = callerOf(c);
    if (denied) return denied;
    return c.json({ wakeups: wakeups.listForSession(c.req.param("id")) });
  });

  api.post("/sessions/:id/wakeups", async (c) => {
    const { caller, denied } = callerOf(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = wakeups.create({
      sessionId: c.req.param("id"),
      message: body.message,
      at: body.at,
      cron: body.cron,
      createdBy: caller ? `session:${caller}` : body.createdBy,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ wakeup: result.wakeup }, 201);
  });

  api.delete("/sessions/:id/wakeups/:wakeupId", (c) => {
    const { denied } = callerOf(c);
    if (denied) return denied;
    const cancelled = wakeups.cancel(c.req.param("id"), c.req.param("wakeupId"));
    if (!cancelled) return c.json({ error: "Wake-up not found" }, 404);
    return c.json({ ok: true });
  });
}
