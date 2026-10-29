import type { Hono } from "hono";
import {
  createLocalProvider,
  deleteLocalProvider,
  getLocalProvider,
  hasLocalProviderToken,
  isLocalLlmEnabled,
  listLocalProviders,
  normalizeBaseUrl,
  readLocalProviderToken,
  updateLocalProvider,
  type LocalProviderConfig,
  type LocalProviderInput,
} from "../local-providers.js";
import {
  fetchProxyInfo,
  localProviderHealth,
  refreshProviderInfo,
  type FetchLike,
  type LocalProviderHealth,
  type LocalProviderHealthMonitor,
} from "../local-provider-health.js";

/**
 * Settings → Providers → Local LLM (/api/local-providers): the Companion LLM
 * proxies sessions can run on (local-providers.ts), their health
 * (local-provider-health.ts), and a local session's numbers as the proxy
 * measured them (GET /sessions/:id/local-metrics, shown instead of the cost).
 * While "Enable local LLM" is off the list is empty, so no page offers a
 * "Local" choice.
 *
 * No response ever carries a provider token: only `hasToken`.
 */

/** Per-session numbers kept by the proxy (tools/llm-proxy GET /metrics?session=). */
export interface LocalSessionMetrics {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalDurationMs: number;
  last?: {
    at: number;
    status: number;
    model: string;
    /** The model level the request ran at (the proxy's name for it). */
    effort?: string;
    inputTokens: number;
    outputTokens: number;
    ttftMs?: number;
    durationMs: number;
    outputTokensPerSec?: number;
  };
  /** Kinds of credentials the CLI sent the proxy (never values): the "no Anthropic token leaves" check. */
  authSeen: string[];
}

/** A provider as the UI shows it. */
export interface LocalProviderView extends LocalProviderConfig {
  hasToken: boolean;
  health: LocalProviderHealth;
}

export interface LocalProviderRouteDeps {
  /** Sessions (not archived, not exited) running on a provider: deleting it would strand them. */
  liveSessionsUsing: (providerId: string) => number;
  /** Local info of a session (launcher record). */
  sessionLocal: (sessionId: string) => { provider: string; model: string; effort?: string } | undefined;
  health?: Pick<LocalProviderHealthMonitor, "get" | "check" | "forget">;
  fetch?: FetchLike;
}

