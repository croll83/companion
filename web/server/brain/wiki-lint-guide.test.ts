import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Guided lint for adopted wikis. The findings come from the brain's REAL
 * lint (the core is imported here, in a test only): the sentences must
 * match what the core reports, so a change of its wording breaks this test
 * rather than silently losing a fix. Validates that the one-click fixes make
 * the problems go away, and that they are ADDITIVE only: every byte of the
 * user's files is still there afterwards, existing files are never
 * overwritten. Temp folders only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { applyLintFix, checkAdoptFolder, explainLint, isLintFix, unknownTags, unlistedPages, type LintReport } from "./wiki-lint-guide.js";
import { loadWiki } from "./core/wiki.js";
import { lintWiki } from "./core/lint.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lint-guide-"));
  h.home = join(dir, "companion");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function page(rel: string, tags: string[], links: string[]): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  const body = `# ${rel}\n\n${links.map((l) => `See [[${l}]].`).join(" ")} ${"Words of a real page. ".repeat(20)}`;
  writeFileSync(join(dir, rel), `---\ntitle: ${rel.split("/").pop()!.replace(".md", "")}\ncreated: 2026-10-01\nupdated: 2026-10-02\ntype: concept\ntags: [${tags.join(", ")}]\nsources: [https://example.org]\n---\n${body}\n`);
}

/** A wiki kept by hand: pages, an index that lists one of them, a schema without taxonomy, no log. */
function messyWiki(): void {
  writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n\n## Domain\nMy notes.\n");
  writeFileSync(join(dir, "index.md"), "# Index\n\n## Start Here\n- [[alpha]]\n");
  page("concepts/alpha.md", ["boats"], ["beta", "gamma"]);
  page("concepts/beta.md", ["boats", "engines"], ["alpha", "gamma"]);
  page("concepts/gamma.md", ["engines"], ["alpha", "beta"]);
}

const lint = (): LintReport => lintWiki(loadWiki(dir));
const pages = () => [...loadWiki(dir).pages.values()].map((p) => ({ slug: p.slug, title: p.title, tags: p.tags }));

describe("explainLint", () => {
  it("turns the core's findings into grouped sentences with fixes, errors first", () => {
    messyWiki();
    const view = explainLint(lint());
    expect(view.ok).toBe(false);
    const byId = Object.fromEntries(view.advice.map((a) => [a.id, a]));
    expect(byId["taxonomy-missing"]).toMatchObject({ level: "error", fix: { id: "add-taxonomy", label: "Add the tag taxonomy section" } });
    expect(byId["index-unlisted"]).toMatchObject({ count: 2, sentence: "2 pages are not listed in index.md.", fix: { id: "index-pages" } });
    expect(byId["log-missing"]).toMatchObject({ level: "warn", fix: { id: "create-log", label: "Create log.md" } });
    expect(view.advice[0].level).toBe("error");
    expect(view.advice.at(-1)!.level).toBe("warn");
  });

  it("names unknown tags, groups by kind, and keeps unknown findings readable", () => {
    const report: LintReport = {
      errors: 3,
      warnings: 1,
      pages: 2,
      findings: [
        { rule: "L3", level: "error", path: "a.md", message: "tags not in the SCHEMA.md taxonomy: boats, engines" },
        { rule: "L3", level: "error", path: "b.md", message: "tags not in the SCHEMA.md taxonomy: sails" },
        { rule: "L5", level: "error", path: "a.md", message: "broken link: [[nope]]" },
        { rule: "L99", level: "warn", path: "c.md", message: "something new" },
      ],
    };
    const view = explainLint(report);
    expect(view.advice.find((a) => a.id === "tags-unknown")).toMatchObject({ count: 2, sentence: "2 pages use tags that are not in the taxonomy (boats, engines, sails).", paths: ["a.md", "b.md"], fix: { id: "add-tags" } });
    expect(view.advice.find((a) => a.id === "links-broken")?.sentence).toBe("One page has broken [[links]].");
    expect(view.advice.find((a) => a.id === "L99:something new")?.sentence).toBe("c.md: something new");
    expect(unknownTags(report.findings)).toEqual(["boats", "engines", "sails"]);
    expect(unlistedPages([{ rule: "L7", level: "error", path: "index.md", message: "page not listed in index.md: [[x/y]]" }])).toEqual(["x/y"]);
    expect(isLintFix("add-tags")).toBe(true);
    expect(isLintFix("rm -rf")).toBe(false);
  });
});

