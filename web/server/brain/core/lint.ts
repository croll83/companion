// brain lint: the rules of the wiki's SCHEMA.md applied by code, served by the
// HTTP API (GET /api/v1/lint, and on a draft page with POST /api/v1/lint/page
// before a curator job writes it).
//
// Rules (levels follow the wording of SCHEMA.md: "must"/"every" is an error,
// guidance is a warning):
//   L2  frontmatter: present, valid YAML, required fields, type, ISO dates
//   L3  tags: at least one, every tag in the taxonomy of SCHEMA.md
//   L4  provenance: sources and ^[raw/...] markers resolve
//   L5  links: no broken [[links]], at least 2 outbound links
//   L6  naming and placement: lowercase-hyphen file names, unique names, type folder
//   L7  navigation: index.md lists every page, log.md entries are dated and in order
//   L8  length: split pages over ~200 lines (unless a *-quickref companion exists)
//   L10 possible secret in a page (warning: some wikis keep secrets on purpose)
//   L12 text that looks like an instruction aimed at an LLM
// Pages of a sub-wiki (a folder with its own SCHEMA.md) are checked only for
// L5 broken links, L10 and L12.

import { extractLinks, resolvePage, TYPE_DIRS, SLUG_RE, type Page, type WikiSnapshot } from "./wiki.js";
import { findSecrets } from "./redact.js";

export type Level = "error" | "warn";

export interface Finding {
  rule: string;
  level: Level;
  path: string;
  message: string;
}

const TYPES = ["entity", "concept", "comparison", "query", "summary"];
const REQUIRED = ["title", "created", "updated", "type", "tags", "sources"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MARKER_RE = /\^\[([^\]]+)\]/g;
const MAX_LINES = 200;
const LLM_DIRECTIVE =
  /\b(ignore (all |any )?(previous|prior|above) instructions|ignora (le |tutte le )?(istruzioni|regole) (precedenti|sopra)|you are now|disregard (the|your) (rules|instructions))\b|<\/?(system|instructions)>/i;

function markerPaths(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MARKER_RE)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      // "^[raw/...]" written as an example of the syntax is not a citation.
      if (p.startsWith("raw/") && !p.includes("...") && !p.includes("…")) out.push(p);
    }
  }
  return out;
}

