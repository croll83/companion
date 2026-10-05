import { execSync } from "node:child_process";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Hono } from "hono";
import {
  classifyConfigPath,
  collectWalkUp,
  discoverClaudeConfig,
  planNewConfigFile,
  resolveConfigContext,
  validateConfigContent,
  type ConfigContext,
  type NewConfigType,
} from "../claude-config.js";

/** Ensure a resolved path is within one of the allowed base directories.
 *  Returns the resolved absolute path, or null if it escapes all bases. */
function guardPath(raw: string, allowedBases: string[]): string | null {
  const abs = resolve(raw);
  for (const base of allowedBases) {
    if (abs === base || abs.startsWith(base + "/")) return abs;
  }
  return null;
}

function shellEscapeArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function execCaptureStdout(
  command: string,
  options: { cwd: string; encoding: "utf-8"; timeout: number },
): string {
  try {
    return execSync(command, options);
  } catch (err: unknown) {
    const maybe = err as { stdout?: Buffer | string };
    if (typeof maybe.stdout === "string") return maybe.stdout;
    if (maybe.stdout && Buffer.isBuffer(maybe.stdout)) {
      return maybe.stdout.toString("utf-8");
    }
    throw err;
  }
}

function resolveBranchDiffBases(repoRoot: string): string[] {
  const options = { cwd: repoRoot, encoding: "utf-8", timeout: 5000 } as const;

  try {
    const originHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", options).trim();
    const match = originHead.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return [`origin/${match[1]}`, match[1]];
    }
  } catch {
    // No remote HEAD ref available, fallback to common local defaults.
  }

  try {
    const branches = execSync("git branch --list main master", options).trim();
    if (branches.includes("main")) return ["main"];
    if (branches.includes("master")) return ["master"];
  } catch {
    // Ignore and use a conservative fallback below.
  }

  return ["main"];
}

export interface FsRoutesOptions {
  /** Override the [home, process.cwd()] guard of the generic /fs/* routes (tests). */
  allowedBases?: string[];
  /** Home directory holding ~/.claude and ~/.codex (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Session id -> launch cwd; anchors the project root of the config routes. */
  getSessionCwd?: (sessionId: string) => string | undefined;
}

