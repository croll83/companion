import type { Hono } from "hono";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CliLauncher } from "../cli-launcher.js";
import type { WsBridge } from "../ws-bridge.js";
import type { TerminalManager } from "../terminal-manager.js";
import { getUsageLimits } from "../usage-limits.js";
import {
  getUpdateState,
  checkForUpdate,
  isUpdateAvailable,
  setUpdateInProgress,
  FORK_REPO,
} from "../update-checker.js";
import { refreshServiceDefinition } from "../service.js";
import { getSettings } from "../settings-manager.js";
import { imagePullManager } from "../image-pull-manager.js";
import { checkHostsEntry } from "../hosts-check.js";
import { TLS_BRIDGE_HOSTNAME } from "../tls-manager.js";

/**
 * Resolve the directory where Bun stores the global install of `the-companion`.
 *
 * Bun's global install layout is `~/.bun/install/global/node_modules/<pkg>`
 * on all platforms it supports. We resolve relative to `os.homedir()` so the
 * Windows case (USERPROFILE) is handled automatically.
 *
 * Returns null when the directory does not exist — callers should surface a
 * clear error rather than silently writing files into a non-existent path.
 *
 * Exported for testing.
 */
export function resolveBunGlobalInstallDir(): string | null {
  const candidate = join(
    homedir(),
    ".bun",
    "install",
    "global",
    "node_modules",
    "the-companion",
  );
  return existsSync(candidate) ? candidate : null;
}

