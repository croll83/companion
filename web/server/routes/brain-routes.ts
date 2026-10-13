import type { Hono } from "hono";
import { GLOBAL_DOMAIN, effectiveBrainSlug, ensureGlobalDomain, listDomains, type DomainInfo } from "../domain-store.js";
import { isPluginOn, listInstalledPlugins, type InstalledPlugin } from "../claude-plugins.js";
import {
  brainServerName,
  brainSkillMarkdown,
  brainUrls,
  createRemoteBrain,
  deleteBrain,
  getBrain,
  hasBrainToken,
  listBrains,
  sameUrl,
  updateBrain,
  type BrainConfig,
  type BrainUrls,
  type CreateBrainInput,
} from "../brain/brain-store.js";
import { adoptPluginAsBrain, brainTokenEnvVar, collidingPlugins } from "../brain/brain-runtime.js";
import { checkBrainHealth, testBrainConnection, type FetchLike } from "../brain/brain-probe.js";

/**
 * The Brains page API (/api/brains). Phase 1: remote brains only. A brain is
 * assigned to domains through PATCH /domains/:slug {brain} (domain-routes.ts),
 * one brain per domain; a new brain is on nowhere.
 *
 * No response ever carries a bearer token: only `hasToken`.
 */

/** A brain as the page shows it: config (no token), derived URLs, where it is used, colliding plugins. */
export interface BrainView extends BrainConfig {
  urls: BrainUrls;
  hasToken: boolean;
  /** MCP server and skill name (`<slug>-brain`). */
  serverName: string;
  /** The env var Codex sessions read the token from. */
  tokenEnvVar: string;
  /** The SKILL.md sessions get (generated or custom). */
  skillText: string;
  /** Domains whose sessions use this brain; `own`: the domain chose it (else GLOBAL's default). GLOBAL included. */
  domains: { slug: string; name: string; own: boolean }[];
  /** Installed plugins serving the same MCP URL, and the domains where each is on. */
  collisions: { pluginId: string; pluginName: string; servers: string[]; domains: string[] }[];
}

function domainsUsing(slug: string, domains: DomainInfo[], global: DomainInfo): BrainView["domains"] {
  return domains
    .filter((d) => effectiveBrainSlug(d.slug === GLOBAL_DOMAIN ? undefined : d, global) === slug)
    .map((d) => ({ slug: d.slug, name: d.name, own: d.slug === GLOBAL_DOMAIN || d.brain !== undefined }));
}

function collisionsOf(brain: BrainConfig, plugins: InstalledPlugin[], domains: DomainInfo[], global: DomainInfo): BrainView["collisions"] {
  const mcpUrl = brainUrls(brain).mcpUrl;
  return collidingPlugins(brain, plugins).map((p) => ({
    pluginId: p.id,
    pluginName: p.name,
    servers: Object.entries(p.mcpServers).filter(([, d]) => sameUrl(d.url, mcpUrl)).map(([n]) => n),
    domains: domains.filter((d) => isPluginOn(p, d.slug === GLOBAL_DOMAIN ? undefined : d, global)).map((d) => d.slug),
  }));
}

function brainView(brain: BrainConfig, ctx: { domains: DomainInfo[]; global: DomainInfo; plugins: InstalledPlugin[] }): BrainView {
  return {
    ...brain,
    urls: brainUrls(brain),
    hasToken: hasBrainToken(brain.slug),
    serverName: brainServerName(brain.slug),
    tokenEnvVar: brainTokenEnvVar(brain.slug),
    skillText: brainSkillMarkdown(brain),
    domains: domainsUsing(brain.slug, ctx.domains, ctx.global),
    collisions: collisionsOf(brain, ctx.plugins, ctx.domains, ctx.global),
  };
}

function context() {
  const global = ensureGlobalDomain();
  return { global, domains: listDomains(), plugins: listInstalledPlugins() };
}

export interface BrainRouteDeps {
  /** fetch used for health and test-connection; injected in tests (a local fake server). */
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function registerBrainRoutes(api: Hono, deps: BrainRouteDeps = {}): void {
  const probe = { fetch: deps.fetch, timeoutMs: deps.timeoutMs };

  api.get("/brains", (c) => {
    const ctx = context();
    return c.json({ brains: listBrains().map((b) => brainView(b, ctx)) });
  });

  api.post("/brains", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateBrainInput;
    const result = createRemoteBrain(body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(brainView(result.brain, context()), 201);
  });

  api.get("/brains/:slug", (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    return c.json(brainView(brain, context()));
  });

  api.patch("/brains/:slug", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateBrainInput;
    const result = updateBrain(c.req.param("slug"), body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(brainView(result.brain, context()));
  });

  // Cleared from every domain, then its folder (config, token, plugin) removed.
  api.delete("/brains/:slug", (c) => {
    const result = deleteBrain(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });

  api.get("/brains/:slug/health", async (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    return c.json(await checkBrainHealth(brain, probe));
  });

  api.post("/brains/:slug/test", async (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    return c.json(await testBrainConnection(brain, probe));
  });

  // "Adopt plugin as brain": where the plugin is on, the brain replaces it (one registry write).
  api.post("/brains/:slug/adopt-plugin", async (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { pluginId?: unknown };
    const plugin = listInstalledPlugins().find((p) => p.id === body.pluginId);
    if (!plugin) return c.json({ error: "Plugin not installed" }, 404);
    if (!collidingPlugins(brain, [plugin]).length) {
      return c.json({ error: `${plugin.id} does not serve this brain's MCP URL (${brainUrls(brain).mcpUrl})` }, 409);
    }
    ensureGlobalDomain();
    const { adoptedIn } = adoptPluginAsBrain(brain.slug, plugin);
    return c.json({ adoptedIn, brain: brainView(brain, context()) });
  });
}
