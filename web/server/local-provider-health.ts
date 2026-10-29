import { applyProxyInfo, isLocalLlmEnabled, listLocalProviders, readLocalProviderToken, type LocalProviderConfig, type ProxyInfo } from "./local-providers.js";

/**
 * Health of the local providers (the Companion LLM proxy next to vLLM):
 * every 30 s, while "Enable local LLM" is on, each provider is asked
 * `GET /health` (the proxy answers 503 when vLLM behind it is down; a plain
 * Anthropic-compatible server may have none), falling back to
 * `GET /v1/models`. The result is a badge (online / offline) in Settings and
 * in the session picker, which warns before starting a session on a
 * provider that does not answer. A check never blocks anything.
 *
 * `fetchProxyInfo` reads the proxy's `GET /info` (models, context window,
 * levels, web search) for the form's "Test" and "Refresh" buttons, or `/v1/models`
 * (with vLLM's max_model_len) from a server that is not the proxy.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LocalProviderHealth {
  status: "online" | "offline" | "unknown";
  checkedAt?: number;
  latencyMs?: number;
  /** Why the last check failed. */
  error?: string;
}

export const HEALTH_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function describe(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `no answer within ${CHECK_TIMEOUT_MS / 1000} s`;
  return e?.cause?.code ?? e?.message ?? String(err);
}

/** Model ids out of a `/v1/models` answer (OpenAI `{data: [{id}]}` or Anthropic `{data: [{id}]}`). */
export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export type ModelsResult = { ok: true; models: string[]; latencyMs: number; contextWindow?: number } | { ok: false; error: string };
export type InfoResult = ({ ok: true; latencyMs: number; viaProxy: boolean } & ProxyInfo) | { ok: false; error: string };

/** `GET <baseUrl>/v1/models` with the provider's token. */
export async function fetchModels(baseUrl: string, token: string | null, fetchImpl: FetchLike = fetch): Promise<ModelsResult> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/v1/models`, {
      headers: { Accept: "application/json", ...authHeaders(token) },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `The server refused the token (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, error: `GET /v1/models answered HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const models = parseModelList(body);
    const data = (body as { data?: { max_model_len?: unknown }[] } | null)?.data;
    const len = Array.isArray(data) ? data.find((m) => typeof m?.max_model_len === "number")?.max_model_len : undefined;
    return { ok: true, models, latencyMs: Date.now() - started, ...(typeof len === "number" ? { contextWindow: len } : {}) };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/** The proxy's GET /info, or what /v1/models tells when the server is not the proxy. */
export async function fetchProxyInfo(baseUrl: string, token: string | null, fetchImpl: FetchLike = fetch): Promise<InfoResult> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/info`, {
      headers: { Accept: "application/json", ...authHeaders(token) },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `The proxy refused the token (HTTP ${res.status})` };
    if (res.ok) {
      const info = (await res.json().catch(() => null)) as Partial<ProxyInfo> | null;
      if (info && Array.isArray(info.models)) {
        return {
          ok: true,
          viaProxy: true,
          latencyMs: Date.now() - started,
          models: info.models.filter((m): m is string => typeof m === "string"),
          contextWindow: typeof info.contextWindow === "number" ? info.contextWindow : null,
          ...(info.effort && Array.isArray(info.effort.levels) ? { effort: info.effort } : {}),
          webSearch: info.webSearch === true,
          searchBackend: typeof info.searchBackend === "string" ? info.searchBackend : null,
        };
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
  const models = await fetchModels(baseUrl, token, fetchImpl);
  if (!models.ok) return models;
  return { ok: true, viaProxy: false, latencyMs: models.latencyMs, models: models.models, contextWindow: models.contextWindow ?? null };
}

/** One health probe: /health, then /v1/models when /health is not served. */
export async function probeProvider(baseUrl: string, token: string | null, fetchImpl: FetchLike = fetch): Promise<LocalProviderHealth> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/health`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { status: "online", checkedAt: Date.now(), latencyMs: Date.now() - started };
    if (res.status !== 404 && res.status !== 405) {
      return { status: "offline", checkedAt: Date.now(), error: `GET /health answered HTTP ${res.status}` };
    }
  } catch (err) {
    return { status: "offline", checkedAt: Date.now(), error: describe(err) };
  }
  const models = await fetchModels(baseUrl, token, fetchImpl);
  return models.ok
    ? { status: "online", checkedAt: Date.now(), latencyMs: Date.now() - started }
    : { status: "offline", checkedAt: Date.now(), error: models.error };
}

export class LocalProviderHealthMonitor {
  private health = new Map<string, LocalProviderHealth>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<string>();

  constructor(
    private readonly deps: {
      fetch?: FetchLike;
      list?: () => LocalProviderConfig[];
      token?: (id: string) => string | null;
      /** Polling runs only while "Enable local LLM" is on. */
      enabled?: () => boolean;
    } = {},
  ) {}

  get(id: string): LocalProviderHealth {
    return this.health.get(id) ?? { status: "unknown" };
  }

  /** Check one provider now (Settings' "Test", a new or edited provider). */
  async check(provider: Pick<LocalProviderConfig, "id" | "baseUrl">): Promise<LocalProviderHealth> {
    if (this.inFlight.has(provider.id)) return this.get(provider.id);
    this.inFlight.add(provider.id);
    try {
      const token = (this.deps.token ?? readLocalProviderToken)(provider.id);
      const result = await probeProvider(provider.baseUrl, token, this.deps.fetch);
      const before = this.health.get(provider.id)?.status;
      if (before && before !== "unknown" && before !== result.status) {
        console.log(`[local-providers] ${provider.id} is now ${result.status}${result.error ? ` (${result.error})` : ""}`);
      }
      this.health.set(provider.id, result);
      return result;
    } finally {
      this.inFlight.delete(provider.id);
    }
  }

  async checkAll(): Promise<void> {
    if (!(this.deps.enabled ?? isLocalLlmEnabled)()) return;
    const providers = (this.deps.list ?? listLocalProviders)();
    const ids = new Set(providers.map((p) => p.id));
    for (const id of this.health.keys()) if (!ids.has(id)) this.health.delete(id);
    await Promise.all(providers.map((p) => this.check(p)));
  }

  forget(id: string): void {
    this.health.delete(id);
  }

  start(intervalMs = HEALTH_INTERVAL_MS): void {
    if (this.timer) return;
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const localProviderHealth = new LocalProviderHealthMonitor();

/** Read models, context window and levels from the proxy and store them (a hand-typed model list is kept). */
export async function refreshProviderInfo(provider: LocalProviderConfig, fetchImpl?: FetchLike): Promise<InfoResult & { provider?: LocalProviderConfig }> {
  const result = await fetchProxyInfo(provider.baseUrl, readLocalProviderToken(provider.id), fetchImpl);
  if (!result.ok) return result;
  return { ...result, provider: applyProxyInfo(provider.id, result) ?? provider };
}
