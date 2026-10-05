import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { CreationStepId } from "./session-types.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import { getConnection } from "./linear-connections.js";
import { buildLinearSystemPrompt } from "./linear-prompt-builder.js";
import { discoverCommandsAndSkills } from "./commands-discovery.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressCallback = (
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
) => Promise<void>;

export interface SessionCreationDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  worktreeTracker: WorktreeTracker;
}

export interface SessionCreationResult {
  session: SdkSessionInfo;
}

export class SessionCreationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly step?: CreationStepId,
  ) {
    super(message);
    this.name = "SessionCreationError";
  }
}

// ---------------------------------------------------------------------------
// Helper: emit progress if a callback is provided (no-op otherwise)
// ---------------------------------------------------------------------------

async function emit(
  onProgress: ProgressCallback | undefined,
  step: CreationStepId,
  label: string,
  status: "in_progress" | "done" | "error",
  detail?: string,
): Promise<void> {
  if (onProgress) {
    await onProgress(step, label, status, detail);
  }
}

// ---------------------------------------------------------------------------
// Main service function
// ---------------------------------------------------------------------------

export async function executeSessionCreation(
  body: Record<string, unknown>,
  deps: SessionCreationDeps,
  onProgress?: ProgressCallback,
): Promise<SessionCreationResult> {
  const { launcher, wsBridge, worktreeTracker } = deps;

  // -- Parse input --
  const resumeSessionAt =
    typeof body.resumeSessionAt === "string" && (body.resumeSessionAt as string).trim()
      ? (body.resumeSessionAt as string).trim()
      : undefined;
  const forkSession = body.forkSession === true;
  const backend = (body.backend as string) ?? "claude";
  if (backend !== "claude" && backend !== "codex") {
    throw new SessionCreationError(`Invalid backend: ${String(backend)}`, 400);
  }

  // -- Step: Resolve environment --
  await emit(onProgress, "resolving_env", "Resolving environment...", "in_progress");

  let envVars: Record<string, string> | undefined = body.env as Record<string, string> | undefined;
  const companionEnv = body.envSlug ? envManager.getEnv(body.envSlug as string) : null;
  if (body.envSlug && companionEnv) {
    console.log(
      `[session-creation] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
      Object.keys(companionEnv.variables).join(", "),
    );
    envVars = { ...companionEnv.variables, ...(body.env as Record<string, string>) };
  } else if (body.envSlug) {
    console.warn(`[session-creation] Environment "${body.envSlug}" not found, ignoring`);
  }

  // Inject LINEAR_API_KEY if a Linear connection is specified
  let linearSystemPrompt: string | undefined;
  if (body.linearConnectionId) {
    const conn = getConnection(body.linearConnectionId as string);
    if (conn?.apiKey) {
      envVars = { ...envVars, LINEAR_API_KEY: conn.apiKey };
      linearSystemPrompt = buildLinearSystemPrompt(conn, body.linearIssue as Parameters<typeof buildLinearSystemPrompt>[1]);
    }
  }

  await emit(onProgress, "resolving_env", "Environment resolved", "done");

  // -- Step: Git operations --
  let cwd = body.cwd as string | undefined;
  let worktreeInfo: {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
  } | undefined;

  // Validate branch name
  if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch as string)) {
    throw new SessionCreationError("Invalid branch name", 400, "checkout_branch");
  }

  if (body.useWorktree && body.branch && cwd) {
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      await emit(onProgress, "fetching_git", "Fetching from remote...", "in_progress");
      const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
      if (!fetchResult.success) {
        console.warn(`[session-creation] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
      await emit(onProgress, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

      await emit(onProgress, "creating_worktree", "Creating worktree...", "in_progress");
      const result = gitUtils.ensureWorktree(repoInfo.repoRoot, body.branch as string, {
        baseBranch: repoInfo.defaultBranch,
        createBranch: body.createBranch as boolean | undefined,
        forceNew: true,
      });
      cwd = result.worktreePath;
      worktreeInfo = {
        isWorktree: true,
        repoRoot: repoInfo.repoRoot,
        branch: body.branch as string,
        actualBranch: result.actualBranch,
        worktreePath: result.worktreePath,
      };
      await emit(onProgress, "creating_worktree", "Worktree ready", "done");
    }
  } else if (body.branch && cwd) {
    const repoInfo = gitUtils.getRepoInfo(cwd);
    if (repoInfo) {
      await emit(onProgress, "fetching_git", "Fetching from remote...", "in_progress");
      const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
      if (!fetchResult.success) {
        console.warn(`[session-creation] git fetch failed (non-fatal): ${fetchResult.output}`);
      }
      await emit(onProgress, "fetching_git", fetchResult.success ? "Fetch complete" : "Fetch skipped (offline?)", "done");

      if (repoInfo.currentBranch !== body.branch) {
        await emit(onProgress, "checkout_branch", `Checking out ${body.branch}...`, "in_progress");
        gitUtils.checkoutOrCreateBranch(repoInfo.repoRoot, body.branch as string, {
          createBranch: body.createBranch as boolean | undefined,
          defaultBranch: repoInfo.defaultBranch,
        });
        await emit(onProgress, "checkout_branch", `On branch ${body.branch}`, "done");
      }

      await emit(onProgress, "pulling_git", "Pulling latest changes...", "in_progress");
      const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
      if (!pullResult.success) {
        console.warn(`[session-creation] git pull warning (non-fatal): ${pullResult.output}`);
      }
      await emit(onProgress, "pulling_git", "Up to date", "done");
    }
  }

  // -- Step: Launch CLI --
  await emit(
    onProgress,
    "launching_cli",
    `Launching ${backend === "codex" ? "Codex" : "Claude Code"}...`,
    "in_progress",
  );

  let session: SdkSessionInfo;
  try {
    session = launcher.launch({
      model: body.model as string | undefined,
      permissionMode: body.permissionMode as string | undefined,
      cwd,
      claudeBinary: body.claudeBinary as string | undefined,
      codexBinary: body.codexBinary as string | undefined,
      codexInternetAccess: backend === "codex",
      codexSandbox: backend === "codex" ? "danger-full-access" : undefined,
      allowedTools: body.allowedTools as string[] | undefined,
      env: envVars,
      backendType: backend,
      resumeSessionAt,
      forkSession,
      systemPrompt: backend === "codex" ? linearSystemPrompt : undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SessionCreationError(
      `Failed to launch CLI: ${reason}`,
      503,
      "launching_cli",
    );
  }

  // -- Post-launch tracking --
  if (worktreeInfo) {
    worktreeTracker.addMapping({
      sessionId: session.sessionId,
      repoRoot: worktreeInfo.repoRoot,
      branch: worktreeInfo.branch,
      actualBranch: worktreeInfo.actualBranch,
      worktreePath: worktreeInfo.worktreePath,
      createdAt: Date.now(),
    });
  }

  if (linearSystemPrompt && backend === "claude") {
    wsBridge.injectSystemPrompt(session.sessionId, linearSystemPrompt);
  }

  const discovered = await discoverCommandsAndSkills(cwd).catch(() => ({
    slash_commands: [] as string[],
    skills: [] as string[],
  }));
  wsBridge.prePopulateCommands(session.sessionId, discovered.slash_commands, discovered.skills);

  await emit(onProgress, "launching_cli", "Session started", "done");

  return { session };
}
