/**
 * Claude CLI compatibility probe.
 *
 * The stdio bridge mode (cliBridgeMode === "stdio") spawns the Claude Code CLI
 * with `--input-format stream-json`, `--output-format stream-json` and
 * `--include-partial-messages`. These flags exist on a wide range of CLI
 * versions, but a sufficiently OLD CLI may not understand them — in which case
 * the spawn fails immediately. Rather than hardcode a version floor (which we
 * can't pin precisely), we feature-detect:
 *
 *  1. Proactive probe (this module): run `claude --version` + `claude --help`
 *     at startup / on demand and check that the required flags are advertised.
 *  2. Runtime backstop (cli-launcher): if a stdio session dies instantly with a
 *     telltale "unknown option" stderr, it calls markRuntimeIncompatible().
 *
 * Both feed a single banner (GET /api/system/claude-cli-check) that asks the
 * user to run `claude update`.
 */

import { resolveBinary } from "./path-resolver.js";

export interface ClaudeCliCheckResult {
  /** True when the CLI is present and advertises all required flags. */
  ok: boolean;
  /** Whether a `claude` binary was found on PATH at all. */
  found: boolean;
  /** Parsed CLI version (e.g. "2.1.175"), or null if it couldn't be read. */
  version: string | null;
  /** Required flags missing from `claude --help`, if any. */
  missingFlags: string[];
  /** Human-readable reason the banner shows, or null when ok. */
  reason: string | null;
  /** Command the user should run to fix it. */
  suggestedCommand: string;
}

/** Flags the stdio bridge depends on. */
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--include-partial-messages"];
const SUGGESTED_COMMAND = "claude update";
const CACHE_TTL_MS = 60_000;

let cached: ClaudeCliCheckResult | null = null;
let cachedAt = 0;
let runtimeIncompatible: { version: string | null; detail: string } | null = null;

/** Extract a semver-ish version from `claude --version` output. */
export function parseClaudeVersion(s: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(s);
  return m ? m[1] : null;
}

/**
 * Called by the cli-launcher when a stdio session dies immediately with an
 * "unknown option" / unsupported-flag stderr — a strong signal the installed
 * CLI is too old for this Companion build.
 */
export function markClaudeCliRuntimeIncompatible(version: string | null, detail: string): void {
  runtimeIncompatible = { version, detail };
}

/** Clear a previously-recorded runtime incompatibility (e.g. after an update). */
export function clearClaudeCliRuntimeIncompatible(): void {
  runtimeIncompatible = null;
}

function probe(binary?: string): ClaudeCliCheckResult {
  const bin = resolveBinary(binary || "claude");
  if (!bin) {
    return {
      ok: false,
      found: false,
      version: null,
      missingFlags: [],
      reason: "Claude CLI not found on PATH. Install it, then reload.",
      suggestedCommand: SUGGESTED_COMMAND,
    };
  }

  const decoder = new TextDecoder();
  let version: string | null = null;
  try {
    const v = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    version = parseClaudeVersion(decoder.decode(v.stdout) + decoder.decode(v.stderr));
  } catch {
    /* fall through — version stays null */
  }

  let missingFlags: string[] = [];
  let helpRead = false;
  try {
    const h = Bun.spawnSync([bin, "--help"], { stdout: "pipe", stderr: "pipe" });
    const help = decoder.decode(h.stdout) + decoder.decode(h.stderr);
    if (help.trim()) {
      helpRead = true;
      missingFlags = REQUIRED_FLAGS.filter((f) => !help.includes(f));
    }
  } catch {
    /* fall through */
  }

  // If we couldn't read --help at all, don't cry wolf: report ok (the runtime
  // backstop will still catch a real spawn failure).
  const ok = !helpRead || missingFlags.length === 0;
  return {
    ok,
    found: true,
    version,
    missingFlags,
    reason: ok
      ? null
      : `Your Claude CLI${version ? ` (v${version})` : ""} is missing features required by this Companion build (${missingFlags.join(", ")}). Update it to continue.`,
    suggestedCommand: SUGGESTED_COMMAND,
  };
}

/**
 * Return the current compatibility status. Result is cached for CACHE_TTL_MS;
 * a fresh probe that passes also clears a stale runtime-incompatibility flag so
 * the banner disappears within ~1 min of the user updating the CLI.
 */
export function checkClaudeCli(opts?: { force?: boolean; binary?: string }): ClaudeCliCheckResult {
  const now = Date.now();
  if (opts?.force || !cached || now - cachedAt >= CACHE_TTL_MS) {
    cached = probe(opts?.binary);
    cachedAt = now;
    if (cached.ok && runtimeIncompatible) {
      // A fresh probe says the CLI is fine — trust it and drop the stale flag.
      runtimeIncompatible = null;
    }
  }

  if (runtimeIncompatible) {
    return {
      ...cached,
      ok: false,
      version: cached.version ?? runtimeIncompatible.version,
      reason:
        cached.reason ??
        `Your Claude CLI${runtimeIncompatible.version ? ` (v${runtimeIncompatible.version})` : ""} appears incompatible with this Companion build (${runtimeIncompatible.detail}). Update it to continue.`,
    };
  }
  return cached;
}
