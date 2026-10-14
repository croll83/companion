// HTTP API for curator jobs (the consolidation agent, Companion's routes,
// scripts): wiki reads for the model's context, the inbox, the consolidation
// steps, lint, a forced reload. With BRAIN_CURATOR_KEY set every route needs
// the X-Brain-Key header; Companion's server holds the key, sessions never do.
//
// The API returns the wiki text NOT redacted, whatever BRAIN_REDACT_SECRETS
// says: its callers edit the wiki, and a page written back from a redacted
// copy would lose its secrets. Redaction applies to the MCP tools only.

import { timingSafeEqual } from "node:crypto";
import { parsePage, resolvePage, NAV_FILES, type Page } from "./wiki.js";
import { envelope, redactor } from "./redact.js";
import { addSource } from "./sources.js";
import { Consolidation, HttpError } from "./consolidation.js";
import { lintPages, lintWiki } from "./lint.js";
import { NOTE_STATUSES } from "./inbox.js";
import { toolCatalog, wikiTopics, SKILL_API } from "./skill.js";
import type { Brain } from "./brain.js";

const MAX_BODY_BYTES = 2_000_000;

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: "GET" | "POST";
  re: RegExp;
  keys: string[];
  fn: Handler;
}

/** "/wiki/pages/:slug" → a RegExp with one capture per ":name" (one path segment each). */
function compile(method: Route["method"], path: string, fn: Handler): Route {
  const keys: string[] = [];
  const src = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:([a-z_]+)/g, (_m, k: string) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { method, re: new RegExp(`^/api/v1${src}$`), keys, fn };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function sameKey(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== "POST") return {};
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

/** The /api/v1 router of a brain: returns null when the path is not an API path. */
export function createApi(brain: Brain): (req: Request, url: URL) => Promise<Response | null> {
  const cons = new Consolidation(brain.inbox);

  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required`);
    return v;
  };
  const by = (body: Record<string, unknown>) => (typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 64) : "consolidation");
  const int = (v: string | null, def: number, min: number, max: number) => {
    const n = Number(v ?? def);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
  };

  const routes: Route[] = [
    // --- wiki reads -----------------------------------------------------------
    compile("GET", "/wiki/schema", () => {
      const w = brain.wiki();
      return { wiki_commit: w.commit, content_hash: w.contentHash, schema: w.nav.get("SCHEMA.md"), taxonomy: [...w.taxonomy] };
    }),
    /**
     * Every page (path order), or with ?q= the pages that match a search
     * (BM25 order, with a snippet). ?redact=1 hides secrets in snippets when
     * the brain redacts them for sessions (Companion's Pages tab shows what
     * sessions see).
     */
    compile("GET", "/wiki/pages", ({ query }) => {
      const w = brain.wiki();
      const meta = (p: Page) => ({ slug: p.slug, path: p.path, title: p.title, type: p.type, tags: p.tags, updated: p.updated, subwiki: p.subwiki });
      const q = query.get("q")?.trim();
      if (!q) return { wiki_commit: w.commit, pages: [...w.pages.values()].sort((a, b) => a.path.localeCompare(b.path)).map(meta) };
      const red = redactor(query.get("redact") === "1" && brain.cfg.redactSecrets);
      const hits = brain.index().search(q.slice(0, 300), { limit: int(query.get("limit"), 50, 1, 200), includeRaw: false });
      return {
        wiki_commit: w.commit,
        query: q,
        pages: hits.flatMap((h) => {
          const p = w.pages.get(h.ref);
          return p ? [{ ...meta(p), score: h.score, snippet: red(h.snippet).text }] : [];
        }),
      };
    }),
    /**
     * One page (slug, [[slug]] or path), or a navigation file by name (index,
     * schema, log, readme). ?redact=1 as above.
     */
    compile("GET", "/wiki/pages/:slug", ({ params, query }) => {
      const w = brain.wiki();
      const red = redactor(query.get("redact") === "1" && brain.cfg.redactSecrets);
      const p = resolvePage(w, params.slug);
      if (!p) {
        const nav = NAV_FILES.find((f) => f.toLowerCase() === `${params.slug.toLowerCase().replace(/\.md$/, "")}.md`);
        const text = nav ? w.nav.get(nav) : undefined;
        if (nav && text !== undefined) return { wiki_commit: w.commit, slug: nav.replace(/\.md$/, ""), path: nav, title: nav, type: "navigation", tags: [], updated: null, sources: [], markdown: red(text).text };
        throw new HttpError(404, `no page ${params.slug}`);
      }
      return { wiki_commit: w.commit, slug: p.slug, path: p.path, title: p.title, type: p.type, tags: p.tags, updated: p.updated, sources: p.sources, markdown: red(p.text).text };
    }),
    compile("GET", "/wiki/sources", ({ query }) => {
      const w = brain.wiki();
      const path = str(query.get("path"), "path");
      const src = w.raw.get(path);
      if (!src || src.text === null) throw new HttpError(404, `no text source ${path}`);
      const lines = src.text.split("\n");
      const from = int(query.get("from"), 1, 1, lines.length);
      const max = int(query.get("max"), 400, 1, 2000);
      const text = lines.slice(from - 1, from - 1 + max).join("\n");
      return { wiki_commit: w.commit, path, from, to: Math.min(from - 1 + max, lines.length), total_lines: lines.length, text: envelope(path, text, "source") };
    }),
    /**
     * What a client needs to build a skill without reading the wiki: who the
     * brain is, the sanitized index.md titles and taxonomy tags, the tools.
     */
    compile("GET", "/wiki/skill-context", () => {
      const w = brain.wiki();
      const p = brain.persona();
      const topics = wikiTopics(w);
      return {
        skill_api: SKILL_API,
        name: brain.cfg.name,
        title: p.title,
        owner: p.owner,
        about: p.about,
        wiki_commit: w.commit,
        content_hash: w.contentHash,
        pages: w.pages.size,
        sections: topics.sections,
        tags: topics.tags,
        tools: toolCatalog(),
      };
    }),

    // --- lint -----------------------------------------------------------------
    compile("GET", "/lint", () => lintWiki(brain.wiki())),
    /** Lint a draft page against the current wiki before writing it: body {path: "concepts/x.md", markdown}. */
    compile("POST", "/lint/page", ({ body }) => {
      const w = brain.wiki();
      const path = str(body.path, "path").replace(/^\/+/, "");
      if (!/^[^.][^\n]*\.md$/.test(path) || path.includes("..")) throw new HttpError(400, "path must be a relative .md path, e.g. concepts/x.md");
      const markdown = str(body.markdown, "markdown");
      const existing = [...w.pages.values()].find((p) => p.path === path);
      const draft = parsePage(path, markdown, existing?.slug ?? path.split("/").pop()!.replace(/\.md$/i, ""), existing?.subwiki ?? null);
      const pages = new Map(w.pages);
      const aliases = new Map(w.aliases);
      pages.set(draft.slug, draft);
      aliases.set(draft.slug.toLowerCase(), draft.slug);
      const findings = lintPages({ ...w, pages, aliases }, [draft.slug]);
      return { ok: !findings.some((f) => f.level === "error"), slug: draft.slug, is_new_page: !existing, findings };
    }),

    // --- inbox ----------------------------------------------------------------
    compile("GET", "/inbox/notes", ({ query }) => {
      const status = query.get("status") ?? "pending";
      if (!(NOTE_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `invalid status: ${status}`);
      return { counts: brain.inbox.counts(), notes: brain.inbox.listByStatus(status, int(query.get("limit"), 200, 1, 1000)) };
    }),
    compile("GET", "/inbox/notes/:note", ({ params }) => {
      const n = brain.inbox.get(params.note);
      if (!n) throw new HttpError(404, `no note ${params.note}`);
      return n;
    }),
    /** "Dismiss" from Companion's inbox view: the note is discarded (its text erased), with a reason. */
    compile("POST", "/inbox/notes/:note/dismiss", ({ params, body }) => {
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "dismissed by the user";
      const r = brain.inbox.decide(params.note, "discarded", reason, typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 64) : "user");
      if (!r.ok) throw new HttpError(r.error === "no such note" ? 404 : 409, r.error ?? "not dismissed");
      return { note_id: params.note, status: "discarded" };
    }),

    /**
     * "Add source" from Companion: {name, text, note?} writes raw/sources/<date>-<name>.md
     * (never overwriting) and records a source_pointer note; {url, title?, note?}
     * records the note only (sources.ts).
     */
    compile("POST", "/sources", ({ body }) => addSource(brain, body)),

    // --- consolidation of the inbox ------------------------------------------
    compile("GET", "/consolidation/runs", () => ({ runs: cons.list() })),
    compile("POST", "/consolidation/runs", ({ body }) => cons.start(typeof body.run_id === "string" ? body.run_id : undefined, brain.wiki())),
    compile("GET", "/consolidation/runs/:run", ({ params }) => cons.view(params.run, brain.wiki())),
    compile("GET", "/consolidation/runs/:run/notes", ({ params, query }) => ({
      notes: cons.notes(params.run, brain.wiki(), query.get("decision") ?? undefined),
    })),
    compile("POST", "/consolidation/runs/:run/notes/:note/decision", ({ params, body }) =>
      cons.decide(params.run, params.note, str(body.decision, "decision"), str(body.reason, "reason"), by(body)),
    ),
    compile("POST", "/consolidation/runs/:run/finalize", ({ params, body }) =>
      cons.finalize(params.run, brain.wiki(), typeof body.summary === "string" ? body.summary : undefined),
    ),
    compile("POST", "/consolidation/runs/:run/abandon", ({ params, body }) => cons.abandon(params.run, str(body.reason, "reason"))),

    // --- admin ----------------------------------------------------------------
    /** Re-read the wiki now (after a consolidation wrote it), instead of waiting for the periodic reload. */
    compile("POST", "/admin/refresh", () => {
      const changed = brain.refresh();
      const w = brain.wiki();
      return { changed, wiki_commit: w.commit, content_hash: w.contentHash, pages: w.pages.size };
    }),
  ];

  return async (req, url) => {
    if (!url.pathname.startsWith("/api/v1/") && url.pathname !== "/api/v1") return null;
    const started = Date.now();
    const detail = `${req.method} ${url.pathname}`;
    const key = brain.cfg.curatorKey;
    if (key && !sameKey(req.headers.get("x-brain-key"), key)) {
      brain.audit.log({ event: "api_denied", detail, ok: false });
      return json(401, { error: "the X-Brain-Key header is missing or wrong" });
    }
    let matchedPath = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      matchedPath = true;
      if (r.method !== req.method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      try {
        const out = await r.fn({ params, query: url.searchParams, body: await readBody(req) });
        brain.audit.log({ event: "api_call", detail, ok: true, ms: Date.now() - started });
        return json(200, out);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        brain.audit.log({ event: "api_call", detail: `${detail}: ${(e as Error).message}`, ok: false, ms: Date.now() - started });
        return json(status, { error: status === 500 ? `internal error: ${(e as Error).message}` : (e as Error).message });
      }
    }
    return matchedPath ? json(405, { error: `method ${req.method} not allowed` }) : json(404, { error: `no route ${url.pathname}` });
  };
}
