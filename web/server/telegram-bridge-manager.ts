/**
 * Supervises the single Telegram bridge child process (telegram-bridge-child.ts).
 *
 * Mirrors the cli-launcher supervision shape: Bun.spawn, track the process,
 * restart on crash with backoff, SIGTERM on shutdown. The child is spawned only
 * when a bot token is configured; changing a binding pokes it with SIGHUP so it
 * reloads without a full restart.
 */
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { getSettings } from "./settings-manager.js";
import { COMPANION_HOME } from "./paths.js";

const CHILD_PATH = fileURLToPath(new URL("./telegram-bridge-child.ts", import.meta.url));
const CRASH_MIN_UPTIME_MS = 5000;
const RESTART_DELAY_MS = 5000;
const MAX_RESTART_DELAY_MS = 60000;

class TelegramBridgeManager {
  private proc: Subprocess | null = null;
  private port = "3456";
  private stopping = false;
  private restartDelay = RESTART_DELAY_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Start supervision. No-op (and stops any running child) when no token is set. */
  start(port: number): void {
    this.port = String(port);
    this.stopping = false;
    this.sync();
  }

  /** Reconcile desired vs actual: spawn if token present & not running; stop if token cleared. */
  sync(): void {
    const hasToken = !!getSettings().telegramBotToken.trim();
    if (hasToken && !this.proc) this.spawn();
    else if (!hasToken && this.proc) this.stop();
  }

  /** Tell the running child to reload bindings (SIGHUP). Spawns it if needed. */
  reload(): void {
    if (!getSettings().telegramBotToken.trim()) { this.stop(); return; }
    if (!this.proc) { this.spawn(); return; }
    try { this.proc.kill("SIGHUP"); } catch { /* dead; exit handler will restart */ }
  }

  private spawn(): void {
    if (this.proc) return;
    const spawnedAt = Date.now();
    try {
      this.proc = Bun.spawn(["bun", CHILD_PATH], {
        env: { ...process.env, COMPANION_HOME, COMPANION_PORT: this.port },
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
      console.log(`[tg-manager] bridge child spawned (pid ${this.proc.pid})`);
    } catch (e) {
      console.error("[tg-manager] spawn failed:", (e as Error).message);
      this.proc = null;
      this.scheduleRestart();
      return;
    }
    const proc = this.proc;
    proc.exited.then((code) => {
      const uptime = Date.now() - spawnedAt;
      this.proc = null;
      if (this.stopping) return;
      // Clean exit (e.g. no token) → don't loop. Crash → backoff-restart.
      if (code === 0 && uptime >= CRASH_MIN_UPTIME_MS) { console.log("[tg-manager] child exited cleanly"); return; }
      if (uptime >= CRASH_MIN_UPTIME_MS) this.restartDelay = RESTART_DELAY_MS; // healthy run → reset backoff
      console.error(`[tg-manager] child exited (code=${code}, uptime=${uptime}ms) — restart in ${this.restartDelay}ms`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && getSettings().telegramBotToken.trim()) this.spawn();
    }, this.restartDelay);
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  /** Stop the child. Synchronous SIGTERM so it works from the process shutdown path. */
  stop(): void {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* already gone */ }
      this.proc = null;
    }
  }

  isRunning(): boolean { return this.proc !== null; }
}

export const telegramBridgeManager = new TelegramBridgeManager();
