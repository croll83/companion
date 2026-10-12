import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";
import { writePrivateFile } from "./private-file.js";
import { defaultDeps, type ProbeDeps } from "./chrome-browser-probe.js";

/**
 * MCP servers every Claude session loads by itself, outside Companion's
 * domains: the user's own servers (`claude mcp add --scope user`) and the
 * claude.ai connectors of the account (Gmail, Drive, …). Listed with
 * `claude mcp list` from an empty temp folder (no project servers), which
 * costs no tokens but takes ~10 s, so the list is cached on disk and
 * refreshed in the background. A domain turns them off through
 * `deniedMcpServers` in the session's --settings (verified on CLI 2.1.293
 * for both kinds). Codex never gets them: they are Claude-only.
 */

export interface AccountMcpServer {
  name: string;
  /** URL or command, as `claude mcp list` prints it. */
  target: string;
  /** "connected", "failed", "needs-auth", or the CLI's own words. */
  health: string;
  /** A connector of the claude.ai account (as opposed to a server in the user's config). */
  connector: boolean;
}

export interface AccountMcpList {
  servers: AccountMcpServer[];
  /** When the list was read (0 = never). */
  at: number;
  error?: string;
}

const CACHE_TTL_MS = 30 * 60_000;
const LIST_TIMEOUT_MS = 60_000;
/** Servers a domain must never turn off this way: Companion's own, and plugin servers (they follow their plugin). */
const NOT_LISTED = /^(companion$|plugin:)/;

function cachePath(): string {
  return join(COMPANION_HOME, "account-mcp-servers.json");
}

function healthOf(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("connected") && !t.includes("fail")) return "connected";
  if (t.includes("auth")) return "needs-auth";
  if (t.includes("fail") || t.includes("error")) return "failed";
  return text.replace(/^[^\p{L}]+/u, "").trim();
}

/** The servers in `claude mcp list` output (`name: target - status` lines). */
export function parseMcpList(stdout: string): AccountMcpServer[] {
  const out: AccountMcpServer[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?): (.+) - (.+)$/.exec(line.trim());
    if (!m || NOT_LISTED.test(m[1])) continue;
    out.push({ name: m[1], target: m[2].trim(), health: healthOf(m[3]), connector: m[1].startsWith("claude.ai ") });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The last list read, from disk (empty when never read). Never blocks on the CLI. */
export function cachedAccountMcpServers(): AccountMcpList {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf-8")) as Partial<AccountMcpList>;
    return {
      servers: Array.isArray(raw.servers) ? raw.servers.filter((s) => s && typeof s.name === "string") : [],
      at: typeof raw.at === "number" ? raw.at : 0,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    };
  } catch {
    return { servers: [], at: 0 };
  }
}

export function isAccountMcpStale(list: AccountMcpList, now = Date.now()): boolean {
  return now - list.at > CACHE_TTL_MS;
}

let inFlight: Promise<AccountMcpList> | null = null;

/**
 * Read the list with `claude mcp list` and cache it. Concurrent calls share
 * one run. A failed read keeps the previous servers and records the error.
 */
export function refreshAccountMcpServers(deps?: ProbeDeps): Promise<AccountMcpList> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const d = deps ?? defaultDeps();
    let result: AccountMcpList;
    try {
      if (!d.binary) throw new Error("the claude CLI was not found");
      const run = await d.spawn([d.binary, "mcp", "list"], d.env, d.cwd, LIST_TIMEOUT_MS);
      const servers = parseMcpList(run.stdout);
      if (run.timedOut || (run.exitCode !== 0 && servers.length === 0)) {
        const why = run.timedOut ? "timed out" : (run.stderr.trim().split("\n").pop() || `exit ${run.exitCode}`);
        result = { ...cachedAccountMcpServers(), error: `claude mcp list failed: ${why}` };
      } else {
        result = { servers, at: Date.now() };
      }
    } catch (err) {
      result = { ...cachedAccountMcpServers(), error: `claude mcp list failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      d.cleanup();
    }
    try {
      writePrivateFile(cachePath(), `${JSON.stringify(result, null, 2)}\n`);
    } catch {
      /* the next read retries */
    }
    return result;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
