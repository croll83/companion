import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  GLOBAL_DOMAIN,
  countMemoryNotes,
  createDomain,
  deleteDomain,
  domainDir,
  domainMemoryDir,
  domainsRoot,
  ensureDomainLayout,
  ensureGlobalDomain,
  getDomain,
  listDomainSkills,
  listDomains,
  readDomainMcp,
  setDomainMcpServer,
  updateDomain,
  type DomainInfo,
} from "../domain-store.js";
import { domainMcpView, mcpTargetOf, mcpTypeOf, resolveDomain, type DomainMcpServerView } from "../domain-runtime.js";
import { isSkillGroupOn, listSkillGroups, type SkillGroup } from "../skill-groups.js";
import { isPluginOn, listInstalledPlugins, type InstalledPlugin } from "../claude-plugins.js";
import { cachedAccountMcpServers, isAccountMcpStale, refreshAccountMcpServers, type AccountMcpList } from "../account-mcp.js";

/** An installed plugin as the Domains page lists it (server env and headers left out). */
export interface PluginView {
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  description?: string;
  skills: string[];
  mcpServers: { name: string; type: string; target: string }[];
  enabledByUser: boolean;
}

function pluginView(p: InstalledPlugin): PluginView {
  return {
    id: p.id,
    name: p.name,
    marketplace: p.marketplace,
    ...(p.version ? { version: p.version } : {}),
    ...(p.description ? { description: p.description } : {}),
    skills: p.skills,
    mcpServers: Object.entries(p.mcpServers).map(([name, d]) => ({ name, type: mcpTypeOf(d), target: mcpTargetOf(d) })),
    enabledByUser: p.enabledByUser,
  };
}

/** The sessions the Domains page counts (only their domain matters). */
export interface DomainSessionSource {
  listSessions(): { domain?: string; archived?: boolean }[];
}

export interface DomainSummary extends DomainInfo {
  path: string;
  /** Sessions in the domain that are not archived. */
  sessionCount: number;
  /** All sessions in the domain, archived included (any of them blocks deletion). */
  totalSessions: number;
  memoryNotes: number;
  skills: string[];
  mcpServers: DomainMcpServerView[];
  mcpError?: string;
  /** Effective state of each skill group, and whether it is this domain's own choice. */
  skillGroupStates: Record<string, { on: boolean; own: boolean }>;
  /** Effective state of each installed plugin, and whether it is this domain's own choice. */
  pluginStates: Record<string, { on: boolean; own: boolean }>;
}

/** Files of a domain editable from the Domains page, with their format. */
const DOMAIN_FILES: Record<string, "markdown" | "json"> = {
  "CLAUDE.md": "markdown",
  "mcp.json": "json",
};

function summarize(
  domain: DomainInfo,
  global: DomainInfo,
  sessions: DomainSessionSource,
  groups: SkillGroup[],
  plugins: InstalledPlugin[] = listInstalledPlugins(),
): DomainSummary {
  const inDomain = sessions.listSessions().filter((s) => (s.domain ?? GLOBAL_DOMAIN) === domain.slug);
  const r = resolveDomain(domain.slug);
  const mcp = readDomainMcp(domain.slug);
  const own = domain.slug === GLOBAL_DOMAIN ? undefined : domain;
  const skillGroupStates: DomainSummary["skillGroupStates"] = {};
  for (const g of groups) {
    skillGroupStates[g.id] = {
      on: isSkillGroupOn(g.id, own, global),
      own: domain.skillGroups?.[g.id] !== undefined,
    };
  }
  const pluginStates: DomainSummary["pluginStates"] = {};
  for (const p of plugins) {
    pluginStates[p.id] = { on: isPluginOn(p, own, global), own: domain.plugins?.[p.id] !== undefined };
  }
  return {
    ...domain,
    path: domainDir(domain.slug),
    sessionCount: inDomain.filter((s) => !s.archived).length,
    totalSessions: inDomain.length,
    memoryNotes: countMemoryNotes(domainMemoryDir(domain.slug)),
    skills: listDomainSkills(domain.slug),
    mcpServers: domainMcpView(r),
    ...(mcp.error ? { mcpError: mcp.error } : {}),
    skillGroupStates,
    pluginStates,
  };
}

