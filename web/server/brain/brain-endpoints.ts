import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "../constants.js";

/**
 * Where embedded brains are reachable, shared by the store (brainUrls), the
 * runtime (session MCP URLs) and the supervisor (which learns the ports):
 *
 *  - sessions use Companion's own port: `http://127.0.0.1:<port>/brains/<slug>/mcp`
 *    (the proxy, brain-proxy.ts), so the child's ephemeral port never leaks
 *    into a session and a restart of the child is invisible to it;
 *  - Companion's server talks to the child directly on its ephemeral port
 *    (health, skill, curator API), which only the supervisor knows.
 *
 * No port is ever persisted.
 */

let companionPort = Number(process.env.PORT) || (process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV);
const childPorts = new Map<string, number>();

/** Set once at startup (server/index.ts) with the port Companion listens on. */
export function setCompanionPort(port: number): void {
  companionPort = port;
}

export function getCompanionPort(): number {
  return companionPort;
}

/** The MCP URL sessions use for an embedded brain: the proxy on Companion's port. */
export function embeddedProxyUrl(slug: string): string {
  return `http://127.0.0.1:${companionPort}/brains/${slug}/mcp`;
}

/** Record (or clear, with null) the port a brain's child listens on. */
export function setChildPort(slug: string, port: number | null): void {
  if (port === null) childPorts.delete(slug);
  else childPorts.set(slug, port);
}

/** The child's base URL, or null while it is not running. */
export function childBaseUrl(slug: string): string | null {
  const port = childPorts.get(slug);
  return port ? `http://127.0.0.1:${port}` : null;
}
