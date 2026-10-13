// Read-only snapshot of the wiki folder: pages, raw sources, taxonomy and log,
// parsed from the files. SCHEMA.md is the single source of the tag taxonomy:
// nothing here hard-codes the list of tags.
//
// The loader is tolerant: the wiki is written by an agent and by hand (e.g. in
// Obsidian), so a page without frontmatter, with broken YAML, with spaces in
// its name or with the same file name as another page is still loaded; lint
// reports the problem. Only a missing SCHEMA.md stops the load (wrong folder).
//
// Layout (see SCHEMA.md of the wiki):
// - every top-level folder except raw/, archive/, _archive/ and hidden or
//   "_"-prefixed ones holds pages (entities/, concepts/, comparisons/,
//   queries/, or any other topic folder), recursively;
// - SCHEMA.md, index.md, log.md, README.md at the root are navigation files;
// - other loose files at the root are not loaded (listed in `ignored`);
// - a page folder with its own SCHEMA.md is a sub-wiki: its pages follow that
//   schema, so the root rules on frontmatter and index are not applied to them.

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export const NAV_FILES = ["SCHEMA.md", "index.md", "log.md", "README.md"] as const;
/** Top-level folders that never hold pages. */
export const EXCLUDED_DIRS = new Set(["raw", "archive", "_archive", "node_modules"]);
/** Folders that map to a page type (SCHEMA.md "Page Types"). */
export const TYPE_DIRS: Record<string, string> = { entity: "entities", concept: "concepts", comparison: "comparisons", query: "queries" };
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAV_STEMS = new Set(["schema", "index", "log", "readme"]);
const MAX_RAW_BYTES = 2_000_000;
const MAX_PAGE_BYTES = 5_000_000;

export interface Page {
  /** File name without .md; path without .md when that name is not unique or is a navigation name. */
  slug: string;
  dir: string;
  path: string;
  /** Top-level folder with its own SCHEMA.md, if the page belongs to a sub-wiki. */
  subwiki: string | null;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  status: string;
  contested: boolean;
  contradictions: string[];
  created: string | null;
  updated: string | null;
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  /** Full file text (frontmatter included). */
  text: string;
  body: string;
  links: string[];
  words: number;
  lines: number;
}

export interface RawSource {
  path: string;
  bytes: number;
  /** null for binary or oversized files: listed, never returned as text. */
  text: string | null;
}

export interface LogEntry {
  heading: string;
  date: string;
  body: string;
  /** Position in log.md (0 = first entry in the file). */
  position: number;
}

export interface WikiSnapshot {
  root: string;
  commit: string;
  /** Hash of everything loaded: changes also when edits are not committed yet. */
  contentHash: string;
  loadedAt: string;
  pages: Map<string, Page>;
  /** Lower-cased slug, path (without .md) and unique file name → slug, for link resolution. */
  aliases: Map<string, string>;
  nav: Map<string, string>;
  raw: Map<string, RawSource>;
  taxonomy: Set<string>;
  log: LogEntry[];
  /** Files present in the wiki but not loaded (loose files at the root, "_"-prefixed files). */
  ignored: string[];
  /** Problems found while loading (unreadable files, duplicate names): reported by lint. */
  loadIssues: { path: string; message: string }[];
}

function normalizeText(t: string): string {
  return t.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  const t = normalizeText(text);
  const open = /^---[ \t]*\n/.exec(t);
  if (!open) return { raw: null, body: t };
  const close = /\n---[ \t]*(?:\n|$)/.exec(t.slice(open[0].length - 1));
  if (!close) return { raw: null, body: t };
  const start = open[0].length;
  const end = open[0].length - 1 + close.index;
  return { raw: t.slice(start, Math.max(start, end)), body: t.slice(end + close[0].length) };
}

