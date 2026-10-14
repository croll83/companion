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
import { CuratorError, curatorFetch, type CuratorFetch } from "../brain/brain-curator.js";
import { gitStatus } from "../brain/brain-git.js";
import { ScaffoldError, scaffoldWiki } from "../brain/wiki-scaffold.js";
import { applyLintFix, checkAdoptFolder, explainLint, isLintFix, type LintFinding, type LintReport } from "../brain/wiki-lint-guide.js";
import { slugify } from "../domain-store.js";
import type { Context } from "hono";

/**
 * The Brains page API (/api/brains): remote brains (an URL) and embedded
 * brains (run by Companion on a wiki folder of this machine,
 * brain-supervisor.ts). A brain is assigned to domains through
 * PATCH /domains/:slug {brain} (domain-routes.ts), one brain per domain; a
 * new brain is on nowhere.
 *
 * Embedded brains: POST /brains {kind: "embedded", wikiDir, ...} adopts an
 * existing wiki folder (POST /brains/adopt-check first: what is missing, with
 * fixes) and starts the brain; POST /brains/new {name, about, tags, wikiDir?}
 * creates a new wiki from the template (wiki-scaffold.ts, git required:
 * GET /brains/git) and its brain; POST /brains/:slug/start|stop|restart;
 * GET /brains/:slug/logs (the child's log tail); health includes the
 * supervisor's state.
 *
 * Contents of an embedded brain, through its curator API (brain-curator.ts):
 * GET /brains/:slug/pages?q= and /pages/:page (secrets redacted as sessions
 * see them), GET /brains/:slug/inbox?status= and POST .../inbox/:note/dismiss,
 * POST /brains/:slug/sources (a text or an URL), GET /brains/:slug/lint and
 * POST /brains/:slug/lint/fix (guided lint, wiki-lint-guide.ts).
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
  /** fetch for the embedded brains' curator API; injected in tests (a core brain in-process). */
  curatorFetch?: CuratorFetch;
}

/** Statuses of the Inbox tab ("discarded" is shown as Dismissed). */
const INBOX_STATUSES = ["pending", "deferred", "accepted", "rejected", "discarded", "withdrawn"] as const;
/** Largest source text accepted from the browser (the brain checks 1 MB of UTF-8 too). */
const MAX_SOURCE_CHARS = 1_000_000;

