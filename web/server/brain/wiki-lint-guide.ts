import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { absoluteDir } from "./brain-store.js";
import { DEFAULT_TAGS, normalizeTags, wikiTemplate } from "./wiki-scaffold.js";

/**
 * Guided lint for a wiki adopted by an embedded brain: the findings of the
 * brain's lint (GET /api/v1/lint of the child; Companion's server never
 * imports the core) turned into plain sentences, grouped, with one-click
 * fixes for the simple problems.
 *
 * Fixes are applied by Companion's server to the wiki files and are only
 * ADDITIVE: a missing file is created (never overwritten, flag "wx"), a
 * section or a line is added; nothing is ever deleted or rewritten. Before
 * the brain exists (a folder without SCHEMA.md cannot run one) the same
 * sentences come from a check of the folder itself (checkAdoptFolder).
 */

/** A finding as the brain's lint reports it (core/lint.ts). */
export interface LintFinding {
  rule: string;
  level: "error" | "warn";
  path: string;
  message: string;
}

export interface LintReport {
  findings: LintFinding[];
  errors: number;
  warnings: number;
  pages: number;
}

export type LintFixId = "create-schema" | "create-index" | "create-log" | "add-taxonomy" | "add-tags" | "index-pages";

export const LINT_FIXES: readonly LintFixId[] = ["create-schema", "create-index", "create-log", "add-taxonomy", "add-tags", "index-pages"];

export interface LintAdvice {
  /** Stable key of the group. */
  id: string;
  level: "error" | "warn";
  /** What is wrong, in a sentence. */
  sentence: string;
  /** The files concerned (the first 20). */
  paths: string[];
  count: number;
  fix?: { id: LintFixId; label: string };
}

export interface LintView {
  ok: boolean;
  errors: number;
  warnings: number;
  pages: number;
  advice: LintAdvice[];
}

interface Rule {
  id: string;
  match: (f: LintFinding) => boolean;
  sentence: (n: number, found: LintFinding[]) => string;
  fix?: { id: LintFixId; label: string };
}

const s = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/** Tags named by "tags not in the SCHEMA.md taxonomy: a, b" findings. */
export function unknownTags(findings: LintFinding[]): string[] {
  const out = new Set<string>();
  for (const f of findings) {
    const m = /^tags not in the SCHEMA\.md taxonomy: (.+)$/.exec(f.message);
    if (m) for (const t of normalizeTags(m[1])) out.add(t);
  }
  return [...out];
}