/** Text without fenced code blocks and inline code: what Obsidian renders as prose. */
export function stripCode(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "").replace(/`[^`\n]*`/g, "");
}

/** [[target]], [[target|alias]], [[target#heading]], [[target\|alias]] (in tables); embeds ![[...]] are not links. */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of stripCode(body).matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    if (m[1] === "!") continue;
    const target = m[2].split(/\\?\||#/)[0].replace(/\\$/, "").trim();
    if (target) out.add(target);
  }
  return [...out];
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
  if (typeof v === "string") return v.trim() ? [v] : [];
  return [];
}

export function dateStr(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

/** Parse one page. `rel` is the path from the wiki root, e.g. concepts/overview.md. */
export function parsePage(rel: string, text: string, slug = rel.split("/").pop()!.replace(/\.md$/i, ""), subwiki: string | null = null): Page {
  const { raw, body } = splitFrontmatter(text);
  let fm: Record<string, unknown> | null = null;
  let fmError: string | null = raw === null ? "missing frontmatter" : null;
  if (raw !== null) {
    try {
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
      else fmError = "frontmatter is not a YAML mapping";
    } catch (e) {
      fmError = `invalid frontmatter YAML: ${(e as Error).message.split("\n")[0]}`;
    }
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const contradictions = asStringList(fm?.contradictions);
  const slash = rel.lastIndexOf("/");
  return {
    slug,
    dir: slash < 0 ? "" : rel.slice(0, slash),
    path: rel,
    subwiki,
    title: typeof fm?.title === "string" && fm.title.trim() ? fm.title.trim() : heading ?? slug,
    type: typeof fm?.type === "string" ? fm.type.trim() : "",
    tags: asStringList(fm?.tags).map((t) => t.trim().replace(/^#/, "")),
    sources: asStringList(fm?.sources).map((s) => s.trim()),
    status: typeof fm?.status === "string" ? fm.status : "",
    contested: fm?.contested === true || contradictions.length > 0,
    contradictions,
    created: dateStr(fm?.created),
    updated: dateStr(fm?.updated),
    frontmatter: fm,
    frontmatterError: fmError,
    text: normalizeText(text),
    body,
    links: extractLinks(body),
    words: body.split(/\s+/).filter(Boolean).length,
    lines: body.split("\n").length,
  };
}

/**
 * Tags from the taxonomy section of SCHEMA.md ("## Tag Taxonomy", or the
 * Italian "## Tassonomia dei tag"). Accepts list items with comma-separated
 * tags ("- wiki, knowledge-base") and table rows with a backticked tag.
 * Returns an empty set when there is no such section: lint reports it.
 */
export function parseTaxonomy(schema: string): Set<string> {
  const section = parseSection(normalizeText(schema), /^##\s+(?:Tag Taxonomy|Taxonomy|Tags|Tassonomia dei tag)\b/im);
  const tags = new Set<string>();
  for (const line of section.split("\n")) {
    const row = /^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|/.exec(line);
    if (row) {
      tags.add(row[1]);
      continue;
    }
    const item = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!item) continue;
    for (const part of item[1].replace(/^\*\*[^*]+\*\*:?\s*/, "").split(",")) {
      const t = part.replace(/[`*]/g, "").trim();
      if (/^[a-z0-9][a-z0-9-]*$/.test(t)) tags.add(t);
    }
  }
  return tags;
}