export function registerFsRoutes(api: Hono, opts?: FsRoutesOptions): void {
  // Allowed base directories for filesystem access.
  // Requests must target paths under the user's home directory or process cwd.
  const allowedBases = () => opts?.allowedBases ?? [homedir(), process.cwd()];
  const homeDir = () => opts?.homeDir ?? homedir();

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = guardPath(rawPath, allowedBases());
    if (!basePath) return c.json({ error: "Path outside allowed directories" }, 403);
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = guardPath(rawPath, allowedBases());
    if (!basePath) return c.json({ error: "Path outside allowed directories" }, 403);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return [];
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = guardPath(filePath, allowedBases());
    if (!absPath) return c.json({ error: "Path outside allowed directories" }, 403);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read file" },
        404,
      );
    }
  });

  api.get("/fs/raw", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = guardPath(filePath, allowedBases());
    if (!absPath) return c.json({ error: "Path outside allowed directories" }, 403);
    try {
      const info = await stat(absPath);
      if (info.size > 10 * 1024 * 1024) {
        return c.json({ error: "File too large (>10MB)" }, 413);
      }
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "File not found" }, 404);
    }
    try {
      const buffer = await readFile(absPath);
      const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
        tiff: "image/tiff", tif: "image/tiff",
      };
      const contentType = mimeMap[ext] || "application/octet-stream";
      return new Response(buffer, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot read file" }, 404);
    }
  });

  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = guardPath(filePath, allowedBases());
    if (!absPath) return c.json({ error: "Path outside allowed directories" }, 403);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  api.get("/fs/diff", (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const base = c.req.query("base");
    const absPath = resolve(filePath);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: dirname(absPath),
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const relPath = execSync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim() || absPath;

      let diff = "";

      if (base === "default-branch") {
        const diffBases = resolveBranchDiffBases(repoRoot);
        for (const b of diffBases) {
          try {
            diff = execCaptureStdout(`git diff ${b} -- "${relPath}"`, {
              cwd: repoRoot,
              encoding: "utf-8",
              timeout: 5000,
            });
            break;
          } catch {
            // If a base ref is unavailable, try the next candidate.
          }
        }
      } else {
        try {
          diff = execCaptureStdout(`git diff HEAD -- "${relPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        } catch {
          // HEAD may not exist in a fresh repo with no commits; fall through to untracked handling.
        }
      }

      if (!diff.trim()) {
        const untracked = execSync(`git ls-files --others --exclude-standard -- "${relPath}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        if (untracked) {
          diff = execCaptureStdout(`git diff --no-index -- /dev/null "${absPath}"`, {
            cwd: repoRoot,
            encoding: "utf-8",
            timeout: 5000,
          });
        }
      }

      return c.json({ path: absPath, diff });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /** List all files changed vs git base (name-status), including untracked new files.
   *  base="default-branch" (default): comprehensive — committed changes on this branch vs origin
   *  plus uncommitted local changes.
   *  base="last-commit": only uncommitted changes vs HEAD plus untracked files. */
  api.get("/fs/changed-files", (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const base = c.req.query("base"); // "last-commit" | "default-branch" | undefined
    const resolvedCwd = resolve(cwd);
    try {
      const repoRoot = execSync("git rev-parse --show-toplevel", {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      // Map from abs path → status ("A", "M", "D"). Later writes win, but "A" is preserved.
      const fileMap = new Map<string, string>();

      const applyNameStatus = (nameStatus: string) => {
        for (const line of nameStatus.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split("\t");
          const statusChar = parts[0][0];
          if (statusChar === "R" && parts[2]) {
            if (!fileMap.has(join(repoRoot, parts[1]))) fileMap.set(join(repoRoot, parts[1]), "D");
            fileMap.set(join(repoRoot, parts[2]), "A");
          } else {
            const abs = join(repoRoot, parts[1] || "");
            if (!abs || abs === repoRoot) continue;
            // Preserve "A" — don't downgrade to "M"
            if (!(fileMap.get(abs) === "A" && statusChar === "M")) {
              fileMap.set(abs, statusChar);
            }
          }
        }
      };

      if (base !== "last-commit") {
        // default-branch (or unset): committed changes on this branch vs origin base
        const diffBases = resolveBranchDiffBases(repoRoot);
        for (const b of diffBases) {
          try {
            applyNameStatus(execCaptureStdout(`git diff ${shellEscapeArg(b)}...HEAD --name-status`, {
              cwd: repoRoot, encoding: "utf-8", timeout: 5000,
            }));
            break;
          } catch { /* try next */ }
        }
      }

      // Always include uncommitted changes (staged + unstaged vs HEAD)
      try {
        applyNameStatus(execCaptureStdout("git diff HEAD --name-status", {
          cwd: repoRoot, encoding: "utf-8", timeout: 5000,
        }));
      } catch { /* fresh repo */ }

      // Always include untracked files not yet staged
      try {
        const untracked = execSync("git ls-files --others --exclude-standard", {
          cwd: repoRoot, encoding: "utf-8", timeout: 5000,
        }).trim();
        for (const rel of untracked.split("\n")) {
          if (rel.trim()) {
            const abs = join(repoRoot, rel.trim());
            if (!fileMap.has(abs)) fileMap.set(abs, "A");
          }
        }
      } catch { /* ignore */ }

      const files = [...fileMap.entries()].map(([path, status]) => ({ path, status }));
      return c.json({ files });
    } catch {
      return c.json({ files: [] });
    }
  });

  /** Find CLAUDE.md files for a project (root + .claude/), from cwd up to the repo root */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const ctx = resolveConfigContext(cwd, homeDir());
    const files = await collectWalkUp(ctx.walkDirs, ["CLAUDE.md", join(".claude", "CLAUDE.md")]);
    return c.json({ cwd: ctx.cwd, files });
  });

  /** Config context of a launcher-known session (its launch cwd), or null. */
  const sessionContext = (sessionId: unknown): ConfigContext | null => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    const cwd = opts?.getSessionCwd?.(sessionId);
    return cwd ? resolveConfigContext(cwd, homeDir()) : null;
  };

  /**
   * List Claude Code / Codex config files for the session's project and user.
   * A `sessionId` known to the launcher wins over `cwd`, so the listing uses
   * the same project root the config-file routes validate against.
   */
  api.get("/fs/claude-config", async (c) => {
    const cwd = c.req.query("cwd");
    const ctx = sessionContext(c.req.query("sessionId"))
      ?? (cwd ? resolveConfigContext(cwd, homeDir()) : null);
    if (!ctx) return c.json({ error: "cwd required" }, 400);
    return c.json(await discoverClaudeConfig(ctx));
  });

  // ── Dedicated config file routes ──────────────────────────────────────
  // These bypass the generic [home, process.cwd()] guard of /fs/read and
  // /fs/write so projects outside $HOME work, but accept ONLY the known
  // config files of the session's project or of ~/.claude / ~/.codex
  // (see classifyConfigPath). The session cwd comes from the launcher, so a
  // client cannot widen the allow-list by inventing a cwd.

  api.get("/fs/config-file", async (c) => {
    const ctx = sessionContext(c.req.query("sessionId"));
    if (!ctx) return c.json({ error: "Unknown session" }, 404);
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const info = classifyConfigPath(filePath, ctx);
    if (!info) return c.json({ error: "Not a known config file for this session" }, 403);
    const absPath = resolve(filePath);
    try {
      const st = await stat(absPath);
      if (st.size > 2 * 1024 * 1024) return c.json({ error: "File too large (>2MB)" }, 413);
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content, format: info.format, readOnly: info.readOnly });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot read file" }, 404);
    }
  });

  api.put("/fs/config-file", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ctx = sessionContext(body.sessionId);
    if (!ctx) return c.json({ error: "Unknown session" }, 404);
    const { path: filePath, content } = body;
    if (typeof filePath !== "string" || !filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const info = classifyConfigPath(filePath, ctx);
    if (!info) return c.json({ error: "Not a known config file for this session" }, 403);
    if (info.readOnly) return c.json({ error: "This file is read-only" }, 403);
    const invalid = validateConfigContent(info.format, content);
    if (invalid) return c.json({ error: invalid }, 400);
    const absPath = resolve(filePath);
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot write file" }, 500);
    }
  });

  /** Create a config file from a template ("New..." in the panel). Never overwrites. */
  api.post("/fs/config-file", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ctx = sessionContext(body.sessionId);
    if (!ctx) return c.json({ error: "Unknown session" }, 404);
    const { scope, type, name } = body as { scope?: unknown; type?: unknown; name?: unknown };
    if ((scope !== "project" && scope !== "user") || typeof type !== "string") {
      return c.json({ error: "scope and type required" }, 400);
    }
    const plan = planNewConfigFile(ctx, scope, type as NewConfigType, typeof name === "string" ? name : undefined);
    if ("error" in plan) return c.json({ error: plan.error }, 400);
    try {
      await mkdir(dirname(plan.path), { recursive: true });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : "Cannot create directory" }, 500);
    }
    try {
      // "wx" fails with EEXIST instead of overwriting (it also refuses a dangling symlink).
      await writeFile(plan.path, plan.content, { encoding: "utf-8", flag: "wx" });
      return c.json({ ok: true, path: plan.path });
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "EEXIST") {
        return c.json({ error: `${plan.path} already exists` }, 409);
      }
      return c.json({ error: e instanceof Error ? e.message : "Cannot create file" }, 500);
    }
  });

  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });
}
