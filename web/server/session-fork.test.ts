import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SdkSessionInfo } from "./cli-launcher.js";
import { findCodexRolloutPath, resolveForkSource } from "./session-fork.js";

/**
 * resolveForkSource decides whether an agent "fork" run can start, and on
 * what. Everything runs against temp dirs standing in for the Claude
 * projects root and the per-session Codex homes, never the real ones.
 */

let root: string;
let claudeProjects: string;
let codexHomes: string;
let sessions: Map<string, SdkSessionInfo>;
const launcher = { getSession: (id: string) => sessions.get(id) };

function addSession(info: Partial<SdkSessionInfo> & { sessionId: string }): SdkSessionInfo {
  const full: SdkSessionInfo = { state: "exited", cwd: root, createdAt: 1, ...info };
  sessions.set(full.sessionId, full);
  return full;
}

function writeClaudeTranscript(cliSessionId: string): void {
  const dir = join(claudeProjects, "-work-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cliSessionId}.jsonl`), "{}\n");
}

function writeCodexRollout(sessionId: string, threadId: string, date = "2026/09/08"): string {
  const dir = join(codexHomes, sessionId, "sessions", date);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-08T20-03-54-${threadId}.jsonl`);
  writeFileSync(file, "{}\n");
  return file;
}

const opts = () => ({ codexHome: codexHomes, claudeProjectsRoot: claudeProjects });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-fork-test-"));
  claudeProjects = join(root, "claude-projects");
  codexHomes = join(root, "codex-home");
  mkdirSync(claudeProjects, { recursive: true });
  sessions = new Map();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveForkSource", () => {
  // The happy Claude path: the launcher gets the source transcript id (for
  // --resume <id> --fork-session) and the run goes to the source's folder.
  it("describes a Claude source whose transcript is on disk", () => {
    addSession({ sessionId: "src", backendType: "claude", cliSessionId: "cli-1", cwd: root });
    writeClaudeTranscript("cli-1");

    expect(resolveForkSource(launcher, "src", "claude", opts())).toEqual({
      ok: true,
      cwd: root,
      source: { sessionId: "src", cliSessionId: "cli-1" },
    });
  });

  // The happy Codex path: the rollout file is located in the SOURCE session's
  // own CODEX_HOME, so the launcher can copy it into the new session's home.
  it("describes a Codex source with the path of its rollout", () => {
    addSession({ sessionId: "src", backendType: "codex", cliSessionId: "thread-1" });
    const rollout = writeCodexRollout("src", "thread-1");

    expect(resolveForkSource(launcher, "src", "codex", opts())).toEqual({
      ok: true,
      cwd: root,
      source: { sessionId: "src", cliSessionId: "thread-1", rolloutPath: rollout },
    });
  });

  // Each refusal must say why, because it becomes the failed run's error.
  it("explains every reason a source cannot be forked", () => {
    expect(resolveForkSource(launcher, undefined, "claude", opts())).toEqual({ ok: false, error: "No source session to fork is set" });
    expect(resolveForkSource(launcher, "missing", "claude", opts())).toMatchObject({ ok: false, error: expect.stringContaining("no longer exists") });

    addSession({ sessionId: "codex-src", backendType: "codex", cliSessionId: "t" });
    expect(resolveForkSource(launcher, "codex-src", "claude", opts())).toMatchObject({
      ok: false,
      error: expect.stringContaining("is a Codex session; a Claude Code agent cannot fork it"),
    });

    addSession({ sessionId: "fresh", backendType: "claude" });
    expect(resolveForkSource(launcher, "fresh", "claude", opts())).toMatchObject({ ok: false, error: expect.stringContaining("no conversation to fork yet") });

    addSession({ sessionId: "no-dir", backendType: "claude", cliSessionId: "cli-2", cwd: join(root, "gone") });
    writeClaudeTranscript("cli-2");
    expect(resolveForkSource(launcher, "no-dir", "claude", opts())).toMatchObject({ ok: false, error: expect.stringContaining("no longer exists") });
  });

  // "If the source session no longer has a resumable transcript, the run
  // fails with a clear error" — for both backends.
  it("refuses a source whose transcript or rollout is gone", () => {
    addSession({ sessionId: "claude-src", backendType: "claude", cliSessionId: "pruned" });
    expect(resolveForkSource(launcher, "claude-src", "claude", opts())).toMatchObject({
      ok: false,
      error: expect.stringContaining("Claude transcript pruned is not on disk"),
    });

    addSession({ sessionId: "codex-src", backendType: "codex", cliSessionId: "thread-x" });
    expect(resolveForkSource(launcher, "codex-src", "codex", opts())).toMatchObject({
      ok: false,
      error: expect.stringContaining("Codex thread thread-x has no rollout"),
    });
  });

  // Older sessions have no backendType: they are Claude sessions.
  it("treats a session without backendType as Claude", () => {
    addSession({ sessionId: "old", cliSessionId: "cli-3" });
    writeClaudeTranscript("cli-3");
    expect(resolveForkSource(launcher, "old", "claude", opts()).ok).toBe(true);
  });
});

describe("findCodexRolloutPath", () => {
  // Codex nests rollouts by date; the newest dates are searched first and
  // only rollout files of exactly this thread id match.
  it("finds the thread's rollout under sessions/YYYY/MM/DD", () => {
    writeCodexRollout("s", "other-thread", "2026/10/01");
    const wanted = writeCodexRollout("s", "the-thread", "2026/09/08");
    expect(findCodexRolloutPath(join(codexHomes, "s"), "the-thread")).toBe(wanted);
    expect(findCodexRolloutPath(join(codexHomes, "s"), "thread")).toBeNull();
  });

  it("returns null when the home has no sessions directory", () => {
    expect(findCodexRolloutPath(join(root, "nowhere"), "t")).toBeNull();
  });
});
