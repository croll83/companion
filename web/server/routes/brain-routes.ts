import type { Hono } from "hono";
import { GLOBAL_DOMAIN, effectiveBrainSlug, ensureGlobalDomain, listDomains, type DomainInfo } from "../domain-store.js";
import { isPluginOn, listInstalledPlugins, type InstalledPlugin } from "../claude-plugins.js";
import {
  brainServerName,
  brainSkillMarkdown,
  brainUrls,
  createEmbeddedBrain,
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
  type CreateEmbeddedBrainInput,
} from "../brain/brain-store.js";
import { brainSupervisor, type BrainRuntimeStatus, type BrainSupervisor } from "../brain/brain-supervisor.js";
import { adoptPluginAsBrain, brainTokenEnvVar, collidingPlugins } from "../brain/brain-runtime.js";
import { checkBrainHealth, testBrainConnection, type FetchLike } from "../brain/brain-probe.js";
import { refreshBrainSkill, refreshSkillOnNewContent } from "../brain/brain-skill-fetch.js";

/**
 * The Brains page API (/api/brains): remote brains (an URL) and embedded
 * brains (run by Companion on a wiki folder of this machine,
 * brain-supervisor.ts). A brain is assigned to domains through
 * PATCH /domains/:slug {brain} (domain-routes.ts), one brain per domain; a
 * new brain is on nowhere.
 *
 * Embedded brains: POST /brains {kind: "embedded", wikiDir, ...} creates and
 * starts one; POST /brains/:slug/start|stop|restart; GET /brains/:slug/logs
 * (the child's log tail); health includes the supervisor's state.
 *
 * Skill from the server: a new brain tries `<base>/skill` first and falls
 * back to the generated skill (with a note) when the server publishes none;
 * POST /brains/:slug/skill/refresh fetches it again; a health check that
 * reports another wiki version refetches a "server" skill.
 *
 * No response ever carries a bearer token or an embedded brain's keys: only `hasToken`.
 */

/** A brain as the page shows it: config (no token), derived URLs, where it is used, colliding plugins. */
export interface BrainView extends BrainConfig {
  urls: BrainUrls;
  hasToken: boolean;
  /** MCP server and skill name (`<slug>-brain`). */
  serverName: string;
  /** The env var Codex sessions read the token from. */
  tokenEnvVar: string;
  /** The SKILL.md sessions get (generated, custom or from the server). Plain text: never render it as HTML. */
  skillText: string;
  /** Domains whose sessions use this brain; `own`: the domain chose it (else GLOBAL's default). GLOBAL included. */
  domains: { slug: string; name: string; own: boolean }[];
  /** Installed plugins serving the same MCP URL, and the domains where each is on. */
  collisions: { pluginId: string; pluginName: string; servers: string[]; domains: string[] }[];
  /** Embedded brains: the supervisor's view of the child (state, cause and action when failing). */
  runtime?: BrainRuntimeStatus;
}

type Supervisor = Pick<BrainSupervisor, "start" | "stop" | "restart" | "status" | "waitRunning" | "logTail">;

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

function brainView(brain: BrainConfig, ctx: { domains: DomainInfo[]; global: DomainInfo; plugins: InstalledPlugin[]; supervisor: Supervisor }): BrainView {
  return {
    ...brain,
    urls: brainUrls(brain),
    // An embedded brain's secret is a key, not a token the user set.
    hasToken: brain.kind === "remote" && hasBrainToken(brain.slug),
    serverName: brainServerName(brain.slug),
    tokenEnvVar: brainTokenEnvVar(brain.slug),
    skillText: brainSkillMarkdown(brain),
    domains: domainsUsing(brain.slug, ctx.domains, ctx.global),
    collisions: collisionsOf(brain, ctx.plugins, ctx.domains, ctx.global),
    ...(brain.kind === "embedded" ? { runtime: ctx.supervisor.status(brain.slug) } : {}),
  };
}

export interface BrainRouteDeps {
  /** fetch used for health and test-connection; injected in tests (a local fake server). */
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Runs embedded brains; a fake in tests. */
  supervisor?: Supervisor;
  /** How long creating or restarting an embedded brain waits for it to be ready (default 15 s). */
  readyWaitMs?: number;
}

/** Changes that need the child restarted: they are in its environment. */
const RESTART_FIELDS = ["name", "about", "redactSecrets", "language"] as const;

