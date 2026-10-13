import { childBaseUrl } from "./brain-endpoints.js";
import { embeddedKeys } from "./brain-token.js";

/**
 * Companion's server talking to an embedded brain's curator API (the child's
 * /api/v1/*, on its ephemeral port, with the X-Brain-Key derived from the
 * brain's secret). The Pages and Inbox tabs, "Add source" and the guided lint
 * go through here: the browser never holds the key, and Companion's server
 * never reads the wiki through the core (it is a separate process).
 */

export class CuratorError extends Error {
  status: 400 | 404 | 409 | 413 | 502;
  constructor(status: CuratorError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export type CuratorFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface CuratorOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  fetch?: CuratorFetch;
}

function statusOf(status: number): CuratorError["status"] {
  if (status === 400 || status === 404 || status === 409 || status === 413) return status;
  return 502;
}

/**
 * Call `/api/v1<path>` of a running embedded brain and return its JSON.
 * Throws CuratorError: 409 when the brain is not running, the child's own
 * status (400, 404, 409, 413) with its message, 502 otherwise.
 */
export async function curatorFetch<T>(slug: string, path: string, opts: CuratorOptions = {}): Promise<T> {
  const base = childBaseUrl(slug);
  const keys = embeddedKeys(slug);
  if (!base || !keys) throw new CuratorError(409, "The brain is not running: start it first");
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/api/v1${path}`, {
      method: opts.method ?? "GET",
      headers: { "X-Brain-Key": keys.curatorKey, Accept: "application/json", ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new CuratorError(502, `The brain did not answer: ${(err as Error).message}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CuratorError(502, `The brain answered HTTP ${res.status} without JSON`);
  }
  if (!res.ok) {
    const error = (json as { error?: unknown })?.error;
    throw new CuratorError(statusOf(res.status), typeof error === "string" ? error : `HTTP ${res.status}`);
  }
  return json as T;
}