export function localProviderView(p: LocalProviderConfig, health: Pick<LocalProviderHealthMonitor, "get"> = localProviderHealth): LocalProviderView {
  return { ...p, hasToken: hasLocalProviderToken(p.id), health: health.get(p.id) };
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function registerLocalProviderRoutes(api: Hono, deps: LocalProviderRouteDeps): void {
  const health = deps.health ?? localProviderHealth;

  api.get("/local-providers", (c) => c.json(isLocalLlmEnabled() ? listLocalProviders().map((p) => localProviderView(p, health)) : []));

  api.get("/local-providers/:id", (c) => {
    const p = getLocalProvider(c.req.param("id"));
    return p ? c.json(localProviderView(p, health)) : c.json({ error: "Local provider not found" }, 404);
  });

  api.post("/local-providers", async (c) => {
    const body = await readBody(c);
    const created = createLocalProvider(body as LocalProviderInput);
    if (!created.ok) return c.json({ error: created.error }, created.status as 400);
    let provider = created.provider;
    // Read models, context window and levels from the proxy now (best effort, it may be off).
    const refreshed = await refreshProviderInfo(provider, deps.fetch);
    if (refreshed.ok && refreshed.provider) provider = refreshed.provider;
    await health.check(provider);
    return c.json(localProviderView(provider, health), 201);
  });

  api.patch("/local-providers/:id", async (c) => {
    const body = await readBody(c);
    const updated = updateLocalProvider(c.req.param("id"), body as LocalProviderInput);
    if (!updated.ok) return c.json({ error: updated.error }, updated.status as 400);
    if ("baseUrl" in body || "token" in body) await health.check(updated.provider);
    return c.json(localProviderView(updated.provider, health));
  });

  api.delete("/local-providers/:id", (c) => {
    const id = c.req.param("id");
    if (!getLocalProvider(id)) return c.json({ error: "Local provider not found" }, 404);
    const live = deps.liveSessionsUsing(id);
    if (live > 0) {
      return c.json({ error: `${live} running session(s) use this provider: archive them first` }, 409);
    }
    deleteLocalProvider(id);
    health.forget(id);
    return c.json({ ok: true });
  });

  /** Read models, context window and levels from the proxy again (a hand-typed model list is kept). */
  api.post("/local-providers/:id/refresh", async (c) => {
    const p = getLocalProvider(c.req.param("id"));
    if (!p) return c.json({ error: "Local provider not found" }, 404);
    const result = await refreshProviderInfo(p, deps.fetch);
    await health.check(p);
    if (!result.ok) return c.json({ ok: false, error: result.error, provider: localProviderView(p, health) });
    return c.json({ ok: true, viaProxy: result.viaProxy, provider: localProviderView(result.provider ?? p, health) });
  });

  /**
   * "Test" in the form: the proxy's GET /info (else /v1/models) on a URL not
   * saved yet, or a saved provider with `id`, whose stored token is used
   * unless one is typed.
   */
  api.post("/local-providers/test", async (c) => {
    const body = await readBody(c);
    const saved = typeof body.id === "string" ? getLocalProvider(body.id) : undefined;
    const baseUrl = body.baseUrl !== undefined ? normalizeBaseUrl(body.baseUrl) : saved?.baseUrl ?? null;
    if (!baseUrl) return c.json({ ok: false, error: "Invalid base URL: use http(s)://host:port" }, 400);
    const token = typeof body.token === "string" && body.token.trim()
      ? body.token.trim()
      : saved ? readLocalProviderToken(saved.id) : null;
    const result = await fetchProxyInfo(baseUrl, token, deps.fetch);
    if (saved) await health.check(saved);
    return c.json(result);
  });

  /**
   * A local session's numbers (tokens, TTFT, duration, credentials seen),
   * read from its proxy (GET /metrics?session=<id>; the session sends its id
   * in the X-Companion-Session header), and its provider. `metricsError`
   * when the proxy could not be asked.
   */
  api.get("/sessions/:id/local-metrics", async (c) => {
    const id = c.req.param("id");
    const local = deps.sessionLocal(id);
    if (!local) return c.json({ error: "Not a local session" }, 404);
    const p = getLocalProvider(local.provider);
    let metrics: LocalSessionMetrics | null = null;
    let metricsError: string | undefined;
    if (p) {
      try {
        const token = readLocalProviderToken(p.id);
        const res = await (deps.fetch ?? fetch)(`${p.baseUrl}/metrics?session=${encodeURIComponent(id)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) metrics = ((await res.json()) as { metrics?: LocalSessionMetrics | null }).metrics ?? null;
        else metricsError = `the proxy answered HTTP ${res.status}`;
      } catch (err) {
        metricsError = (err as Error).message;
      }
    }
    return c.json({
      provider: p ? { id: p.id, name: p.name, contextWindow: p.contextWindow, health: health.get(p.id) } : { id: local.provider, missing: true },
      model: local.model,
      effort: local.effort ?? null,
      effortLabel: local.effort ? p?.effortLabels?.[local.effort] ?? local.effort : null,
      metrics,
      ...(metricsError ? { metricsError } : {}),
    });
  });
}

/** What the session list carries about a local session (no token, no URL). */
export interface LocalSessionView {
  provider: string;
  model: string;
  providerName: string;
  /** Claude Code effort values the proxy maps; shown with effortLabels. */
  effortLevels: string[];
  effortLabels?: Record<string, string>;
  defaultEffort?: string;
  contextWindow?: number;
  /** The provider was deleted: the session cannot start again. */
  missing?: boolean;
}

export function localSessionView(local: { provider: string; model: string }): LocalSessionView {
  const p = getLocalProvider(local.provider);
  if (!p) return { ...local, providerName: local.provider, effortLevels: [], missing: true };
  return {
    ...local,
    providerName: p.name,
    effortLevels: p.effortLevels,
    ...(p.effortLabels ? { effortLabels: p.effortLabels } : {}),
    ...(p.defaultEffort ? { defaultEffort: p.defaultEffort } : {}),
    contextWindow: p.contextWindow,
  };
}