function sourceResolves(src: string, w: WikiSnapshot): "raw" | "ok" | "missing-raw" | "unknown" {
  let s = src;
  if (s.startsWith("/")) {
    // An absolute path inside the wiki folder (e.g. /home/me/wiki/concepts/x.md): keep the part from a wiki folder on.
    const segs = s.split("/");
    const i = segs.findIndex((seg, k) => k > 0 && (seg === "raw" || w.pages.has(segs.slice(k).join("/").replace(/\.md$/i, "")) || [...w.pages.values()].some((p) => p.path === segs.slice(k).join("/"))));
    if (i > 0) s = segs.slice(i).join("/");
  }
  if (s.startsWith("raw/")) return w.raw.has(s) ? "raw" : "missing-raw";
  if (/^https?:\/\//.test(s)) return "ok";
  if (resolvePage(w, s)) return "ok";
  if (w.nav.has(s)) return "ok";
  return "unknown";
}

function lintPage(p: Page, w: WikiSnapshot, out: Finding[]): void {
  const f = (rule: string, level: Level, message: string) => out.push({ rule, level, path: p.path, message });
  const linked = new Set<string>();
  for (const l of p.links) {
    const target = resolvePage(w, l);
    if (target) linked.add(target.slug);
    else if (!w.nav.has(l) && !w.nav.has(`${l}.md`)) f("L5", "error", `broken link: [[${l}]]`);
  }
  for (const s of findSecrets(p.text)) f("L10", "warn", `possible secret in the page (${s.rule}): redacted on MCP reads when BRAIN_REDACT_SECRETS=true`);
  if (LLM_DIRECTIVE.test(p.body)) f("L12", "warn", "text that looks like an instruction aimed at an LLM: check it");
  if (p.subwiki) return;

  // L2 frontmatter
  if (p.frontmatterError || !p.frontmatter) {
    f("L2", "error", p.frontmatterError ?? "missing frontmatter");
  } else {
    const fm = p.frontmatter;
    for (const k of REQUIRED) if (fm[k] === undefined || fm[k] === null || fm[k] === "") f("L2", "error", `missing required field: ${k}`);
    if (fm.type !== undefined && !TYPES.includes(String(fm.type))) f("L2", "error", `invalid type: ${String(fm.type)} (${TYPES.join(", ")})`);
    for (const [k, v] of [["created", p.created], ["updated", p.updated]] as const) {
      if (fm[k] !== undefined && fm[k] !== null && (!v || !ISO_DATE.test(v))) f("L2", "error", `${k} is not an ISO date (YYYY-MM-DD)`);
    }
    if (p.created && p.updated && ISO_DATE.test(p.created) && ISO_DATE.test(p.updated) && p.updated < p.created) f("L2", "error", "updated is before created");
    for (const c of p.contradictions) if (!resolvePage(w, c)) f("L2", "warn", `contradictions names an unknown page: ${c}`);

    // L3 tags
    if (p.tags.length === 0) f("L3", "error", "no tags");
    if (w.taxonomy.size > 0) {
      const outside = p.tags.filter((t) => !w.taxonomy.has(t));
      if (outside.length) f("L3", "error", `tags not in the SCHEMA.md taxonomy: ${outside.join(", ")}`);
    }

    // L4 provenance
    for (const s of p.sources) {
      const r = sourceResolves(s, w);
      if (r === "missing-raw") f("L4", "error", `source not found in raw/: ${s}`);
      else if (r === "unknown") f("L4", "warn", `source is neither a raw/ file, a wiki page nor a URL: ${s}`);
    }
  }
  const declared = new Set(p.sources);
  for (const m of new Set(markerPaths(p.body))) {
    if (!w.raw.has(m)) f("L4", "error", `marker ^[${m}] points to a missing source`);
    else if (!declared.has(m)) f("L4", "warn", `source cited in the text but not in sources: ${m}`);
  }

  // L5 at least two outbound links
  linked.delete(p.slug);
  if (linked.size < 2) f("L5", "error", `fewer than 2 outbound links to existing pages (${linked.size})`);

  // L6 naming and placement
  const file = p.path.split("/").pop()!.replace(/\.md$/i, "");
  if (!SLUG_RE.test(file)) f("L6", "error", `file name is not lowercase-with-hyphens: ${file}`);
  if (p.slug.includes("/") && !/\/(index|log|schema|readme)$/i.test(p.slug)) f("L6", "error", `file name ${file}.md is used by more than one page`);
  const expected = TYPE_DIRS[p.type];
  const top = p.path.split("/")[0];
  if (expected && Object.values(TYPE_DIRS).includes(top) && top !== expected) f("L6", "warn", `type ${p.type} is usually in ${expected}/, not ${top}/`);

  // L8 length
  if (p.lines > MAX_LINES && !w.pages.has(`${p.slug}-quickref`)) f("L8", "warn", `${p.lines} lines: over ~${MAX_LINES}, consider a split (or a ${p.slug}-quickref companion)`);
  if (p.words < 80) f("L8", "warn", `${p.words} words: possible stub`);
}

function lintNavigation(w: WikiSnapshot, out: Finding[]): void {
  const index = w.nav.get("index.md");
  if (index === undefined) out.push({ rule: "L7", level: "error", path: "index.md", message: "index.md is missing" });
  const indexed = new Set<string>();
  for (const l of index ? extractLinks(index) : []) {
    const p = resolvePage(w, l);
    if (p) indexed.add(p.slug);
    else out.push({ rule: "L7", level: "error", path: "index.md", message: `index.md links a missing page: [[${l}]]` });
  }
  if (index !== undefined) {
    for (const p of w.pages.values()) {
      if (!p.subwiki && !indexed.has(p.slug)) out.push({ rule: "L7", level: "error", path: "index.md", message: `page not listed in index.md: [[${p.slug}]]` });
    }
  }
  if (w.nav.get("log.md") === undefined) out.push({ rule: "L7", level: "warn", path: "log.md", message: "log.md is missing" });
  let seenDated = false;
  for (const e of w.log) {
    if (e.date) seenDated = true;
    else if (seenDated) out.push({ rule: "L7", level: "warn", path: "log.md", message: `log entry without a date: ## ${e.heading.slice(0, 80)}` });
  }
  const dates = w.log.map((e) => e.date).filter(Boolean);
  if (dates.length > 1) {
    const ascending = dates[0] <= dates[dates.length - 1];
    for (let i = 1; i < dates.length; i++) {
      if (ascending ? dates[i] < dates[i - 1] : dates[i] > dates[i - 1]) {
        out.push({ rule: "L7", level: "warn", path: "log.md", message: `entries out of chronological order (${dates[i - 1]} then ${dates[i]})` });
        break;
      }
    }
  }
  for (const f of w.ignored) out.push({ rule: "L7", level: "warn", path: f, message: "file outside the page folders: not loaded (move it into a folder, or to _archive/)" });
  if (w.taxonomy.size === 0) out.push({ rule: "L3", level: "error", path: "SCHEMA.md", message: "no tag taxonomy found (section '## Tag Taxonomy')" });
  for (const i of w.loadIssues) out.push({ rule: "L6", level: "warn", path: i.path, message: i.message });
}

export interface LintReport {
  commit: string;
  content_hash: string;
  pages: number;
  raw: number;
  findings: Finding[];
  errors: number;
  warnings: number;
  rawSecretFiles: number;
  rawDirectiveFiles: number;
}

/** Page-level rules for the given pages (by slug): used on drafts. */
export function lintPages(w: WikiSnapshot, slugs: string[]): Finding[] {
  const out: Finding[] = [];
  for (const slug of slugs) {
    const p = w.pages.get(slug);
    if (p) lintPage(p, w, out);
    else out.push({ rule: "L6", level: "error", path: slug, message: "page not found" });
  }
  return out;
}

export function lintWiki(w: WikiSnapshot): LintReport {
  const findings: Finding[] = [];
  for (const p of w.pages.values()) lintPage(p, w, findings);
  lintNavigation(w, findings);
  // Raw sources are immutable: secrets and directives there are only counted.
  let rawSecretFiles = 0;
  let rawDirectiveFiles = 0;
  for (const r of w.raw.values()) {
    if (r.text === null) continue;
    if (findSecrets(r.text).length) rawSecretFiles++;
    if (LLM_DIRECTIVE.test(r.text)) rawDirectiveFiles++;
  }
  return {
    commit: w.commit,
    content_hash: w.contentHash,
    pages: w.pages.size,
    raw: w.raw.size,
    findings,
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warn").length,
    rawSecretFiles,
    rawDirectiveFiles,
  };
}
