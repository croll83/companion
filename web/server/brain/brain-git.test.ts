import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { brainOwner, gitAuthor, gitStatus, resetBrainOwnerForTest, runGit, setGitBinaryForTest } from "./brain-git.js";

/**
 * git for the brains. Validates that runs collect their output and never
 * throw (a missing git is reported, not crashed on: the "New brain" wizard
 * shows a blocking card), that a hung git is killed by the timeout, and that
 * the owner and author come from the user's git identity with the fallbacks
 * the design asks for ("Companion" for commits, the OS login for the owner)
 * instead of a bare Unix name. The git config is a temp file
 * (GIT_CONFIG_GLOBAL), never the user's.
 */

let tmp: string;
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-git-"));
  process.env.GIT_CONFIG_GLOBAL = join(tmp, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  resetBrainOwnerForTest();
});

afterEach(() => {
  setGitBinaryForTest("git");
  resetBrainOwnerForTest();
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("runGit", () => {
  it("collects stdout and the exit code", async () => {
    const r = await runGit(["--version"], tmp);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
    expect(await gitStatus()).toMatchObject({ available: true, version: expect.stringMatching(/^git version/) });
  });

  it("reports a failing command with its stderr", async () => {
    const r = await runGit(["rev-parse", "HEAD"], tmp);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a git repository/i);
  });

  it("reports a missing git instead of throwing", async () => {
    setGitBinaryForTest(join(tmp, "no-such-git"));
    const r = await runGit(["--version"], tmp);
    expect(r).toMatchObject({ code: null, missing: true });
    expect(await gitStatus()).toEqual({ available: false });
  });

  it("kills a git that hangs, after the timeout", async () => {
    const slow = join(tmp, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(slow, 0o755);
    setGitBinaryForTest(slow);
    const started = Date.now();
    const r = await runGit(["status"], tmp, 100);
    expect(r.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("identity", () => {
  it("authors commits as the user's git identity, else Companion", async () => {
    expect(await gitAuthor()).toEqual({ name: "Companion", email: "companion@localhost" });
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = Marco Monaco\n\temail = marco@example.org\n");
    expect(await gitAuthor()).toEqual({ name: "Marco Monaco", email: "marco@example.org" });
  });

  it("names the owner from git user.name, else the OS login, once per process", () => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = Marco Monaco\n");
    expect(brainOwner()).toBe("Marco Monaco");
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "");
    expect(brainOwner()).toBe("Marco Monaco"); // cached
    resetBrainOwnerForTest();
    expect(brainOwner()).toBe(userInfo().username);
    resetBrainOwnerForTest();
    setGitBinaryForTest(join(tmp, "no-such-git"));
    expect(brainOwner()).toBe(userInfo().username);
  });
});
