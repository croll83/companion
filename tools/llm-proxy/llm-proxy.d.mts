// Types of llm-proxy.mjs, for Companion's tests (web/server/llm-proxy.test.ts).
import type { IncomingMessage, Server, ServerResponse } from "node:http";

export const VERSION: string;
export const DEFAULT_DROP_FIELDS: string[];
export const CLAUDE_EFFORTS: string[];

export interface ProxyLevel {
  name: string;
  claude: string;
  params?: Record<string, unknown>;
}
export const QWEN_LEVELS: ProxyLevel[];
export const SEARCH_BACKENDS: string[];
export const SEARCH_ERROR_CODES: string[];
export const MAX_QUERY_LENGTH: number;

export interface SearchConfig {
  backend: "tavily" | "brave";
  apiKey: string;
  url: string;
  maxResults: number;
  timeoutMs: number;
}

export interface ProxyConfig {
  search: SearchConfig | null;
  listen: { host: string; port: number };
  upstream: { url: string; token: string };
  token: string;
  model: string | null;
  contextWindow: number | null;
  effort: { default: string | null; levels: ProxyLevel[] };
  dropFields: string[];
  keepThinking: boolean;
  log: boolean;
}

export function normalizeConfig(raw: unknown): ProxyConfig;
export function normalizeSearch(raw: unknown): SearchConfig | null;
export function loadConfig(path: string): ProxyConfig;
export function levelFor(config: ProxyConfig, body: Record<string, unknown>): ProxyLevel | null;
export interface ProxyMessage { role: string; content?: unknown }
export function foldSystemMessages(messages: ProxyMessage[]): ProxyMessage[];
export function normalizeRequestBody(
  config: ProxyConfig,
  body: Record<string, unknown>,
  model: string,
  inject: boolean,
): { body: Record<string, unknown>; level: ProxyLevel | null };
export function estimateInputTokens(body: Record<string, unknown>): number;
export function rewordContextError(text: string, contextWindow: number | null): string | null;
export function classifyCredential(value: string, token: string): string;

export interface SearchResult { url: string; title: string; snippet: string; pageAge: string | null }
export type SearchOutcome =
  | { ok: true; query: string; results: SearchResult[] }
  | { ok: false; query: string; code: string; reason: string };
export function webSearchToolOf(body: Record<string, unknown>): Record<string, unknown> | null;
export function webSearchQuery(body: Record<string, unknown>): { query: string; explicit: boolean };
export function domainMatches(url: string, entry: string): boolean;
export function filterByDomains<T extends { url: string }>(results: T[], allowed?: string[], blocked?: string[]): T[];
export function runWebSearch(
  search: SearchConfig | null,
  tool: Record<string, unknown>,
  body: Record<string, unknown>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<SearchOutcome>;
export function webSearchResultBlock(toolUseId: string, outcome: SearchOutcome): Record<string, unknown>;
export function webSearchContext(outcome: Extract<SearchOutcome, { ok: true }>): string;
export function webSearchModelBody(config: ProxyConfig, body: Record<string, unknown>, outcome: Extract<SearchOutcome, { ok: true }>): Record<string, unknown>;
export function newServerToolUseId(): string;

export interface ProxyDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  logger?: (line: string, warn?: boolean) => void;
}
export function createProxy(config: ProxyConfig, deps?: ProxyDeps): (req: IncomingMessage, res: ServerResponse) => void;
export function startProxy(config: ProxyConfig, deps?: ProxyDeps): Promise<Server>;