/** Slugs named by "page not listed in index.md: [[slug]]" findings. */
export function unlistedPages(findings: LintFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    const m = /^page not listed in index\.md: \[\[(.+)\]\]$/.exec(f.message);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const RULES: Rule[] = [
  {
    id: "schema-missing",
    match: (f) => f.path === "SCHEMA.md" && /SCHEMA\.md is missing/.test(f.message),
    sentence: () => "There is no SCHEMA.md: the brain needs it to know the wiki's rules and tags.",
    fix: { id: "create-schema", label: "Create SCHEMA.md" },
  },
  {
    id: "taxonomy-missing",
    match: (f) => /no tag taxonomy found/.test(f.message),
    sentence: () => "SCHEMA.md has no tag taxonomy, so the tags of the pages cannot be checked.",
    fix: { id: "add-taxonomy", label: "Add the tag taxonomy section" },
  },
  {
    id: "tags-unknown",
    match: (f) => /^tags not in the SCHEMA\.md taxonomy/.test(f.message),
    sentence: (n, found) => {
      const tags = unknownTags(found);
      return `${s(n, "One page uses", "{n} pages use")} tags that are not in the taxonomy (${tags.slice(0, 8).join(", ")}${tags.length > 8 ? ", …" : ""}).`;
    },
    fix: { id: "add-tags", label: "Add these tags to the taxonomy" },
  },
  { id: "tags-none", match: (f) => f.message === "no tags", sentence: (n) => `${s(n, "One page has", "{n} pages have")} no tags.` },
  {
    id: "index-missing",
    match: (f) => f.message === "index.md is missing",
    sentence: () => "There is no index.md, the wiki's table of contents.",
    fix: { id: "create-index", label: "Create index.md" },
  },
  {
    id: "index-unlisted",
    match: (f) => /^page not listed in index\.md/.test(f.message),
    sentence: (n) => `${s(n, "One page is", "{n} pages are")} not listed in index.md.`,
    fix: { id: "index-pages", label: "List them in index.md" },
  },
  { id: "index-broken", match: (f) => /^index\.md links a missing page/.test(f.message), sentence: (n) => `index.md links ${s(n, "a page", "{n} pages")} that do not exist.` },
  {
    id: "log-missing",
    match: (f) => f.message === "log.md is missing",
    sentence: () => "There is no log.md, the history of the changes.",
    fix: { id: "create-log", label: "Create log.md" },
  },
  { id: "log-order", match: (f) => f.path === "log.md", sentence: () => "Some log.md entries have no date or are out of order." },
  { id: "loose-files", match: (f) => /^file outside the page folders/.test(f.message), sentence: (n) => `${s(n, "One markdown file sits", "{n} markdown files sit")} outside the page folders and is not loaded: move it into a folder.` },
  { id: "frontmatter-missing", match: (f) => f.rule === "L2" && /missing frontmatter|frontmatter is not|invalid frontmatter/.test(f.message), sentence: (n) => `${s(n, "One page has", "{n} pages have")} no valid frontmatter (the YAML block at the top).` },
  { id: "frontmatter-fields", match: (f) => /^missing required field/.test(f.message), sentence: (n) => `${s(n, "One page misses", "{n} pages miss")} required frontmatter fields (title, created, updated, type, tags, sources).` },
  { id: "frontmatter-values", match: (f) => f.rule === "L2", sentence: (n) => `${s(n, "One page has", "{n} pages have")} a wrong type or date in the frontmatter (dates are YYYY-MM-DD).` },
  { id: "sources", match: (f) => f.rule === "L4", sentence: (n) => `${s(n, "One page cites", "{n} pages cite")} sources that are not in raw/.` },
  { id: "links-broken", match: (f) => /^broken link/.test(f.message), sentence: (n) => `${s(n, "One page has", "{n} pages have")} broken [[links]].` },
  { id: "links-few", match: (f) => /^fewer than 2 outbound links/.test(f.message), sentence: (n) => `${s(n, "One page links", "{n} pages link")} fewer than two other pages.` },
  { id: "names", match: (f) => f.rule === "L6", sentence: (n) => `${s(n, "One file has", "{n} files have")} a name or place that breaks the conventions (lowercase-with-hyphens, unique names).` },
  { id: "long", match: (f) => /lines: over/.test(f.message), sentence: (n) => `${s(n, "One page is", "{n} pages are")} very long: consider splitting.` },
  { id: "stubs", match: (f) => /possible stub/.test(f.message), sentence: (n) => `${s(n, "One page is", "{n} pages are")} very short (under 80 words).` },
  { id: "secrets", match: (f) => f.rule === "L10", sentence: (n) => `${s(n, "One page may contain", "{n} pages may contain")} a secret: sessions see it redacted when "Hide secrets" is on.` },
  { id: "directives", match: (f) => f.rule === "L12", sentence: (n) => `${s(n, "One page contains", "{n} pages contain")} text that looks like instructions to an AI: check it.` },
];

/** Group the lint findings into sentences, errors first. */
export function explainLint(report: LintReport): LintView {
  const groups = new Map<string, { rule: Rule | null; found: LintFinding[] }>();
  for (const f of report.findings) {
    const rule = RULES.find((r) => r.match(f)) ?? null;
    const key = rule?.id ?? `${f.rule}:${f.message}`;
    const g = groups.get(key) ?? { rule, found: [] };
    g.found.push(f);
    groups.set(key, g);
  }
  const advice: LintAdvice[] = [...groups.entries()].map(([id, { rule, found }]) => ({
    id,
    level: found.some((f) => f.level === "error") ? "error" : "warn",
    sentence: rule ? rule.sentence(found.length, found) : `${found[0].path}: ${found[0].message}${found.length > 1 ? ` (and ${found.length - 1} more)` : ""}`,
    paths: [...new Set(found.map((f) => f.path))].slice(0, 20),
    count: found.length,
    ...(rule?.fix ? { fix: rule.fix } : {}),
  }));
  advice.sort((a, b) => (a.level === b.level ? (a.fix ? 0 : 1) - (b.fix ? 0 : 1) : a.level === "error" ? -1 : 1));
  return { ok: report.errors === 0, errors: report.errors, warnings: report.warnings, pages: report.pages, advice };
}

// ── Before adoption ─────────────────────────────────────────────────────────

export type AdoptCheck = { ok: false; error: string } | { ok: true; path: string; ready: boolean; advice: LintAdvice[] };

/**
 * A folder offered for "Adopt existing folder": it must exist; SCHEMA.md and
 * index.md must be at its root before the brain can start (each missing one
 * comes with its fix). `ready` = the brain can be created.
 */
export function checkAdoptFolder(value: unknown): AdoptCheck {
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "The wiki folder is required" };
  const path = absoluteDir(value);
  if (!path) return { ok: false, error: "The wiki folder must be an absolute path (or start with ~/)" };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: `${path} is not a folder` };
  } catch {
    return { ok: false, error: `The folder ${path} does not exist` };
  }
  const findings: LintFinding[] = [];
  if (!existsSync(join(path, "SCHEMA.md"))) findings.push({ rule: "L7", level: "error", path: "SCHEMA.md", message: "SCHEMA.md is missing" });
  if (!existsSync(join(path, "index.md"))) findings.push({ rule: "L7", level: "error", path: "index.md", message: "index.md is missing" });
  const view = explainLint({ findings, errors: findings.length, warnings: 0, pages: 0 });
  return { ok: true, path, ready: findings.length === 0, advice: view.advice };
}

