import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { absoluteDir, type BrainLanguage } from "./brain-store.js";
import { gitAuthor, runGit } from "./brain-git.js";

/**
 * "New brain": a new wiki folder from Companion's template, ready for an
 * embedded brain (design §6). The folder, by default ~/companion_brain_<slug>,
 * gets:
 *
 *  - SCHEMA.md: Domain (the user's "what it is about"), Page Types, Tag
 *    Taxonomy (the seed tags), Conventions (frontmatter, [[links]], sources in
 *    raw/, no secrets) and Lint;
 *  - index.md with "## Start Here", log.md with a first `create` entry;
 *  - raw/, entities/, concepts/, comparisons/, queries/ (each with a
 *    .gitkeep, so git keeps them), and a .gitignore;
 *  - a git repository on `main` with one commit, authored with the user's git
 *    identity (or "Companion").
 *
 * The template lints clean with the brain's own lint (tested by loading the
 * result with the core in wiki-scaffold.test.ts). git is required: without
 * it nothing is created and the caller gets `git-missing`. An existing folder
 * is used only when empty; a folder this function created is removed again
 * when a later step fails.
 */

export type ScaffoldErrorCode = "invalid" | "exists" | "git-missing" | "git-failed";

export class ScaffoldError extends Error {
  code: ScaffoldErrorCode;
  constructor(code: ScaffoldErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Tags of a new wiki when the user gives none. */
export const DEFAULT_TAGS = ["overview", "procedure", "decision", "reference"];
const MAX_TAGS = 40;
const PAGE_DIRS = ["entities", "concepts", "comparisons", "queries"];

/** The default folder of a new brain's wiki: ~/companion_brain_<slug>. */
export function defaultWikiDir(slug: string): string {
  return join(homedir(), `companion_brain_${slug}`);
}

const IT_WORDS = new Set("il lo la gli le di del della dei delle che per con una uno sono non come anche questo questa nel nella sul sulla tra fra dove quando perché più".split(" "));
const EN_WORDS = new Set("the of and to in is for with that this are on as by from it its how what which where when our your about".split(" "));

/**
 * The language of the wiki from the about text, for search stemming: "it" or
 * "en" when the text clearly is, else "auto" (both forms indexed).
 */
export function detectLanguage(text: string): BrainLanguage {
  let it = 0;
  let en = 0;
  for (const w of text.toLowerCase().normalize("NFC").split(/[^a-zàèéìòù']+/)) {
    if (IT_WORDS.has(w)) it++;
    if (EN_WORDS.has(w)) en++;
  }
  if (it >= 2 && it >= en * 2) return "it";
  if (en >= 2 && en >= it * 2) return "en";
  return "auto";
}

/** Seed tags from the user (a list, or one comma/space separated string): lowercase-hyphen, unique. */
export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? value.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = t
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The user's text inside a markdown file: no heading lines (they would start new sections). */
function asParagraph(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\s*#+\s*/gm, "").trim();
}

export interface WikiTemplateInput {
  name: string;
  about: string;
  tags: string[];
  date: string;
}

/** The files of a new wiki, by path. */
export function wikiTemplate({ name, about, tags, date }: WikiTemplateInput): Record<string, string> {
  const title = name.replace(/[\r\n]+/g, " ").trim();
  const domain = asParagraph(about) || `What the "${title}" brain is about (write it here).`;
  const seed = tags.length ? tags : DEFAULT_TAGS;
  const files: Record<string, string> = {
    "SCHEMA.md": [
      `# ${title}: schema`,
      "",
      "How this wiki is organised. The brain server reads this file: the tag taxonomy below is the list of tags pages may use, and its lint applies the rules.",
      "",
      "## Domain",
      "",
      domain,
      "",
      "## Page Types",
      "",
      "- entity (entities/): something that exists: a system, a service, a host, a product, an organisation",
      "- concept (concepts/): an idea, a procedure, how something works",
      "- comparison (comparisons/): options side by side, with a recommendation",
      "- query (queries/): the answer to a question worth keeping",
      "- summary: the summary of one source",
      "",
      "## Tag Taxonomy",
      "",
      `- ${seed.join(", ")}`,
      "",
      "Add a tag here before a page uses it.",
      "",
      "## Conventions",
      "",
      "- Every page starts with YAML frontmatter: `title`, `created` and `updated` (YYYY-MM-DD), `type`, `tags` (from the taxonomy), `sources`.",
      "- File names are lowercase words separated by hyphens (for example `concepts/deploy-procedure.md`) and unique in the wiki.",
      "- Pages link each other as `[[slug]]`: each page links at least two others and is listed in `index.md`.",
      "- Sources live in `raw/` and are never edited: list them in `sources` and cite them in the text as `^[raw/<path>]`.",
      "- No secrets (passwords, tokens, keys) and no personal data: write where a secret lives, never its value.",
      "- `log.md` is append-only: one `## [YYYY-MM-DD] <action> | <subject>` entry per change.",
      "",
      "## Lint",
      "",
      "The brain checks: frontmatter fields and dates; tags in the taxonomy; sources that exist; no broken links and at least two outbound links per page; lowercase-hyphen file names; every page listed in `index.md`; dated log entries.",
      "",
    ].join("\n"),
    "index.md": [
      `# ${title}: index`,
      "",
      "## Start Here",
      "",
      "No pages yet. Each page gets a line here: `- [[slug]] — one-line summary`.",
      "",
    ].join("\n"),
    "log.md": [
      "# Log",
      "",
      "Append-only history of the wiki, oldest first.",
      "",
      `## [${date}] create | Wiki created`,
      "",
      `- Created by Companion from its template for the brain "${title}".`,
      "",
    ].join("\n"),
    ".gitignore": [".DS_Store", ".obsidian/workspace*.json", ".trash/", "*.swp", ""].join("\n"),
  };
  for (const d of ["raw", ...PAGE_DIRS]) files[`${d}/.gitkeep`] = "";
  return files;
}

export interface ScaffoldInput {
  slug: string;
  name: string;
  about: string;
  tags?: unknown;
  /** Absolute or ~/ path; default ~/companion_brain_<slug>. */
  dir?: unknown;
  now?: Date;
}

export interface ScaffoldResult {
  dir: string;
  language: BrainLanguage;
  tags: string[];
  commit: string;
}

/** The target folder: absolute, and missing or empty. */
export function checkTargetDir(value: unknown, slug: string): string {
  const dir = value === undefined || value === null || (typeof value === "string" && !value.trim())
    ? defaultWikiDir(slug)
    : typeof value === "string" ? absoluteDir(value) : null;
  if (!dir) throw new ScaffoldError("invalid", "The wiki folder must be an absolute path (or start with ~/)");
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ScaffoldError("exists", `${dir} exists and is not a folder`);
    if (readdirSync(dir).length > 0) {
      throw new ScaffoldError("exists", `${dir} already exists and is not empty: choose another folder, or adopt it as an existing wiki`);
    }
  }
  return dir;
}

/** Create the wiki folder, its files and its git repository with the first commit. */
export async function scaffoldWiki(input: ScaffoldInput): Promise<ScaffoldResult> {
  const dir = checkTargetDir(input.dir, input.slug);
  const version = await runGit(["--version"], homedir(), 5000);
  if (version.code !== 0) throw new ScaffoldError("git-missing", "git is not installed: a new wiki is a git repository");
  const tags = normalizeTags(input.tags);
  const now = input.now ?? new Date();
  const created = !existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(wikiTemplate({ name: input.name, about: input.about, tags, date: now.toISOString().slice(0, 10) }))) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text, { flag: "wx" });
    }
    const author = await gitAuthor();
    const git = async (args: string[]) => {
      const r = await runGit(args, dir);
      if (r.code !== 0) throw new ScaffoldError("git-failed", `git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return r.stdout.trim();
    };
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "-A"]);
    await git([
      "-c", `user.name=${author.name}`,
      "-c", `user.email=${author.email}`,
      "-c", "commit.gpgsign=false",
      "commit", "-q", "--no-verify", "-m", "Create the wiki from Companion's template",
    ]);
    const commit = await git(["rev-parse", "--short=12", "HEAD"]);
    return { dir, language: detectLanguage(input.about), tags: tags.length ? tags : DEFAULT_TAGS, commit };
  } catch (err) {
    // Leave nothing half-made: the folder was ours (missing or empty before).
    if (created) rmSync(dir, { recursive: true, force: true });
    else for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
    if (err instanceof ScaffoldError) throw err;
    throw new ScaffoldError("git-failed", `The wiki could not be created: ${(err as Error).message}`);
  }
}
