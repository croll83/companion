import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { ensurePrivateDir, writePrivateFile } from "./private-file.js";
import { isValidSlug, slugify } from "./domain-store.js";
import { getSettings } from "./settings-manager.js";

/**
 * Whether Settings → Providers → "Enable local LLM" is on (off by default).
 * Off: no new local session, agent run or domain default; sessions already
 * on a provider keep running and relaunching.
 */
export function isLocalLlmEnabled(): boolean {
  return getSettings().localLlmEnabled === true;
}

/**
 * Local providers: Claude Code sessions on a local model instead of the
 * Anthropic account. A provider is the Companion LLM proxy
 * (tools/llm-proxy/, docs/local-llm.md) that runs next to vLLM on the model
 * host: Companion only stores its URL and shared token, and points the
 * session's Claude Code at it (local-spawn.ts). The session is still Claude
 * Code (backendType "claude"), so domains, memory, brains, skills, MCP and
 * agents work as usual. Off unless Settings → Providers → "Enable local LLM".
 *
 * The reasoning level travels as Claude Code's own effort
 * (`output_config.effort`, changed at runtime by the effort switcher like on
 * any Claude session); the proxy maps each value to the model's parameters.
 * So a provider's `effortLevels` are Claude Code effort values, and
 * `effortLabels` the names of the model levels they carry (read from the
 * proxy's GET /info), shown in the UI.
 *
 * On disk, under COMPANION_HOME:
 *  - local-providers.json: the profiles (never a token);
 *  - local-providers/<id>.secret: 0600, the proxy's shared token, never
 *    returned by the API (only `hasToken`).
 */

/** Claude Code's effort values: what can travel in output_config.effort (checked on CLI 2.1.303). */
export const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];

export interface LocalProviderConfig {
  /** Slug, derived from the name at creation; never changes. */
  id: string;
  name: string;
  /** The proxy's URL, without a trailing slash or `/v1` (Claude Code appends /v1/messages). */
  baseUrl: string;
  /** Model ids sessions can pick, from the proxy (GET /info or /v1/models) or typed by hand. */
  models: string[];
  /** `models` was typed by hand: "Refresh" never replaces it. */
  modelsManual?: boolean;
  /** Preselected model in the session picker (else the first one). */
  defaultModel?: string;
  /** Context window of the models in tokens: sets Claude Code's window and autocompact. */
  contextWindow: number;
  /** Claude Code effort values the proxy maps to model levels ([] = no effort selector). */
  effortLevels: string[];
  /** Name of the model level each value carries (e.g. low → "off"), shown in the UI. */
  effortLabels?: Record<string, string>;
  defaultEffort?: string;
  /**
   * The proxy's web search backend (e.g. "tavily"), when its GET /info says
   * `webSearch: true`: sessions then keep Claude Code's WebSearch, which the
   * proxy answers. Absent = off (WebSearch disallowed). Read from the proxy
   * only (create, "Refresh"), never typed.
   */
  webSearchBackend?: string;
  createdAt: number;
  updatedAt: number;
}

/** What the proxy maps by default (tools/llm-proxy QWEN_LEVELS): off, low, medium, xhigh. */
export const DEFAULT_LOCAL_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
export const DEFAULT_LOCAL_EFFORT_LABELS: Record<string, string> = { low: "off", medium: "low", high: "medium", xhigh: "xhigh" };
export const DEFAULT_LOCAL_EFFORT = "high";
export const DEFAULT_CONTEXT_WINDOW = 131_072;
/**
 * Smallest window accepted: Claude Code's system prompt and tools take about
 * 20k tokens, and it compacts 13k + max output below the window.
 */
export const MIN_CONTEXT_WINDOW = 32_768;
const MAX_CONTEXT_WINDOW = 10_000_000;
const LABEL_RE = /^[A-Za-z0-9 _.-]{1,24}$/;
const MODEL_RE = /^[^\s"'`\\]{1,200}$/;

export interface LocalProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  /** A string sets the token; "" or null removes it; absent keeps it. */
  token?: unknown;
  models?: unknown;
  modelsManual?: unknown;
  defaultModel?: unknown;
  contextWindow?: unknown;
  effortLevels?: unknown;
  effortLabels?: unknown;
  defaultEffort?: unknown;
}

export type LocalProviderResult =
  | { ok: true; provider: LocalProviderConfig }
  | { ok: false; status: number; error: string };

function registryPath(): string {
  return join(COMPANION_HOME, "local-providers.json");
}

/** Folder of the provider tokens and of the proxy key (0700). */
export function localProvidersDir(): string {
  return join(COMPANION_HOME, "local-providers");
}