/** A note as the Inbox tab shows it (no session ids or client internals). */
function inboxNote(n: Record<string, unknown>) {
  const pick = ["note_id", "kind", "statement", "pages", "new_page_hint", "sources", "evidence", "author", "received_at", "status", "status_reason", "status_changed_at", "status_by", "client_name"];
  return Object.fromEntries(pick.filter((k) => n[k] !== undefined).map((k) => [k, n[k]]));
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
  /** Start a new embedded brain and, once it answers, take the skill it publishes. */
  const startNew = async (created: BrainConfig): Promise<BrainConfig> => {
    supervisor.start(created.slug);
    const running = await supervisor.waitRunning(created.slug, readyWaitMs);
    return running ? (await refreshBrainSkill(created.slug, probe)).brain ?? created : created;
  };
  const curator = <T>(slug: string, path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}) =>
    curatorFetch<T>(slug, path, { ...opts, fetch: deps.curatorFetch });
  /** A route on a running embedded brain's contents: 404 for other brains, the curator's errors as JSON. */
  const curated = (fn: (brain: BrainConfig, c: Context) => Promise<unknown>) => async (c: Context) => {
    const brain = embeddedOr404(c.req.param("slug") ?? "");
    if (!brain) return c.json({ error: "No embedded brain with this name" }, 404);
    try {
      return c.json(await fn(brain, c));
    } catch (err) {
      if (err instanceof CuratorError) return c.json({ error: err.message }, err.status);
      throw err;
    }
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
      const result = createEmbeddedBrain(body);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(brainView(await startNew(result.brain), context()), 201);
    }
    const wantServer = body.skill === undefined || (body.skill as { source?: unknown } | null)?.source === "server";
    const result = createRemoteBrain(wantServer ? { ...body, skill: undefined } : body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    const brain = wantServer ? (await refreshBrainSkill(result.brain.slug, probe)).brain ?? result.brain : result.brain;
    return c.json(brainView(brain, context()), 201);
  });

  // ── New brain from the template, adoption check ───────────────────────────
  api.get("/brains/git", async (c) => c.json(await gitStatus()));

  // Name, "what it is about", optional tags (and folder): a new wiki, then its
  // embedded brain (autostart, secrets hidden), started. On no domain (D4).
  api.post("/brains/new", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; about?: unknown; tags?: unknown; wikiDir?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "Brain name is required" }, 400);
    if (body.about !== undefined && typeof body.about !== "string") return c.json({ error: "Invalid about text" }, 400);
    const about = typeof body.about === "string" ? body.about.trim() : "";
    const slug = slugify(name);
    if (!slug) return c.json({ error: "The name must contain letters or digits" }, 400);
    if (getBrain(slug)) return c.json({ error: `A brain "${slug}" already exists` }, 409);
    let wiki;
    try {
      wiki = await scaffoldWiki({ slug, name, about, tags: body.tags, dir: body.wikiDir });
    } catch (err) {
      if (!(err instanceof ScaffoldError)) throw err;
      const status = err.code === "invalid" ? 400 : err.code === "git-failed" ? 500 : 409;
      return c.json({ error: err.message, code: err.code }, status);
    }
    const result = createEmbeddedBrain({ name, slug, about, wikiDir: wiki.dir, language: wiki.language, redactSecrets: true, autostart: true });
    if (!result.ok) return c.json({ error: `${result.error} (the wiki was created in ${wiki.dir})` }, result.status);
    const brain = await startNew(result.brain);
    return c.json({ brain: brainView(brain, context()), wiki }, 201);
  });

  // "Adopt existing folder": what the folder lacks before a brain can run on
  // it, with fixes; {fix} applies one first (create-schema, create-index).
  api.post("/brains/adopt-check", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { wikiDir?: unknown; fix?: unknown; name?: unknown; about?: unknown };
    let check = checkAdoptFolder(body.wikiDir);
    if (!check.ok) return c.json({ error: check.error }, 400);
    let done: string | undefined;
    if (body.fix !== undefined) {
      if (body.fix !== "create-schema" && body.fix !== "create-index") return c.json({ error: "Before adoption only create-schema and create-index apply" }, 400);
      done = applyLintFix(check.path, body.fix, {
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
        about: typeof body.about === "string" ? body.about : undefined,
      });
      check = checkAdoptFolder(check.path);
    }
    return c.json({ ...check, ...(done ? { done } : {}) });
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

  // ── Contents of an embedded brain (its curator API) ───────────────────────
  api.get("/brains/:slug/pages", curated(async (brain, c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 300);
    // Opening the tab shows the wiki as it is now, not as of the last periodic reload.
    if (!q) await curator(brain.slug, "/admin/refresh", { method: "POST", body: {} });
    return curator(brain.slug, `/wiki/pages?redact=1${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  }));

  api.get("/brains/:slug/pages/:page{.+}", curated(async (brain, c) =>
    curator(brain.slug, `/wiki/pages/${encodeURIComponent(c.req.param("page") ?? "")}?redact=1`)));

  api.get("/brains/:slug/inbox", curated(async (brain, c) => {
    const status = c.req.query("status") ?? "pending";
    if (!(INBOX_STATUSES as readonly string[]).includes(status)) throw new CuratorError(400, `status must be one of ${INBOX_STATUSES.join(", ")}`);
    const r = await curator<{ counts: Record<string, number>; notes: Record<string, unknown>[] }>(brain.slug, `/inbox/notes?status=${status}&limit=200`);
    // Newest first for the page (the API lists oldest first, for consolidation).
    return { counts: r.counts, notes: r.notes.map(inboxNote).reverse() };
  }));

  api.post("/brains/:slug/inbox/:note/dismiss", curated(async (brain, c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : undefined;
    return curator(brain.slug, `/inbox/notes/${encodeURIComponent(c.req.param("note") ?? "")}/dismiss`, {
      method: "POST",
      body: { by: "user", ...(reason ? { reason } : {}) },
    });
  }));

  // "Add source": {name, text, note?} or {url, title?, note?}. The brain writes
  // the file (raw/sources/, never overwriting) and records a source_pointer note.
  api.post("/brains/:slug/sources", curated(async (brain, c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.text === "string" && body.text.length > MAX_SOURCE_CHARS) throw new CuratorError(413, "The source is larger than 1 MB");
    const pick = body.url !== undefined ? ["url", "title", "note"] : ["name", "text", "note"];
    return curator(brain.slug, "/sources", { method: "POST", body: { ...Object.fromEntries(pick.map((k) => [k, body[k]])), by: "Companion" } });
  }));

  // Guided lint: the brain's findings as sentences, with fixes.
  // The wiki is reloaded first: the check sees the files as they are now.
  api.get("/brains/:slug/lint", curated(async (brain) => {
    await curator(brain.slug, "/admin/refresh", { method: "POST", body: {} });
    return explainLint(await curator<LintReport>(brain.slug, "/lint"));
  }));

  // Apply one additive fix to the wiki, reload the brain, lint again.
  api.post("/brains/:slug/lint/fix", curated(async (brain, c) => {
    const body = (await c.req.json().catch(() => ({}))) as { fix?: unknown };
    if (!isLintFix(body.fix)) throw new CuratorError(400, "Unknown fix");
    const report = await curator<LintReport & { findings: LintFinding[] }>(brain.slug, "/lint");
    const { pages } = await curator<{ pages: { slug: string; title: string; tags: string[] }[] }>(brain.slug, "/wiki/pages");
    const done = applyLintFix(brain.embedded!.wikiDir, body.fix, { name: brain.name, about: brain.about, pages, findings: report.findings });
    await curator(brain.slug, "/admin/refresh", { method: "POST", body: {} });
    if (brain.skill.source === "server") await refreshBrainSkill(brain.slug, probe);
    return { done, lint: explainLint(await curator<LintReport>(brain.slug, "/lint")) };
  }));

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
