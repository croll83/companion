import type { Hono } from "hono";
import type { WakeupScheduler } from "../wakeup-scheduler.js";
import { accessDenied, mcpCallerOf, sessionAccessLevel } from "../companion-mcp-auth.js";

/** What the routes need to know about a session (the launcher's record). */
export type WakeupSessionLookup = (sessionId: string) => { backendType?: string; codexSandbox?: string } | undefined;

/**
 * Scheduled messages into a session ("wake-ups"):
 *   GET    /sessions/:id/wakeups              list (pending and recently spent)
 *   POST   /sessions/:id/wakeups              create {message, at | cron, createdBy?}
 *   DELETE /sessions/:id/wakeups/:wakeupId    cancel
 *
 * Called by a session's `companion` MCP server (MCP token), the wake-up is
 * recorded as created by that session whatever the body says, and a
 * sandboxed session may not touch the wake-ups of a full-access one.
 */
export function registerWakeupRoutes(api: Hono, wakeups: WakeupScheduler, getSession?: WakeupSessionLookup): void {
  /** Why the calling MCP session may not act on this target session, or null. */
  const deniedForCaller = (caller: string | null, target: string): string | null => {
    if (!caller || caller === target || !getSession) return null;
    const callerInfo = getSession(caller);
    const targetInfo = getSession(target);
    if (!callerInfo || !targetInfo) return null; // 404 handled by the scheduler
    return accessDenied(sessionAccessLevel(callerInfo), sessionAccessLevel(targetInfo), "schedule into or cancel wake-ups of a session");
  };

  api.get("/sessions/:id/wakeups", (c) => {
    return c.json({ wakeups: wakeups.listForSession(c.req.param("id")) });
  });

  api.post("/sessions/:id/wakeups", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const sessionId = c.req.param("id");
    const caller = mcpCallerOf(c.req.header("Authorization"));
    const denied = deniedForCaller(caller, sessionId);
    if (denied) return c.json({ error: denied }, 403);
    const result = wakeups.create({
      sessionId,
      message: body.message,
      at: body.at,
      cron: body.cron,
      createdBy: caller ? `session:${caller}` : body.createdBy,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ wakeup: result.wakeup }, 201);
  });

  api.delete("/sessions/:id/wakeups/:wakeupId", (c) => {
    const sessionId = c.req.param("id");
    const denied = deniedForCaller(mcpCallerOf(c.req.header("Authorization")), sessionId);
    if (denied) return c.json({ error: denied }, 403);
    const cancelled = wakeups.cancel(sessionId, c.req.param("wakeupId"));
    if (!cancelled) return c.json({ error: "Wake-up not found" }, 404);
    return c.json({ ok: true });
  });
}