function tokenPath(id: string): string {
  return join(localProvidersDir(), `${id}.secret`);
}

/**
 * `http(s)://host[:port][/path]` without a trailing slash nor a trailing `/v1`
 * (users paste either form; the proxy always appends `/v1/...`). Null when invalid.
 */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  try {
    const u = new URL(trimmed);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.search || u.hash || u.username || u.password) return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "").replace(/\/+$/, "");
}

function normalizeLabels(raw: unknown, levels: string[]): Record<string, string> | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!levels.includes(k)) continue;
    if (typeof v !== "string" || !LABEL_RE.test(v.trim())) return null;
    out[k] = v.trim();
  }
  return out;
}

/** A list of Claude Code effort values, deduplicated, in the CLI's order; null when invalid. */
function effortList(raw: unknown): string[] | null {
  const list = stringList(raw, /^[a-z]+$/);
  if (!list || list.some((l) => !CLAUDE_EFFORT_VALUES.includes(l))) return null;
  return CLAUDE_EFFORT_VALUES.filter((l) => list.includes(l));
}

function stringList(raw: unknown, re: RegExp): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const v = item.trim();
    if (!v) continue;
    if (!re.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** A provider read from disk, or null when the entry is unusable (it is then skipped). */
function normalizeStored(raw: unknown): LocalProviderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(r.baseUrl);
  if (!isValidSlug(r.id) || typeof r.name !== "string" || !baseUrl) return null;
  const window = Number(r.contextWindow);
  const levels = effortList(r.effortLevels) ?? [...DEFAULT_LOCAL_EFFORT_LEVELS];
  const labels = normalizeLabels(r.effortLabels, levels) ?? {};
  return {
    id: r.id,
    name: r.name,
    baseUrl,
    models: stringList(r.models, MODEL_RE) ?? [],
    ...(r.modelsManual === true ? { modelsManual: true } : {}),
    ...(typeof r.defaultModel === "string" && r.defaultModel ? { defaultModel: r.defaultModel } : {}),
    contextWindow: Number.isInteger(window) && window >= MIN_CONTEXT_WINDOW ? window : DEFAULT_CONTEXT_WINDOW,
    effortLevels: levels,
    ...(Object.keys(labels).length > 0 ? { effortLabels: labels } : {}),
    ...(typeof r.defaultEffort === "string" && levels.includes(r.defaultEffort) ? { defaultEffort: r.defaultEffort } : {}),
    ...(typeof r.webSearchBackend === "string" && LABEL_RE.test(r.webSearchBackend) ? { webSearchBackend: r.webSearchBackend } : {}),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  };
}

function readRegistry(): LocalProviderConfig[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf-8")) as { providers?: unknown };
    if (!Array.isArray(raw.providers)) return [];
    return raw.providers.map(normalizeStored).filter((p): p is LocalProviderConfig => !!p);
  } catch {
    return [];
  }
}

function writeRegistry(providers: LocalProviderConfig[]): void {
  ensurePrivateDir(COMPANION_HOME);
  writePrivateFile(registryPath(), `${JSON.stringify({ version: 1, providers }, null, 2)}\n`);
}

/** All providers, by name. */
export function listLocalProviders(): LocalProviderConfig[] {
  return readRegistry().sort((a, b) => a.name.localeCompare(b.name));
}

export function getLocalProvider(id: string | undefined | null): LocalProviderConfig | undefined {
  if (!id) return undefined;
  return readRegistry().find((p) => p.id === id);
}

