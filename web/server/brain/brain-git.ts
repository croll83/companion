import { execFileSync, spawn } from "node:child_process";
import { userInfo } from "node:os";

/**
 * git for the brains: the initial commit of a new wiki (wiki-scaffold.ts) and
 * the name of the brain's owner (BRAIN_OWNER of an embedded brain).
 *
 * Every git run drains stdout and stderr to the end (never a pipe left
 * unread: see the product rules in CLAUDE.md), has a timeout, and never
 * prompts (GIT_TERMINAL_PROMPT=0, stdin ignored). Messages are in English
 * (LC_ALL=C): they reach the page as they are.
 */

export interface GitRun {
  /** Exit code; null when git could not be run (missing, or killed by the timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** git is not installed (ENOENT). */
  missing?: boolean;
}

/** The git binary: overridable in tests to simulate a machine without git. */
let gitBinary = "git";

export function setGitBinaryForTest(bin: string): void {
  gitBinary = bin;
}

/** Run git with `args` in `cwd`, collecting its output. Never throws. */
export function runGit(args: string[], cwd: string, timeoutMs = 20_000): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(gitBinary, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
    } catch (err) {
      resolve({ code: null, stdout, stderr: (err as Error).message, missing: (err as NodeJS.ErrnoException).code === "ENOENT" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message, missing: err.code === "ENOENT" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Whether git can be run, and its version line ("git version 2.43.0"). */
export async function gitStatus(): Promise<{ available: boolean; version?: string }> {
  const r = await runGit(["--version"], process.cwd(), 5000);
  return r.code === 0 ? { available: true, version: r.stdout.trim() } : { available: false };
}

/** `git config --get <key>` from the user's global config; undefined when unset or git is missing. */
async function gitConfig(key: string): Promise<string | undefined> {
  const r = await runGit(["config", "--get", key], process.cwd(), 5000);
  const v = r.code === 0 ? r.stdout.trim() : "";
  return v || undefined;
}

/** The author of a new wiki's first commit: the user's git identity, else "Companion". */
export async function gitAuthor(): Promise<{ name: string; email: string }> {
  return {
    name: (await gitConfig("user.name")) ?? "Companion",
    email: (await gitConfig("user.email")) ?? "companion@localhost",
  };
}

let ownerCache: string | undefined;

/**
 * Whose knowledge base an embedded brain is (BRAIN_OWNER): `git config
 * user.name`, else the OS login name. Read once per process,
 * synchronously (the supervisor builds the child's environment synchronously);
 * stdout is read to the end and stderr ignored.
 */
export function brainOwner(): string {
  if (ownerCache !== undefined) return ownerCache;
  let name = "";
  try {
    name = execFileSync(gitBinary, ["config", "--get", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    /* unset, or no git */
  }
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      /* no passwd entry */
    }
  }
  ownerCache = (name || process.env.USER || "the user").replace(/[\r\n]+/g, " ").slice(0, 80);
  return ownerCache;
}

export function resetBrainOwnerForTest(): void {
  ownerCache = undefined;
}