export function registerSystemRoutes(
  api: Hono,
  deps: {
    launcher: CliLauncher;
    wsBridge: WsBridge;
    terminalManager: TerminalManager;
    updateCheckStaleMs: number;
  },
): void {
  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = deps.wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const toEpochMs = (value: number): number => (
        value > 0 && value < 1_000_000_000_000 ? value * 1000 : value
      );
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        const resetsAtMs = toEpochMs(l.resetsAt);
        return {
          utilization: l.usedPercent,
          resets_at: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/update-check", async (c) => {
    const initialState = getUpdateState();
    const needsRefresh =
      initialState.lastChecked === 0
      || Date.now() - initialState.lastChecked > deps.updateCheckStaleMs;
    if (needsRefresh) {
      await checkForUpdate();
    }

    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update-check", async (c) => {
    await checkForUpdate();
    const state = getUpdateState();
    return c.json({
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: isUpdateAvailable(),
      isServiceMode: state.isServiceMode,
      updateInProgress: state.updateInProgress,
      lastChecked: state.lastChecked,
      channel: state.channel,
    });
  });

  api.post("/update", async (c) => {
    const state = getUpdateState();
    if (!state.isServiceMode) {
      return c.json(
        { error: "Update & restart is only available in service mode" },
        400,
      );
    }
    if (!isUpdateAvailable()) {
      return c.json({ error: "No update available" }, 400);
    }
    if (state.updateInProgress) {
      return c.json({ error: "Update already in progress" }, 409);
    }

    setUpdateInProgress(true);

    setTimeout(async () => {
      let tmpDir: string | null = null;
      try {
        const version = state.latestVersion;
        if (!version) {
          throw new Error("latestVersion is null at update time");
        }
        console.log(
          `[update] Updating the-companion to ${version} from ${FORK_REPO} GitHub release...`,
        );

        // The fork can't publish to npm (the `the-companion` package belongs
        // to the upstream project), so we download the tarball attached to the
        // GitHub release and replace the global install in-place. The asset
        // name follows the `npm pack` convention: <name>-<version>.tgz.
        const tag = `the-companion-v${version}`;
        const tarballUrl = `https://github.com/${FORK_REPO}/releases/download/${tag}/the-companion-${version}.tgz`;

        const globalDir = resolveBunGlobalInstallDir();
        if (!globalDir) {
          throw new Error(
            "Could not find Bun global install dir for the-companion at ~/.bun/install/global/node_modules/the-companion",
          );
        }

        tmpDir = mkdtempSync(join(tmpdir(), "companion-update-"));
        const tarballPath = join(tmpDir, "package.tgz");

        console.log(`[update] Downloading tarball from ${tarballUrl}`);
        const dlRes = await fetch(tarballUrl, {
          headers: { "User-Agent": "the-companion-update-checker" },
        });
        if (!dlRes.ok) {
          throw new Error(
            `download failed: HTTP ${dlRes.status} ${dlRes.statusText}`,
          );
        }
        const buf = Buffer.from(await dlRes.arrayBuffer());
        writeFileSync(tarballPath, buf);

        // `npm pack` produces a tarball with a single top-level "package/"
        // directory. We extract into a scratch dir and then swap files in.
        const extractDir = join(tmpDir, "extracted");
        mkdirSync(extractDir);
        const tarProc = Bun.spawn(
          ["tar", "xzf", tarballPath, "-C", extractDir],
          { stdout: "pipe", stderr: "pipe" },
        );
        const tarExit = await tarProc.exited;
        if (tarExit !== 0) {
          const stderr = await new Response(tarProc.stderr).text();
          throw new Error(`tar extraction failed (code ${tarExit}): ${stderr}`);
        }

        const pkgDir = join(extractDir, "package");
        if (!existsSync(pkgDir)) {
          throw new Error(`extracted tarball missing "package/" directory at ${pkgDir}`);
        }

        // Replace shipping directories. We blow away the destination first to
        // avoid stale files from previous versions (e.g. removed components).
        for (const sub of ["bin", "server", "dist"] as const) {
          const dest = join(globalDir, sub);
          const src = join(pkgDir, sub);
          rmSync(dest, { recursive: true, force: true });
          if (existsSync(src)) {
            cpSync(src, dest, { recursive: true });
          }
        }
        copyFileSync(
          join(pkgDir, "package.json"),
          join(globalDir, "package.json"),
        );

        console.log(`[update] Installed the-companion ${version} into ${globalDir}`);

        // Re-pull Docker image if auto-update is enabled
        if (getSettings().dockerAutoUpdate) {
          try {
            console.log("[update] Re-pulling Docker image (dockerAutoUpdate enabled)...");
            imagePullManager.pull("the-companion:latest");
            const ready = await imagePullManager.waitForReady("the-companion:latest", 120_000);
            if (ready) {
              console.log("[update] Docker image re-pull complete.");
            } else {
              console.warn("[update] Docker image re-pull failed or timed out, continuing with restart.");
            }
          } catch (err) {
            console.warn("[update] Docker image re-pull error, continuing:", err);
          }
        }

        try {
          refreshServiceDefinition();
          console.log("[update] Service definition refreshed.");
        } catch (err) {
          console.warn("[update] Failed to refresh service definition:", err);
        }

        console.log("[update] Update successful, restarting service...");

        const isLinux = process.platform === "linux";
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        const restartCmd = isLinux
          ? ["systemctl", "--user", "restart", "the-companion.service"]
          : uid !== undefined
            ? ["launchctl", "kickstart", "-k", `gui/${uid}/sh.thecompanion.app`]
            : ["launchctl", "kickstart", "-k", "sh.thecompanion.app"];

        Bun.spawn(restartCmd, {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: isLinux
            ? {
                ...process.env,
                XDG_RUNTIME_DIR:
                  process.env.XDG_RUNTIME_DIR ||
                  `/run/user/${uid ?? 1000}`,
              }
            : undefined,
        });

        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[update] Update failed:", err);
        setUpdateInProgress(false);
      } finally {
        // Best-effort cleanup of the temporary download dir. We don't care
        // about failures here — the OS will eventually clean up tmpdir anyway.
        if (tmpDir) {
          try {
            rmSync(tmpDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }, 100);

    return c.json({
      ok: true,
      message: "Update started. Server will restart shortly.",
    });
  });

  api.get("/terminal", (c) => {
    const terminalId = c.req.query("terminalId");
    const info = deps.terminalManager.getInfo(terminalId || undefined);
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number; containerId?: string }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = deps.terminalManager.spawn(body.cwd, body.cols, body.rows, {
      containerId: body.containerId,
    });
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", async (c) => {
    const body = await c.req.json<{ terminalId?: string }>().catch(() => undefined);
    const terminalId = body?.terminalId?.trim();
    if (!terminalId) return c.json({ error: "terminalId is required" }, 400);
    deps.terminalManager.kill(terminalId);
    return c.json({ ok: true });
  });

  // ── /etc/hosts loopback diagnostic ───────────────────────────────────────
  // Used by the UI to render a banner when the embedded TLS proxy's allowlisted
  // hostname is not mapped to 127.0.0.1, which makes cliBridgeMode=tlsLoopback
  // unusable. Returns the platform-specific suggestion command so the user can
  // copy/paste it directly.
  api.get("/system/hosts-check", (c) => {
    const hostname = c.req.query("hostname")?.trim() || TLS_BRIDGE_HOSTNAME;
    const result = checkHostsEntry(hostname);
    return c.json({
      ok: result.ok,
      hostsPath: result.hostsPath,
      suggestedCommand: result.suggestedCommand,
      hostname,
    });
  });

  api.post("/sessions/:id/message", async (c) => {
    const id = c.req.param("id");
    const session = deps.launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deps.launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    deps.wsBridge.injectUserMessage(id, body.content);
    return c.json({ ok: true, sessionId: id });
  });
}