/** The provider's bearer token, or null (none set). Server-side only: never put it in a response. */
export function readLocalProviderToken(id: string): string | null {
  try {
    const token = readFileSync(tokenPath(id), "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

export function hasLocalProviderToken(id: string): boolean {
  return readLocalProviderToken(id) !== null;
}

function applyToken(id: string, token: unknown): string | null {
  if (token === undefined) return null;
  if (token === null || token === "") {
    rmSync(tokenPath(id), { force: true });
    return null;
  }
  if (typeof token !== "string" || /\s/.test(token.trim()) || token.trim().length > 4096) return "Invalid token";
  ensurePrivateDir(localProvidersDir());
  writePrivateFile(tokenPath(id), `${token.trim()}\n`);
  return null;
}

/**
 * Validate the editable fields over `base` (an existing provider, or the
 * defaults of a new one). Returns the merged provider or an error.
 */
function applyInput(base: LocalProviderConfig, input: LocalProviderInput): LocalProviderConfig | string {
  const next: LocalProviderConfig = { ...base };
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80) return "Invalid name";
    next.name = input.name.trim();
  }
  if (input.baseUrl !== undefined) {
    const url = normalizeBaseUrl(input.baseUrl);
    if (!url) return "Invalid base URL: use http(s)://host:port (with or without /v1)";
    next.baseUrl = url;
  }
  if (input.models !== undefined) {
    const models = stringList(input.models, MODEL_RE);
    if (!models) return "models must be a list of model ids";
    next.models = models;
  }
  if (input.modelsManual !== undefined) {
    if (input.modelsManual === true) next.modelsManual = true;
    else delete next.modelsManual;
  }
  if (input.contextWindow !== undefined) {
    const n = Number(input.contextWindow);
    if (!Number.isInteger(n) || n < MIN_CONTEXT_WINDOW || n > MAX_CONTEXT_WINDOW) {
      return `contextWindow must be a whole number of tokens between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`;
    }
    next.contextWindow = n;
  }
  if (input.effortLevels !== undefined) {
    const levels = effortList(input.effortLevels);
    if (!levels) return `effortLevels must be Claude Code effort values (${CLAUDE_EFFORT_VALUES.join(", ")}): the proxy maps each one to a model level`;
    next.effortLevels = levels;
  }
  if (input.effortLabels !== undefined) {
    const labels = normalizeLabels(input.effortLabels, next.effortLevels);
    if (!labels) return "effortLabels must map effort values to short names";
    if (Object.keys(labels).length > 0) next.effortLabels = labels;
    else delete next.effortLabels;
  }
  if (input.defaultModel !== undefined) {
    if (input.defaultModel === null || input.defaultModel === "") delete next.defaultModel;
    else if (typeof input.defaultModel !== "string" || !MODEL_RE.test(input.defaultModel)) return "Invalid default model";
    else next.defaultModel = input.defaultModel;
  }
  if (input.defaultEffort !== undefined) {
    if (input.defaultEffort === null || input.defaultEffort === "") delete next.defaultEffort;
    else if (typeof input.defaultEffort !== "string") return "Invalid default effort";
    else next.defaultEffort = input.defaultEffort;
  }
  // Settle what depends on several fields.
  if (next.defaultModel && !next.models.includes(next.defaultModel)) delete next.defaultModel;
  if (next.defaultEffort && !next.effortLevels.includes(next.defaultEffort)) {
    return `The default effort "${next.defaultEffort}" is not one of the levels (${next.effortLevels.join(", ") || "none"})`;
  }
  if (next.effortLabels) {
    const kept = Object.entries(next.effortLabels).filter(([k]) => next.effortLevels.includes(k));
    if (kept.length > 0) next.effortLabels = Object.fromEntries(kept);
    else delete next.effortLabels;
  }
  return next;
}

export function createLocalProvider(input: LocalProviderInput): LocalProviderResult {
  if (typeof input.name !== "string" || !input.name.trim()) return { ok: false, status: 400, error: "A name is required" };
  if (input.baseUrl === undefined) return { ok: false, status: 400, error: "A base URL is required" };
  const providers = readRegistry();
  const root = slugify(input.name) || "local";
  let id = root;
  for (let i = 2; providers.some((p) => p.id === id); i++) id = `${root}-${i}`;
  const now = Date.now();
  const base: LocalProviderConfig = {
    id,
    name: "",
    baseUrl: "",
    models: [],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    effortLevels: [...DEFAULT_LOCAL_EFFORT_LEVELS],
    effortLabels: { ...DEFAULT_LOCAL_EFFORT_LABELS },
    defaultEffort: DEFAULT_LOCAL_EFFORT,
    createdAt: now,
    updatedAt: now,
  };
  // A provider created with its own levels but no default gets none, rather
  // than the default levels' "medium" it may not have.
  if (input.effortLevels !== undefined && input.defaultEffort === undefined) delete base.defaultEffort;
  const next = applyInput(base, input);
  if (typeof next === "string") return { ok: false, status: 400, error: next };
  const tokenError = applyToken(id, input.token);
  if (tokenError) return { ok: false, status: 400, error: tokenError };
  writeRegistry([...providers, next]);
  return { ok: true, provider: next };
}

export function updateLocalProvider(id: string, input: LocalProviderInput): LocalProviderResult {
  const providers = readRegistry();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, status: 404, error: "Local provider not found" };
  const next = applyInput(providers[idx], input);
  if (typeof next === "string") return { ok: false, status: 400, error: next };
  const tokenError = applyToken(id, input.token);
  if (tokenError) return { ok: false, status: 400, error: tokenError };
  next.updatedAt = Date.now();
  providers[idx] = next;
  writeRegistry(providers);
  return { ok: true, provider: next };
}

