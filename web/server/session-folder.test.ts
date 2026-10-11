import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a session runs: the folder picked at creation (new folder inside the
 * domain, or an existing one attached as is) and the default Claude memory
 * folder a legacy session keeps when it changes folder.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { createDomain, domainDir, GLOBAL_DOMAIN } from "./domain-store.js";
import {
  claudeMemoryRoot,
  claudeProjectDirName,
  defaultClaudeMemoryDir,
  memoryAt,
  resolveNewSessionPlacement,
  validateTargetFolder,
} from "./session-folder.js";

let tmp: string;
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "session-folder-")));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

describe("Claude's default memory folder", () => {
  it("names project folders like Claude Code", () => {
    expect(claudeProjectDirName("/home/u/my repo.x")).toBe("-home-u-my-repo-x");
  });

  // Claude keys the default memory on the main repository root: a session in
  // a subfolder or a linked worktree shares the repo's memory.
  it("keys on the main repo root inside git, else on the folder", () => {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, "f"), "x");
    git(repo, "add", "f");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", join(tmp, "wt"), "-b", "wt");
    expect(claudeMemoryRoot(join(repo, "sub"))).toBe(repo);
    expect(claudeMemoryRoot(join(tmp, "wt"))).toBe(repo);
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(claudeMemoryRoot(plain)).toBe(plain);
    expect(defaultClaudeMemoryDir(join(repo, "sub"), "/p")).toBe(join("/p", claudeProjectDirName(repo), "memory"));
  });

  it("counts the notes of a memory folder", () => {
    mkdirSync(join(tmp, "mem"));
    writeFileSync(join(tmp, "mem", "a.md"), "a");
    writeFileSync(join(tmp, "mem", "MEMORY.md"), "i");
    expect(memoryAt(join(tmp, "mem"))).toEqual({ dir: join(tmp, "mem"), notes: 1 });
  });
});

describe("validateTargetFolder", () => {
  it("accepts an existing absolute folder only", () => {
    expect(validateTargetFolder(` ${tmp} `)).toEqual({ ok: true, cwd: tmp });
    expect(validateTargetFolder("")).toMatchObject({ ok: false });
    expect(validateTargetFolder(3)).toMatchObject({ ok: false });
    expect(validateTargetFolder("rel/path")).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
    expect(validateTargetFolder(join(tmp, "nope"))).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    writeFileSync(join(tmp, "file"), "x");
    expect(validateTargetFolder(join(tmp, "file"))).toMatchObject({ ok: false, error: expect.stringMatching(/Not a folder/) });
  });
});

describe("resolveNewSessionPlacement", () => {
  // The default: GLOBAL, and the cwd as given (older clients without folderMode).
  it("defaults to GLOBAL and keeps a plain cwd", () => {
    expect(resolveNewSessionPlacement({ cwd: "/somewhere" })).toEqual({ ok: true, domain: GLOBAL_DOMAIN, cwd: "/somewhere" });
    expect(resolveNewSessionPlacement({})).toEqual({ ok: true, domain: GLOBAL_DOMAIN });
    expect(existsSync(join(domainDir(GLOBAL_DOMAIN), "CLAUDE.md"))).toBe(true);
  });

  // "New folder in this domain": really created, inside the domain folder.
  it("creates a new folder inside the domain", () => {
    createDomain({ name: "Herd" });
    const res = resolveNewSessionPlacement({ domain: "herd", folderMode: "new", folderName: "Brave Falcon" });
    expect(res).toEqual({ ok: true, domain: "herd", cwd: join(domainDir("herd"), "brave-falcon"), created: true });
    expect(existsSync(join(domainDir("herd"), "brave-falcon"))).toBe(true);
    // The same name again is refused instead of silently sharing the folder.
    expect(resolveNewSessionPlacement({ domain: "herd", folderMode: "new", folderName: "brave falcon" })).toMatchObject({ ok: false, status: 409 });
    expect(resolveNewSessionPlacement({ domain: "herd", folderMode: "new", folderName: "!!" })).toMatchObject({ ok: false, status: 400 });
  });

  // "Existing folder": attached where it is (never moved).
  it("attaches an existing folder after validating it", () => {
    createDomain({ name: "Herd" });
    expect(resolveNewSessionPlacement({ domain: "herd", folderMode: "existing", cwd: tmp })).toEqual({ ok: true, domain: "herd", cwd: tmp });
    expect(resolveNewSessionPlacement({ domain: "herd", folderMode: "existing", cwd: join(tmp, "nope") })).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects unknown domains and modes", () => {
    expect(resolveNewSessionPlacement({ domain: "Bad Slug" })).toMatchObject({ ok: false, status: 400 });
    expect(resolveNewSessionPlacement({ domain: "missing" })).toMatchObject({ ok: false, status: 404 });
    expect(resolveNewSessionPlacement({ folderMode: "move" })).toMatchObject({ ok: false, status: 400 });
  });
});