export function registerBrainRoutes(api: Hono, deps: BrainRouteDeps = {}): void {
  const probe = { fetch: deps.fetch, timeoutMs: deps.timeoutMs };
  const supervisor: Supervisor = deps.supervisor ?? brainSupervisor;
  const readyWaitMs = deps.readyWaitMs ?? 15_000;
  const context = () => {
    const global = ensureGlobalDomain();
    return { global, domains: listDomains(), plugins: listInstalledPlugins(), supervisor };
  };
  const embeddedOr404 = (slug: string) => {
    const brain = getBrain(slug);
    return brain?.kind === "embedded" ? brain : undefined;
  };

  api.get("/brains", (c) => {
    const ctx = context();
    return c.json({ brains: listBrains().map((b) => brainView(b, ctx)) });
  });

  // A new brain uses the server's skill when it publishes one (skill absent
  // or {source: "server"}); otherwise the generated one, with a note.
  api.post("/brains", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateBrainInput & CreateEmbeddedBrainInput & { kind?: unknown };
    if (body.kind === "embedded") {
      // Create, start, and once it answers take the skill it publishes.
      const result = createEmbeddedBrain(body);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      supervisor.start(result.brain.slug);
      const running = await supervisor.waitRunning(result.brain.slug, readyWaitMs);
      const brain = running ? (await refreshBrainSkill(result.brain.slug, probe)).brain ?? result.brain : result.brain;
      return c.json(brainView(brain, context()), 201);
    }
    const wantServer = body.skill === undefined || (body.skill as { source?: unknown } | null)?.source === "server";
    const result = createRemoteBrain(wantServer ? { ...body, skill: undefined } : body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const brain = wantServer ? (await refreshBrainSkill(result.brain.slug, probe)).brain ?? result.brain : result.brain;
    return c.json(brainView(brain, context()), 201);
  });

  api.get("/brains/:slug", (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    return c.json(brainView(brain, context()));
  });

  // {skill: {source: "server"}} fetches the server's skill (a failure keeps
  // the current skill, with a note). A "server" brain whose URL or auth
  // changes fetches it again from the new place.
  api.patch("/brains/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = (await c.req.json().catch(() => ({}))) as CreateBrainInput;
    const wantServer = (body.skill as { source?: unknown } | null | undefined)?.source === "server";
    const result = updateBrain(slug, wantServer ? { ...body, skill: undefined } : body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const moved = body.baseUrl !== undefined || body.mcpUrl !== undefined || body.auth !== undefined || body.token !== undefined;
    let brain = result.brain;
    const patchBody = body as Record<string, unknown>;
    if (brain.kind === "embedded" && supervisor.status(slug).state !== "stopped" && RESTART_FIELDS.some((f) => patchBody[f] !== undefined)) {
      await supervisor.restart(slug);
      await supervisor.waitRunning(slug, readyWaitMs);
    }
    if (wantServer || (moved && brain.skill.source === "server")) {
      brain = (await refreshBrainSkill(slug, { ...probe, conditional: !moved })).brain ?? brain;
    }
    return c.json(brainView(brain, context()));
  });

  // "Refresh skill": fetch <base>/skill again (If-None-Match when a server skill is stored).
  api.post("/brains/:slug/skill/refresh", async (c) => {
    const slug = c.req.param("slug");
    if (!getBrain(slug)) return c.json({ error: "Brain not found" }, 404);
    const r = await refreshBrainSkill(slug, probe);
    const brain = r.brain ?? getBrain(slug);
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    return c.json({ outcome: r.outcome, ...(r.error ? { error: r.error } : {}), brain: brainView(brain, context()) });
  });

  // Cleared from every domain, then its folder (config, token, plugin) removed.
  // An embedded brain is stopped first; its wiki folder is never touched.
  api.delete("/brains/:slug", async (c) => {
    if (embeddedOr404(c.req.param("slug"))) await supervisor.stop(c.req.param("slug"));
    const result = deleteBrain(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result);
  });

  // A "server" skill built from another wiki version is fetched again.
  api.get("/brains/:slug/health", async (c) => {
    const brain = getBrain(c.req.param("slug"));
    if (!brain) return c.json({ error: "Brain not found" }, 404);
    const health = await checkBrainHealth(brain, probe);
    const refresh = health.reachable ? await refreshSkillOnNewContent(brain, health.content_hash, probe) : null;
    const runtime = brain.kind === "embedded" ? { runtime: supervisor.status(brain.slug) } : {};
    return c.json({ ...health, ...(refresh ? { skillRefresh: refresh.outcome } : {}), ...runtime });
  });

  // ── Embedded brains: the child process ────────────────────────────────────
  api.post("/brains/:slug/:action{start|stop|restart}", async (c) => {
    const slug = c.req.param("slug");
    if (!getBrain(slug)) return c.json({ error: "Brain not found" }, 404);
    if (!embeddedOr404(slug)) return c.json({ error: "Only an embedded brain runs in Companion" }, 409);
    const action = c.req.param("action");
    if (action === "stop") {
      await supervisor.stop(slug);
    } else {
      if (action === "restart") await supervisor.restart(slug);
      else supervisor.start(slug);
      await supervisor.waitRunning(slug, readyWaitMs);
    }
    return c.json({ runtime: supervisor.status(slug) });
  });

  // The child's log (its stdout and stderr): what the troubleshooting area shows.
  api.get("/brains/:slug/logs", (c) => {
    const slug = c.req.param("slug");
    if (!embeddedOr404(slug)) return c.json({ error: "No embedded brain with this name" }, 404);
    const n = Math.min(1000, Math.max(1, Number(c.req.query("lines")) || 200));
    return c.json({ lines: supervisor.logTail(slug, n) });
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