/** What the proxy publishes about itself (GET /info, or derived from /v1/models). */
export interface ProxyInfo {
  models: string[];
  contextWindow?: number | null;
  effort?: { default?: string | null; levels: { name: string; claude: string }[] };
  /** The proxy answers Claude Code's WebSearch (tools/llm-proxy `search` config). Absent = an older proxy or not the proxy: off. */
  webSearch?: boolean;
  searchBackend?: string | null;
}

/**
 * Store what the proxy says: its models (unless the list was typed by
 * hand), its context window, its levels (Claude effort value → model
 * level name) and whether it answers web search. The proxy's config is the
 * source of truth for all of them.
 */
export function applyProxyInfo(id: string, info: ProxyInfo): LocalProviderConfig | undefined {
  const providers = readRegistry();
  const p = providers.find((x) => x.id === id);
  if (!p) return undefined;
  const before = JSON.stringify(p);
  const models = stringList(info.models, MODEL_RE) ?? [];
  if (!p.modelsManual && models.length > 0) {
    p.models = models;
    if (p.defaultModel && !models.includes(p.defaultModel)) delete p.defaultModel;
  }
  const window = Number(info.contextWindow);
  if (Number.isInteger(window) && window >= MIN_CONTEXT_WINDOW && window <= MAX_CONTEXT_WINDOW) p.contextWindow = window;
  const levels = info.effort?.levels?.filter((l) => CLAUDE_EFFORT_VALUES.includes(l.claude) && typeof l.name === "string" && LABEL_RE.test(l.name));
  if (levels && levels.length > 0) {
    p.effortLevels = CLAUDE_EFFORT_VALUES.filter((v) => levels.some((l) => l.claude === v));
    p.effortLabels = Object.fromEntries(levels.map((l) => [l.claude, l.name]));
    const def = info.effort?.default;
    if (def && p.effortLevels.includes(def)) p.defaultEffort = def;
    else if (p.defaultEffort && !p.effortLevels.includes(p.defaultEffort)) delete p.defaultEffort;
  }
  if (info.webSearch === true) {
    p.webSearchBackend = typeof info.searchBackend === "string" && LABEL_RE.test(info.searchBackend) ? info.searchBackend : "on";
  } else {
    delete p.webSearchBackend;
  }
  if (JSON.stringify(p) === before) return p;
  p.updatedAt = Date.now();
  writeRegistry(providers);
  return p;
}

export function deleteLocalProvider(id: string): boolean {
  const providers = readRegistry();
  const next = providers.filter((p) => p.id !== id);
  if (next.length === providers.length) return false;
  writeRegistry(next);
  rmSync(tokenPath(id), { force: true });
  return true;
}

/** The model a session gets when none is chosen: the default, else the first one. */
export function defaultLocalModel(provider: LocalProviderConfig): string | undefined {
  return provider.defaultModel ?? provider.models[0];
}

/** The level a new session starts on: the chosen one when the provider has it, else its default. */
export function settleLocalEffort(provider: LocalProviderConfig, effort: string | undefined | null): string | undefined {
  if (effort && provider.effortLevels.includes(effort)) return effort;
  return provider.defaultEffort ?? undefined;
}

export type LocalChoice =
  | { ok: true; provider: LocalProviderConfig; local: { provider: string; model: string }; effort: string | undefined }
  | { ok: false; error: string };

/**
 * A session's (or an agent run's) provider, model and level, checked against
 * the registry: the model must be one of the provider's, the level one of
 * its levels (else its default).
 */
export function resolveLocalChoice(raw: { provider?: unknown; model?: unknown } | undefined, effort: string | undefined | null): LocalChoice {
  if (!isLocalLlmEnabled()) return { ok: false, error: "Local LLM is off: turn on \"Enable local LLM\" in Settings → Providers" };
  if (!raw || typeof raw.provider !== "string" || !raw.provider) return { ok: false, error: "A local provider is required" };
  const provider = getLocalProvider(raw.provider);
  if (!provider) return { ok: false, error: `Unknown local provider "${raw.provider}": add it in Settings → Local providers` };
  const model = typeof raw.model === "string" && raw.model ? raw.model : defaultLocalModel(provider);
  if (!model) return { ok: false, error: `The local provider "${provider.name}" has no model: add one in Settings → Local providers` };
  if (!provider.models.includes(model)) {
    return { ok: false, error: `"${model}" is not a model of the local provider "${provider.name}" (${provider.models.join(", ")})` };
  }
  return { ok: true, provider, local: { provider: provider.id, model }, effort: settleLocalEffort(provider, effort) };
}
