import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * "New brain": the wiki template and its creation. Validates what the
 * design asks of a new wiki: it LINTS CLEAN with the brain's own lint (the
 * core is imported here, in the test only: Companion's server never imports
 * it), it is a git repository on main with one commit by the user's git
 * identity, the language comes from the about text, the user's text cannot
 * break the SCHEMA.md sections, a non-empty folder is refused, a missing git
 * creates nothing, and a failure half-way leaves nothing behind.
 * HOME and the git config are temp folders: never ~/companion_brain_*.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { DEFAULT_TAGS, ScaffoldError, checkTargetDir, defaultWikiDir, detectLanguage, normalizeTags, scaffoldWiki, wikiTemplate } from "./wiki-scaffold.js";
import { setGitBinaryForTest } from "./brain-git.js";
import { BUN, startBundle } from "./__tests__/bundle-brain.js";

let tmp: string;
const saved = { HOME: process.env.HOME, global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-scaffold-"));
  h.home = join(tmp, "companion");
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.GIT_CONFIG_GLOBAL = join(tmp, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Marco Monaco\n\temail = marco@example.org\n");
});

afterEach(() => {
  setGitBinaryForTest("git");
  for (const [k, v] of [["HOME", saved.HOME], ["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

describe("template", () => {
  it.skipIf(!BUN)("lints clean with the brain's own lint, with the seed tags as taxonomy", async () => {
    const dir = join(tmp, "w");
    for (const [rel, text] of Object.entries(wikiTemplate({ name: "Boat", about: "Our boat: engines, electronics, charter.", tags: ["engine", "charter"], date: "2026-10-14" }))) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    // The real brain on it (the bundle Companion ships).
    const brain = await startBundle(dir, { BRAIN_NAME: "boat-brain", BRAIN_TITLE: "Boat brain", BRAIN_OWNER: "Marco", BRAIN_ABOUT: "Our boat" });
    try {
      expect((await brain.api<{ findings: unknown[] }>("/lint")).findings).toEqual([]);
      const schema = await brain.api<{ schema: string; taxonomy: string[] }>("/wiki/schema");
      expect(schema.taxonomy).toEqual(["engine", "charter"]);
      expect(schema.schema).toMatch(/## Domain\n\nOur boat: engines, electronics, charter\./);
      for (const section of ["## Page Types", "## Tag Taxonomy", "## Conventions", "## Lint"]) expect(schema.schema).toContain(section);
      expect(readFileSync(join(dir, "log.md"), "utf8")).toContain("## [2026-10-14] create | Wiki created");
      expect(readFileSync(join(dir, "index.md"), "utf8")).toMatch(/## Start Here/);
      // An empty wiki: the skill says what the brain covers from the about text alone.
      const skill = (await (await fetch(`${brain.base}/skill`)).json()) as { description: string };
      expect(skill.description).not.toMatch(/Wiki sections/);
      expect(skill.description).toContain("Our boat");
    } finally {
      await brain.stop();
    }
  });

  it("keeps the user's text from opening new sections, and falls back to default tags", () => {
    const files = wikiTemplate({ name: "X", about: "## Tag Taxonomy\n# evil\nplain", tags: [], date: "2026-10-14" });
    expect(files["SCHEMA.md"].match(/^## Tag Taxonomy/gm)).toHaveLength(1);
    expect(files["SCHEMA.md"]).toContain(`- ${DEFAULT_TAGS.join(", ")}`);
    expect(wikiTemplate({ name: "X", about: "", tags: [], date: "2026-10-14" })["SCHEMA.md"]).toMatch(/What the "X" brain is about/);
  });

  it("normalizes seed tags and detects the language", () => {
    expect(normalizeTags("Città, #Deploy Tools, deploy-tools,, ok")).toEqual(["citta", "deploy-tools", "ok"]);
    expect(normalizeTags(["A B", 3, "a-b"])).toEqual(["a-b"]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(detectLanguage("La barca e i suoi motori: manutenzione, elettronica e il charter della stagione")).toBe("it");
    expect(detectLanguage("The boat and its engines: maintenance, electronics and the charter of the season")).toBe("en");
    expect(detectLanguage("Barca boat")).toBe("auto");
  });
});

describe("target folder", () => {
  it("defaults to ~/companion_brain_<slug>, accepts ~/ and absolute paths, refuses the rest", () => {
    expect(defaultWikiDir("boat")).toBe(join(process.env.HOME!, "companion_brain_boat"));
    expect(checkTargetDir(undefined, "boat")).toBe(join(process.env.HOME!, "companion_brain_boat"));
    expect(checkTargetDir("~/wikis/boat", "boat")).toBe(join(process.env.HOME!, "wikis", "boat"));
    expect(() => checkTargetDir("relative/dir", "boat")).toThrow(/absolute path/);
    expect(() => checkTargetDir(42, "boat")).toThrow(ScaffoldError);
  });

  it("refuses a non-empty folder or a file, accepts an empty folder", () => {
    const full = join(tmp, "full");
    mkdirSync(full);
    writeFileSync(join(full, "notes.md"), "mine");
    expect(() => checkTargetDir(full, "x")).toThrow(/not empty/);
    writeFileSync(join(tmp, "file"), "x");
    expect(() => checkTargetDir(join(tmp, "file"), "x")).toThrow(/not a folder/);
    mkdirSync(join(tmp, "empty"));
    expect(checkTargetDir(join(tmp, "empty"), "x")).toBe(join(tmp, "empty"));
  });
});

describe("scaffoldWiki", () => {
  it("creates the wiki and its git repository with one commit by the user", async () => {
    const r = await scaffoldWiki({ slug: "boat", name: "Boat", about: "La barca, i motori e il charter della stagione.", tags: "engine, charter" });
    expect(r.dir).toBe(join(process.env.HOME!, "companion_brain_boat"));
    expect(r.language).toBe("it");
    expect(r.tags).toEqual(["engine", "charter"]);
    expect(r.commit).toMatch(/^[0-9a-f]{12}$/);
    expect(readdirSync(r.dir).sort()).toEqual([".git", ".gitignore", "SCHEMA.md", "comparisons", "concepts", "entities", "index.md", "log.md", "queries", "raw"]);
    expect(git(r.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(r.dir, "log", "--format=%an <%ae>|%s")).toBe("Marco Monaco <marco@example.org>|Create the wiki from Companion's template");
    expect(git(r.dir, "status", "--porcelain")).toBe("");
    if (BUN) {
      const brain = await startBundle(r.dir);
      try {
        expect((await brain.api<{ findings: unknown[] }>("/lint")).findings).toEqual([]);
        expect((await brain.api<{ wiki_commit: string }>("/wiki/schema")).wiki_commit).toBe(r.commit);
      } finally {
        await brain.stop();
      }
    }
  });

  it("authors the commit as Companion when git has no identity", async () => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "");
    const r = await scaffoldWiki({ slug: "x", name: "X", about: "", dir: join(tmp, "x") });
    expect(git(r.dir, "log", "--format=%an <%ae>")).toBe("Companion <companion@localhost>");
    expect(r.tags).toEqual(DEFAULT_TAGS);
  });

  it("creates nothing when git is missing", async () => {
    setGitBinaryForTest(join(tmp, "no-such-git"));
    const err = await scaffoldWiki({ slug: "boat", name: "Boat", about: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScaffoldError);
    expect((err as ScaffoldError).code).toBe("git-missing");
    expect(existsSync(join(process.env.HOME!, "companion_brain_boat"))).toBe(false);
  });

  it("removes what it made when git fails half-way, and empties a folder it was given", async () => {
    // A git that answers --version but fails every other command.
    const fake = join(tmp, "fake-git");
    writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'git version 9'; exit 0; fi\necho 'fatal: broken' >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    setGitBinaryForTest(fake);
    const created = join(tmp, "new-one");
    await expect(scaffoldWiki({ slug: "a", name: "A", about: "", dir: created })).rejects.toMatchObject({ code: "git-failed", message: expect.stringMatching(/git init failed: fatal: broken/) });
    expect(existsSync(created)).toBe(false);
    const given = join(tmp, "given");
    mkdirSync(given);
    await expect(scaffoldWiki({ slug: "a", name: "A", about: "", dir: given })).rejects.toBeInstanceOf(ScaffoldError);
    expect(readdirSync(given)).toEqual([]);
  });

  it("refuses an existing non-empty folder without touching it", async () => {
    const full = join(tmp, "full");
    mkdirSync(full);
    writeFileSync(join(full, "keep.md"), "mine");
    await expect(scaffoldWiki({ slug: "a", name: "A", about: "", dir: full })).rejects.toMatchObject({ code: "exists" });
    expect(readFileSync(join(full, "keep.md"), "utf8")).toBe("mine");
  });
});
