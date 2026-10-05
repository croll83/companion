import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { SessionState } from "./session-types.js";

function runGitCommand(state: SessionState, command: string): string {
  return execSync(command, {
    cwd: state.cwd,
    encoding: "utf-8",
    timeout: 3000,
  }).trim();
}

export function resolveSessionGitInfo(state: SessionState): void {
  if (!state.cwd) return;
  try {
    state.git_branch = runGitCommand(state, "git rev-parse --abbrev-ref HEAD 2>/dev/null");

    try {
      const gitDir = runGitCommand(state, "git rev-parse --git-dir 2>/dev/null");
      state.is_worktree = gitDir.includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      if (state.is_worktree) {
        const commonDir = runGitCommand(state, "git rev-parse --git-common-dir 2>/dev/null");
        state.repo_root = resolve(state.cwd, commonDir, "..");
      } else {
        state.repo_root = runGitCommand(state, "git rev-parse --show-toplevel 2>/dev/null");
      }
    } catch {
      // Ignore repo root resolution failures
    }

    try {
      const counts = runGitCommand(
        state,
        "git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null",
      );
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      state.git_ahead = ahead || 0;
      state.git_behind = behind || 0;
    } catch {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch {
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
}