// ── Fixes ───────────────────────────────────────────────────────────────────

/** What a fix may need besides the wiki folder. */
export interface FixContext {
  /** The brain's name and about text (a new SCHEMA.md). */
  name?: string;
  about?: string;
  /** The wiki's pages (from the brain), for index lines and the taxonomy. */
  pages?: { slug: string; title: string; tags: string[] }[];
  /** The current lint findings (tags and pages to add). */
  findings?: LintFinding[];
  now?: Date;
}

const TAXONOMY_RE = /^##\s+(?:Tag Taxonomy|Taxonomy|Tags|Tassonomia dei tag)\b/im;

function createFile(dir: string, name: string, text: string): string {
  try {
    writeFileSync(join(dir, name), text, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return `${name} already exists: left as it is`;
    throw e;
  }
  return `${name} created`;
}

function indexLine(p: { slug: string; title: string }): string {
  const title = p.title.replace(/[\r\n]+/g, " ").trim();
  return `- [[${p.slug}]]${title && title !== p.slug ? ` — ${title}` : ""}`;
}

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf-8");
}

/** Append text to a file, on a line of its own. */
function appendBlock(dir: string, name: string, block: string): void {
  const cur = read(dir, name);
  appendFileSync(join(dir, name), `${cur.endsWith("\n") || cur === "" ? "" : "\n"}${block}`);
}

/**
 * Apply one fix to the wiki folder `dir`. Returns what was done, in a
 * sentence. Only creates files or adds text.
 */
export function applyLintFix(dir: string, fix: LintFixId, ctx: FixContext = {}): string {
  const date = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  const pageTags = normalizeTags((ctx.pages ?? []).flatMap((p) => p.tags));
  switch (fix) {
    case "create-schema": {
      const tpl = wikiTemplate({ name: ctx.name ?? "Wiki", about: ctx.about ?? "", tags: pageTags.length ? pageTags : DEFAULT_TAGS, date });
      return createFile(dir, "SCHEMA.md", tpl["SCHEMA.md"]);
    }
    case "create-index": {
      const lines = (ctx.pages ?? []).map(indexLine);
      return createFile(dir, "index.md", ["# Index", "", "## Start Here", "", ...(lines.length ? lines : ["No pages listed yet."]), ""].join("\n"));
    }
    case "create-log":
      return createFile(dir, "log.md", ["# Log", "", "Append-only history of the wiki, oldest first.", "", `## [${date}] adopt | Wiki adopted by a Companion brain`, "", "- log.md created by Companion's guided check.", ""].join("\n"));
    case "add-taxonomy": {
      if (TAXONOMY_RE.test(read(dir, "SCHEMA.md"))) return "SCHEMA.md already has a tag taxonomy: left as it is";
      const tags = pageTags.length ? pageTags : DEFAULT_TAGS;
      appendBlock(dir, "SCHEMA.md", `\n## Tag Taxonomy\n\n- ${tags.join(", ")}\n`);
      return `Tag taxonomy added to SCHEMA.md (${tags.length} tags)`;
    }
    case "add-tags": {
      const tags = unknownTags(ctx.findings ?? []);
      if (!tags.length) return "No tags to add";
      const schema = read(dir, "SCHEMA.md");
      const m = TAXONOMY_RE.exec(schema);
      if (!m) return applyLintFix(dir, "add-taxonomy", ctx);
      // The new line goes at the end of the taxonomy section, before the next "## " heading.
      const after = schema.slice(m.index + m[0].length);
      const next = after.search(/\n##\s/);
      const at = next < 0 ? schema.length : m.index + m[0].length + next;
      const before = schema.slice(0, at).replace(/\n*$/, "\n");
      writeFileSync(join(dir, "SCHEMA.md"), `${before}- ${tags.join(", ")}\n${schema.slice(at)}`);
      return `Added ${tags.length} tag${tags.length === 1 ? "" : "s"} to the taxonomy: ${tags.join(", ")}`;
    }
    case "index-pages": {
      const slugs = unlistedPages(ctx.findings ?? []);
      if (!slugs.length) return "Every page is already in index.md";
      const bySlug = new Map((ctx.pages ?? []).map((p) => [p.slug, p]));
      const lines = slugs.map((slug) => indexLine(bySlug.get(slug) ?? { slug, title: "" }));
      const index = read(dir, "index.md");
      const lastHeading = [...index.matchAll(/^##\s+(.+)$/gm)].pop()?.[1]?.trim();
      appendBlock(dir, "index.md", `${lastHeading === "Other pages" ? "" : "\n## Other pages\n\n"}${lines.join("\n")}\n`);
      return `Listed ${slugs.length} page${slugs.length === 1 ? "" : "s"} in index.md (under "Other pages")`;
    }
  }
}

export function isLintFix(value: unknown): value is LintFixId {
  return typeof value === "string" && (LINT_FIXES as readonly string[]).includes(value);
}