/** Validate an edited domain file before it is written (mcp.json must keep the expected shape). */
function validateDomainFile(name: string, content: string): string | null {
  if (DOMAIN_FILES[name] !== "json") return null;
  try {
    const parsed = JSON.parse(content) as { mcpServers?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "mcp.json must be a JSON object";
    if (parsed.mcpServers !== undefined && (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null || Array.isArray(parsed.mcpServers))) {
      return "\"mcpServers\" must be an object of servers";
    }
    return null;
  } catch (e) {
    return `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface DomainRouteDeps {
  /** Re-read the account's MCP servers (`claude mcp list`); injected in tests. */
  refreshAccountMcp?: () => Promise<AccountMcpList>;
}

export function registerDomainRoutes(api: Hono, sessions: DomainSessionSource, deps: DomainRouteDeps = {}): void {
  const refreshAccountMcp = deps.refreshAccountMcp ?? (() => refreshAccountMcpServers());

  api.get("/domains", (c) => {
    const global = ensureGlobalDomain();
    const groups = listSkillGroups();
    const plugins = listInstalledPlugins();
    // The account's servers come from a cache; a stale one is refreshed in
    // the background (the page asks again when told it is stale).
    const account = cachedAccountMcpServers();
    const stale = isAccountMcpStale(account);
    if (stale) void refreshAccountMcp().catch(() => {});
    return c.json({
      root: domainsRoot(),
      skillGroups: groups,
      plugins: plugins.map(pluginView),
      accountMcp: { at: account.at, stale, ...(account.error ? { error: account.error } : {}) },
      domains: listDomains().map((d) => summarize(d, global, sessions, groups, plugins)),
    });
  });

  // Re-read the MCP servers of the user's Claude config and claude.ai account (~10 s).
  api.post("/account-mcp-servers/refresh", async (c) => {
    const list = await refreshAccountMcp();
    return c.json({ at: list.at, servers: list.servers.length, ...(list.error ? { error: list.error } : {}) });
  });

  // One MCP server of the domain's mcp.json: add or replace (URL or command), or remove.
  api.put("/domains/:slug/mcp/:name", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown; command?: unknown; args?: unknown };
    const result = setDomainMcpServer(slug, c.req.param("name"), body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const domain = slug === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(slug)!;
    return c.json(summarize(domain, ensureGlobalDomain(), sessions, listSkillGroups()));
  });

  api.delete("/domains/:slug/mcp/:name", (c) => {
    const slug = c.req.param("slug");
    const result = setDomainMcpServer(slug, c.req.param("name"), null);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const domain = slug === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(slug)!;
    return c.json(summarize(domain, ensureGlobalDomain(), sessions, listSkillGroups()));
  });

  api.post("/domains", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = createDomain(body as { name?: unknown; description?: unknown });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(summarize(result.domain, ensureGlobalDomain(), sessions, listSkillGroups()), 201);
  });

  api.patch("/domains/:slug", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = updateDomain(c.req.param("slug"), body as Record<string, unknown>);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(summarize(result.domain, ensureGlobalDomain(), sessions, listSkillGroups()));
  });

  // Registry entry only: the domain's folder and files stay on disk.
  api.delete("/domains/:slug", (c) => {
    const slug = c.req.param("slug");
    const used = sessions.listSessions().filter((s) => (s.domain ?? GLOBAL_DOMAIN) === slug).length;
    if (used > 0 && slug !== GLOBAL_DOMAIN) {
      return c.json({ error: `${used} session(s) use this domain (archived ones included): move or delete them first` }, 409);
    }
    const result = deleteDomain(slug);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, keptOnDisk: domainDir(slug) });
  });

  api.get("/domains/:slug/file", async (c) => {
    const slug = c.req.param("slug");
    const name = c.req.query("name") ?? "";
    const format = DOMAIN_FILES[name];
    if (!format) return c.json({ error: "Only CLAUDE.md and mcp.json can be edited here" }, 400);
    const domain = slug === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(slug);
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    ensureDomainLayout(domain);
    const path = join(domainDir(slug), name);
    try {
      return c.json({ path, content: await readFile(path, "utf-8"), format, readOnly: false });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot read file" }, 404);
    }
  });

  api.put("/domains/:slug/file", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; content?: unknown };
    const name = typeof body.name === "string" ? body.name : "";
    if (!DOMAIN_FILES[name]) return c.json({ error: "Only CLAUDE.md and mcp.json can be edited here" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content required" }, 400);
    const domain = slug === GLOBAL_DOMAIN ? ensureGlobalDomain() : getDomain(slug);
    if (!domain) return c.json({ error: "Domain not found" }, 404);
    const invalid = validateDomainFile(name, body.content);
    if (invalid) return c.json({ error: invalid }, 400);
    ensureDomainLayout(domain);
    const path = join(domainDir(slug), name);
    try {
      await writeFile(path, body.content, "utf-8");
      return c.json({ ok: true, path });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot write file" }, 500);
    }
  });
}