describe("applyLintFix", () => {
  it("fixes a messy wiki to clean, only adding to the user's files", () => {
    messyWiki();
    const schemaBefore = readFileSync(join(dir, "SCHEMA.md"), "utf8");
    const indexBefore = readFileSync(join(dir, "index.md"), "utf8");
    const now = new Date("2026-10-14T09:00:00Z");

    expect(applyLintFix(dir, "add-taxonomy", { pages: pages(), now })).toBe("Tag taxonomy added to SCHEMA.md (2 tags)");
    expect(applyLintFix(dir, "add-taxonomy", { pages: pages() })).toMatch(/already has a tag taxonomy/);
    expect(applyLintFix(dir, "index-pages", { pages: pages(), findings: lint().findings })).toBe('Listed 2 pages in index.md (under "Other pages")');
    expect(applyLintFix(dir, "create-log", { now })).toBe("log.md created");
    expect(applyLintFix(dir, "create-log", { now })).toMatch(/already exists/);

    expect(lint().findings).toEqual([]);
    expect(readFileSync(join(dir, "SCHEMA.md"), "utf8").startsWith(schemaBefore)).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8").startsWith(indexBefore)).toBe(true);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toMatch(/## Other pages\n\n- \[\[beta\]\]\n- \[\[gamma\]\]\n$/);
    expect(applyLintFix(dir, "index-pages", { findings: lint().findings })).toBe("Every page is already in index.md");
  });

  it("adds unknown tags inside the existing taxonomy section", () => {
    messyWiki();
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n\n## Tag Taxonomy\n- boats\n\n## Conventions\nRules.\n");
    const before = readFileSync(join(dir, "SCHEMA.md"), "utf8");
    expect(applyLintFix(dir, "add-tags", { findings: lint().findings })).toBe("Added 1 tag to the taxonomy: engines");
    const after = readFileSync(join(dir, "SCHEMA.md"), "utf8");
    expect(after).toBe("# Schema\n\n## Tag Taxonomy\n- boats\n- engines\n\n## Conventions\nRules.\n");
    for (const line of before.split("\n")) expect(after.split("\n")).toContain(line);
    expect(lint().findings.filter((f) => f.rule === "L3")).toEqual([]);
    expect(applyLintFix(dir, "add-tags", { findings: [] })).toBe("No tags to add");
    // No taxonomy section yet: the section is added instead.
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    expect(applyLintFix(dir, "add-tags", { pages: pages(), findings: [{ rule: "L3", level: "error", path: "a", message: "tags not in the SCHEMA.md taxonomy: x" }] })).toMatch(/Tag taxonomy added/);
  });

  it("creates SCHEMA.md and index.md for adoption, never over an existing file", () => {
    writeFileSync(join(dir, "index.md"), "mine\n");
    expect(applyLintFix(dir, "create-index", { pages: [{ slug: "a", title: "A page", tags: [] }] })).toMatch(/already exists/);
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("mine\n");
    rmSync(join(dir, "index.md"));
    expect(applyLintFix(dir, "create-index", { pages: [{ slug: "a", title: "A page", tags: [] }] })).toBe("index.md created");
    expect(readFileSync(join(dir, "index.md"), "utf8")).toContain("- [[a]] — A page");
    rmSync(join(dir, "index.md"));
    applyLintFix(dir, "create-index");
    expect(readFileSync(join(dir, "index.md"), "utf8")).toContain("No pages listed yet.");
    expect(applyLintFix(dir, "create-schema", { name: "Boat", about: "The boat." })).toBe("SCHEMA.md created");
    expect(readFileSync(join(dir, "SCHEMA.md"), "utf8")).toMatch(/^# Boat: schema[\s\S]*## Domain\n\nThe boat\./);
  });
});

describe("checkAdoptFolder", () => {
  it("reports what blocks the brain, with fixes, until the folder is ready", () => {
    let c = checkAdoptFolder(dir);
    expect(c).toMatchObject({ ok: true, path: dir, ready: false });
    expect(c.ok && c.advice.map((a) => a.fix?.id)).toEqual(["create-schema", "create-index"]);
    applyLintFix(dir, "create-schema");
    applyLintFix(dir, "create-index");
    c = checkAdoptFolder(dir);
    expect(c).toMatchObject({ ok: true, ready: true, advice: [] });
  });

  it("refuses what is not an existing absolute folder", () => {
    expect(checkAdoptFolder("")).toEqual({ ok: false, error: "The wiki folder is required" });
    expect(checkAdoptFolder("rel/x")).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
    expect(checkAdoptFolder(join(dir, "nope"))).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    writeFileSync(join(dir, "f"), "x");
    expect(checkAdoptFolder(join(dir, "f"))).toMatchObject({ ok: false, error: expect.stringMatching(/is not a folder/) });
  });
});
