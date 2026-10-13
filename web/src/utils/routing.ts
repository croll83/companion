import { installClipboardWriteFallback } from "./clipboard.js";

export type Route =
  | { page: "home" }
  | { page: "session"; sessionId: string }
  | { page: "settings" }
  | { page: "integrations" }
  | { page: "integration-linear" }
  | { page: "integration-linear-oauth" }
  | { page: "prompts" }
  | { page: "environments" }
  /** The Domains page; with a slug, that domain; with a tab, its MCP / skills / plugins view. */
  | { page: "domains"; slug?: string; tab?: DomainTab }
  /** The Brains page; with a slug, that brain. */
  | { page: "brains"; slug?: string }
  | { page: "agents" }
  | { page: "agent-detail"; agentId: string }
  | { page: "runs" }
  | { page: "docs"; docPath: string }
  | { page: "playground" };

const SESSION_PREFIX = "#/session/";
const AGENT_PREFIX = "#/agents/";
const DOCS_PREFIX = "#/docs/";
let clipboardFallbackInitialized = false;

function ensureClipboardFallbackInstalled(): void {
  if (clipboardFallbackInitialized) return;
  installClipboardWriteFallback();
  clipboardFallbackInitialized = true;
}

/** The views of one domain on the Domains page. */
export type DomainTab = "mcp" | "skills" | "plugins";

export function isDomainTab(value: unknown): value is DomainTab {
  return value === "mcp" || value === "skills" || value === "plugins";
}

/** Hash of the Domains page, of one domain, or of one of its views. */
export function domainsHash(slug?: string, tab?: DomainTab): string {
  if (!slug) return "#/domains";
  return `#/domains/${encodeURIComponent(slug)}${tab ? `/${tab}` : ""}`;
}

/** Hash of the Brains page, or of one brain. */
export function brainsHash(slug?: string): string {
  return slug ? `#/brains/${encodeURIComponent(slug)}` : "#/brains";
}

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  ensureClipboardFallbackInstalled();

  if (hash === "#/settings") return { page: "settings" };
  if (hash === "#/integrations") return { page: "integrations" };
  if (hash === "#/integrations/linear") return { page: "integration-linear" };
  if (hash === "#/integrations/linear-oauth") return { page: "integration-linear-oauth" };
  if (hash === "#/prompts") return { page: "prompts" };
  if (hash === "#/environments") return { page: "environments" };
  if (hash === "#/domains") return { page: "domains" };
  if (hash.startsWith("#/domains/")) {
    const [slug, tab] = hash.slice("#/domains/".length).split("?")[0].split("/");
    if (slug) {
      return { page: "domains", slug: decodeURIComponent(slug), ...(isDomainTab(tab) ? { tab } : {}) };
    }
    return { page: "domains" };
  }
  if (hash === "#/brains") return { page: "brains" };
  if (hash.startsWith("#/brains/")) {
    const slug = hash.slice("#/brains/".length).split("?")[0].split("/")[0];
    return slug ? { page: "brains", slug: decodeURIComponent(slug) } : { page: "brains" };
  }
  // #/scheduled (the removed "Scheduled Runs" page) opens #/agents, where
  // schedules now live as agent triggers.
  if (hash === "#/scheduled") return { page: "agents" };
  if (hash === "#/runs") return { page: "runs" };
  if (hash === "#/docs") return { page: "docs", docPath: "" };
  if (hash.startsWith(DOCS_PREFIX)) {
    // Everything after "#/docs/" is the doc path (e.g. "guides/agents").
    return { page: "docs", docPath: hash.slice(DOCS_PREFIX.length) };
  }
  if (hash === "#/playground") return { page: "playground" };
  // Strip query params from hash for matching (OAuth callback appends ?oauth_success=true, ?setup=linear)
  const hashPath = hash.split("?")[0];
  if (hashPath === "#/agents") return { page: "agents" };

  if (hash.startsWith(AGENT_PREFIX)) {
    const agentId = hash.slice(AGENT_PREFIX.length);
    if (agentId) return { page: "agent-detail", agentId };
  }

  if (hash.startsWith(SESSION_PREFIX)) {
    const sessionId = hash.slice(SESSION_PREFIX.length);
    if (sessionId) return { page: "session", sessionId };
  }

  return { page: "home" };
}

/**
 * Build a hash string for a given session ID.
 */
export function sessionHash(sessionId: string): string {
  return `#/session/${sessionId}`;
}

/**
 * Navigate to a session by updating the URL hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateToSession(sessionId: string, replace = false): void {
  ensureClipboardFallbackInstalled();

  const newHash = sessionHash(sessionId);
  if (replace) {
    history.replaceState(null, "", newHash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = `/session/${sessionId}`;
  }
}

/**
 * Navigate to the home page (no session selected) by clearing the hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateHome(replace = false): void {
  ensureClipboardFallbackInstalled();

  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "";
  }
}