/** The "## <title>" section of a markdown file (up to the next "## "), or "". */
export function parseSection(md: string, title: string | RegExp): string {
  const re = typeof title === "string" ? new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im") : title;
  const m = re.exec(md);
  if (!m) return "";
  const rest = md.slice(m.index);
  const next = rest.slice(3).search(/\n##\s/);
  return (next < 0 ? rest : rest.slice(0, next + 3)).trim();
}

/** Entries of log.md: every "## " heading outside code blocks. The date is the first YYYY-MM-DD in the heading. */
export function parseLog(log: string): LogEntry[] {
  const parts = stripFences(normalizeText(log)).split(/^(?=## )/m).slice(1);
  return parts.map((p, position) => {
    const nl = p.indexOf("\n");
    const heading = (nl < 0 ? p : p.slice(0, nl)).replace(/^## /, "").trim();
    const date = /(\d{4}-\d{2}-\d{2})/.exec(heading)?.[1] ?? "";
    return { heading, date, body: (nl < 0 ? "" : p.slice(nl + 1)).replace(/\n---\s*$/, "").trim(), position };
  });
}

function stripFences(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "");
}

/** The most recent log entries, newest first, whether the log is appended or prepended. */
export function recentLog(entries: LogEntry[], n: number): LogEntry[] {
  return entries
    .filter((e) => e.date)
    .sort((a, b) => (a.date === b.date ? b.position - a.position : a.date < b.date ? 1 : -1))
    .slice(0, n);
}

function hidden(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_");
}

function walk(dir: string, rel: string, out: string[], skipDirs: (name: string) => boolean, depth = 0): void {
  if (depth > 12) return; // symlink loops, absurd nesting
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const r = rel ? `${rel}/${name}` : name;
    if (st.isDirectory()) {
      if (!skipDirs(name)) walk(full, r, out, skipDirs, depth + 1);
    } else if (st.isFile()) out.push(r);
  }
}

function isText(full: string, bytes: number): boolean {
  if (bytes > MAX_RAW_BYTES) return false;
  const fd = openSync(full, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, 8192));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** HEAD of the wiki's own git repository; "no-git" when the folder is not the top of a repository. */
function gitCommit(root: string): string {
  try {
    const [top, head] = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel", "--short=12", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n");
    return realpathSync(top) === realpathSync(root) ? head : "no-git";
  } catch {
    return "no-git";
  }
}

export function resolvePage(w: Pick<WikiSnapshot, "pages" | "aliases">, name: string): Page | undefined {
  const k = name.trim().replace(/^\[\[|\]\]$/g, "").replace(/\.md$/i, "").replace(/^\.?\//, "");
  return w.pages.get(k) ?? w.pages.get(w.aliases.get(k.toLowerCase()) ?? "\0");
}

/** Build slugs and aliases for a set of page paths. */
export function assignSlugs(paths: string[]): { slugs: Map<string, string>; aliases: Map<string, string>; duplicates: string[] } {
  const stemCount = new Map<string, number>();
  const stem = (p: string) => p.split("/").pop()!.replace(/\.md$/i, "");
  for (const p of paths) stemCount.set(stem(p).toLowerCase(), (stemCount.get(stem(p).toLowerCase()) ?? 0) + 1);
  const slugs = new Map<string, string>();
  const aliases = new Map<string, string>();
  const duplicates: string[] = [];
  for (const p of paths) {
    const s = stem(p);
    const unique = stemCount.get(s.toLowerCase()) === 1 && !NAV_STEMS.has(s.toLowerCase());
    const slug = unique ? s : p.replace(/\.md$/i, "");
    if (!unique && !NAV_STEMS.has(s.toLowerCase())) duplicates.push(p);
    slugs.set(p, slug);
    aliases.set(slug.toLowerCase(), slug);
    aliases.set(p.replace(/\.md$/i, "").toLowerCase(), slug);
    if (unique) aliases.set(s.toLowerCase(), slug);
  }
  return { slugs, aliases, duplicates };
}

export function loadWiki(root: string, now: () => Date = () => new Date()): WikiSnapshot {
  const hash = createHash("sha256");
  const loadIssues: { path: string; message: string }[] = [];
  const ignored: string[] = [];

  const nav = new Map<string, string>();
  for (const f of NAV_FILES) {
    try {
      nav.set(f, normalizeText(readFileSync(join(root, f), "utf8")));
    } catch {
      /* optional except SCHEMA.md, checked below */
    }
  }
  const schema = nav.get("SCHEMA.md");
  if (schema === undefined) throw new Error(`SCHEMA.md not found in ${root}: not a wiki folder`);

  // Pages: every .md under the page folders.
  const pagePaths: string[] = [];
  const subwikis = new Set<string>();
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isFile()) {
      if (name.startsWith(".") || (NAV_FILES as readonly string[]).includes(name)) continue;
      if (name.toLowerCase().endsWith(".md")) ignored.push(name);
      continue;
    }
    if (!st.isDirectory() || hidden(name) || EXCLUDED_DIRS.has(name)) continue;
    const files: string[] = [];
    walk(full, name, files, (d) => hidden(d) || d === "archive");
    for (const f of files) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      if (f.split("/").some((seg) => seg.startsWith("_"))) {
        ignored.push(f);
        continue;
      }
      pagePaths.push(f);
    }
    try {
      if (statSync(join(full, "SCHEMA.md")).isFile()) subwikis.add(name);
    } catch {
      /* not a sub-wiki */
    }
  }
  const { slugs, aliases, duplicates } = assignSlugs(pagePaths);
  for (const d of duplicates) loadIssues.push({ path: d, message: `file name ${d.split("/").pop()} is not unique: the page is addressed by its path` });
  const pages = new Map<string, Page>();
  for (const rel of pagePaths) {
    let text: string;
    try {
      if (statSync(join(root, rel)).size > MAX_PAGE_BYTES) {
        loadIssues.push({ path: rel, message: "page larger than 5 MB: not loaded" });
        continue;
      }
      text = readFileSync(join(root, rel), "utf8");
    } catch (e) {
      loadIssues.push({ path: rel, message: `unreadable: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    const top = rel.split("/")[0];
    const page = parsePage(rel, text, slugs.get(rel)!, subwikis.has(top) ? top : null);
    pages.set(page.slug, page);
    hash.update(`p\0${rel}\0${text}\0`);
  }
  for (const [f, t] of nav) hash.update(`n\0${f}\0${t}\0`);

  // Raw sources: every file under raw/, text when it looks like text.
  const raw = new Map<string, RawSource>();
  const rawFiles: string[] = [];
  walk(join(root, "raw"), "raw", rawFiles, (d) => d.startsWith("."));
  for (const rel of rawFiles) {
    const full = join(root, rel);
    try {
      const bytes = statSync(full).size;
      const text = isText(full, bytes) ? normalizeText(readFileSync(full, "utf8")) : null;
      raw.set(rel, { path: rel, bytes, text });
      hash.update(`r\0${rel}\0${bytes}\0${text ?? ""}\0`);
    } catch (e) {
      loadIssues.push({ path: rel, message: `unreadable: ${(e as Error).message.split("\n")[0]}` });
    }
  }

  return {
    root,
    commit: gitCommit(root),
    contentHash: hash.digest("hex").slice(0, 12),
    loadedAt: now().toISOString(),
    pages,
    aliases,
    nav,
    raw,
    taxonomy: parseTaxonomy(schema),
    log: parseLog(nav.get("log.md") ?? ""),
    ignored,
    loadIssues,
  };
}
