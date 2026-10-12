/**
 * List the browsers connected to Claude in Chrome by running a short,
 * throwaway (isolated) Claude query that calls the `list_connected_browsers`
 * MCP tool.
 *
 * Companion cannot invoke that MCP tool on a live session itself (MCP tools
 * run inside a turn), and the tool is the only reliable source of the
 * connected browsers with their `isLocal` flag. So we spawn a one-shot
 * `claude -p` with `--chrome`, let it call the tool once, and read the JSON
 * array back from its output. The result is cached briefly so the Domains
 * page and the per-session selection do not each pay for a spawn.
 *
 * The query runs in a temporary working directory which, with its Claude
 * transcript, is deleted afterwards, leaving no trace under the config dir.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { getSettings } from "./settings-manager.js";
import { parseConnectedBrowsers, type ConnectedBrowser, type ConnectedBrowserList } from "./chrome-browser.js";

const PROBE_MODEL = "claude-haiku-5-5";
const PROBE_PROMPT =
  "Call the list_connected_browsers tool exactly once, then reply with ONLY the raw JSON array it returned "
  + "(one object per browser with deviceId, name, osPlatform, isLocal, inUse). No prose, no code fences. "
  + "If no browser is connected, reply with []";
const PROBE_TIMEOUT_MS = 90_000;
const CACHE_TTL_MS = 20_000;
const TEMP_PREFIX = "companion-chrome-probe-";

export interface ProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type ProbeSpawn = (
  cmd: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  timeoutMs: number,
) => Promise<ProbeOutput>;

export interface ProbeDeps {
  binary: string | null;
  env: Record<string, string | undefined>;
  cwd: string;
  cleanup: () => void;
  spawn: ProbeSpawn;
}

/**
 * Pull the browser array out of a `claude -p --output-format json` run.
 * The CLI wraps the model's final text in `{ ..., "result": "<text>" }`; the
 * text should be the raw array, but we tolerate code fences and surrounding
 * prose by slicing from the first `[` to the last `]`. Returns null when no
 * array can be read (a hard failure, distinct from an empty `[]`).
 */
export function extractBrowsersFromOutput(stdout: string): ConnectedBrowser[] | null {
  const text = stdout.trim();
  if (!text) return null;
  // Prefer the `result` field of the JSON envelope; fall back to the raw text.
  let payload = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parseConnectedBrowsers(parsed);
    if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
      payload = (parsed as { result: string }).result;
    }
  } catch {
    /* not a JSON envelope — treat stdout as the text itself */
  }
  const start = payload.indexOf("[");
  const end = payload.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    return parseConnectedBrowsers(JSON.parse(payload.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/** The claude command the probe runs (one read-only tool, no permission prompts). */
export function probeCommand(binary: string): string[] {
  return [
    binary,
    "-p", PROBE_PROMPT,
    "--output-format", "json",
    "--model", PROBE_MODEL,
    "--chrome",
    "--permission-mode", "bypassPermissions",
    "--allowedTools", "mcp__claude-in-chrome__list_connected_browsers",
  ];
}

/** Run one probe with the given deps (spawn injected for tests). */
export async function probeConnectedBrowsers(deps: ProbeDeps): Promise<ConnectedBrowserList> {
  if (!deps.binary) {
    deps.cleanup();
    return { browsers: [], error: "Claude CLI not found on PATH" };
  }
  try {
    const out = await deps.spawn(probeCommand(deps.binary), deps.env, deps.cwd, PROBE_TIMEOUT_MS);
    if (out.timedOut) return { browsers: [], error: "Timed out listing connected browsers" };
    const browsers = extractBrowsersFromOutput(out.stdout);
    if (browsers === null) {
      const detail = out.stderr.trim() || (out.exitCode ? `claude exited with code ${out.exitCode}` : "could not read the browser list");
      return { browsers: [], error: `Could not list connected browsers: ${detail}` };
    }
    return { browsers };
  } catch (err) {
    return { browsers: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    deps.cleanup();
  }
}

/** Default deps: resolve the CLI, a fresh temp cwd, the real env, and a real spawn. Exported for tests. */
export function defaultDeps(): ProbeDeps {
  const settings = getSettings();
  const cwd = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const env: Record<string, string | undefined> = { ...process.env };
  if (settings.claudeCodeOAuthToken && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = settings.claudeCodeOAuthToken;
  }
  env.PATH = getEnrichedPath();
  env.CLAUDECODE = undefined;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const transcriptDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  return {
    binary: resolveBinary("claude"),
    env,
    cwd,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(transcriptDir, { recursive: true, force: true });
    },
    spawn: realSpawn,
  };
}

/** Spawn the probe with Bun, draining stdout/stderr and enforcing a timeout. Exported for tests. */
export const realSpawn: ProbeSpawn = async (cmd, env, cwd, timeoutMs) => {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

let cache: { at: number; result: ConnectedBrowserList } | null = null;

/**
 * Connected browsers, cached for CACHE_TTL_MS. Pass `force` to bypass the
 * cache and `deps` to inject a spawn (tests). A failed probe is cached too, so
 * a machine with Chrome off does not spawn a CLI on every request.
 */
export async function listConnectedBrowsers(opts?: { force?: boolean; deps?: ProbeDeps }): Promise<ConnectedBrowserList> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const result = await probeConnectedBrowsers(opts?.deps ?? defaultDeps());
  cache = { at: Date.now(), result };
  return result;
}

/** Drop the cached list (tests, and when a fresh read is wanted). */
export function _clearChromeBrowserCache(): void {
  cache = null;
}
