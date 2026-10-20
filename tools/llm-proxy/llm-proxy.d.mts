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

export interface ProxyConfig {
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
export function loadConfig(path: string): ProxyConfig;
export function levelFor(config: ProxyConfig, body: Record<string, unknown>): ProxyLevel | null;
export function normalizeRequestBody(
  config: ProxyConfig,
  body: Record<string, unknown>,
  model: string,
  inject: boolean,
): { body: Record<string, unknown>; level: ProxyLevel | null };
export function estimateInputTokens(body: Record<string, unknown>): number;
export function rewordContextError(text: string, contextWindow: number | null): string | null;
export function classifyCredential(value: string, token: string): string;

export interface ProxyDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  logger?: (line: string, warn?: boolean) => void;
}
export function createProxy(config: ProxyConfig, deps?: ProxyDeps): (req: IncomingMessage, res: ServerResponse) => void;
export function startProxy(config: ProxyConfig, deps?: ProxyDeps): Promise<Server>;
