/**
 * Server-only reader for Codex's models cache (`models_cache.json`).
 *
 * Codex publishes per-model capabilities there, including each model's
 * `supported_reasoning_levels` and `default_reasoning_level`. Those differ per
 * model (astra reaches `ultra`, gpt-5.5 stops at `xhigh`, sol defaults to
 * `low`), so effort for Codex cannot be a static table like the Claude one.
 * The same catalogue feeds the model picker.
 *
 * Which cache to read: Codex refreshes the catalogue whenever it runs, but
 * Companion gives every Codex session its own CODEX_HOME, so those refreshes
 * land in `~/.companion/codex-home/<session>/`. Reading only the host's
 * `~/.codex` — which moves only when Codex is run directly on the host — left
 * new models (GPT-6 Sol/Luna, 2026-09-23) out of the picker for hours, and
 * with no effort levels even once selected. So read the freshest one.
 *
 * Kept out of `effort.ts` on purpose: that module is re-exported into the
 * browser bundle and must not touch `node:fs`.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";
import { join } from "node:path";
import { getLegacyCodexHome, resolveCompanionCodexHome } from "./codex-home.js";
import {
  codexEffortLevelsFrom,
  codexDefaultEffortFrom,
  type CodexModelEntry,
  type EffortLevel,
} from "./effort.js";

/** A catalogue entry, with the fields the picker needs on top of effort's. */
export interface CodexCacheModel extends CodexModelEntry {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
}

interface CodexModelsCache {
  fetched_at?: string;
  /** Codex version that fetched this catalogue; OpenAI tailors it per client. */
  client_version?: string;
  models: CodexCacheModel[];
}

export interface CodexPickerModel {
  value: string;
  label: string;
  description: string;
}

/** Every models_cache.json Codex may have refreshed: the host's and each session's. */
export function candidateCachePaths(legacyHome: string, companionCodexHome: string): string[] {
  const paths = [join(legacyHome, "models_cache.json")];
  try {
    for (const entry of readdirSync(companionCodexHome)) {
      paths.push(join(companionCodexHome, entry, "models_cache.json"));
    }
  } catch { /* no session homes yet */ }
  return paths.filter((p) => existsSync(p));
}

/** "0.160.0" → [0,160,0]; non-versions sort lowest. */
function versionParts(v: string | undefined | null): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The catalogue to trust among `paths`, for the Codex binary Companion runs.
 *
 * OpenAI tailors the catalogue to the client that fetches it: on 2026-10-03
 * Codex 0.160 listed GPT-6.1-Sol and 0.157 did not. Several Codex versions
 * refresh caches on this machine (the user's auto-updating install, and the one
 * Companion spawns), so "most recently fetched" flipped the picker between
 * catalogues — and could offer a model the client Companion runs was never
 * offered. So: prefer caches fetched by exactly the running version; else the
 * newest version not above it; only then fall back to recency. Within a
 * version, ordered by Codex's own `fetched_at` (a seeded copy gets a new mtime
 * but carries the old catalogue).
 */
export function readFreshestCache(paths: string[], runningVersion?: string | null): CodexModelsCache | null {
  const caches: { cache: CodexModelsCache; at: number }[] = [];
  for (const path of paths) {
    try {
      const cache = JSON.parse(readFileSync(path, "utf8")) as CodexModelsCache;
      if (!Array.isArray(cache.models)) continue;
      caches.push({ cache, at: Date.parse(cache.fetched_at ?? "") || 0 });
    } catch { /* unreadable or mid-write — skip it */ }
  }
  if (caches.length === 0) return null;

  let pool = caches;
  if (runningVersion) {
    const exact = caches.filter((c) => compareVersions(c.cache.client_version, runningVersion) === 0);
    const notAbove = caches.filter((c) => compareVersions(c.cache.client_version, runningVersion) <= 0);
    if (exact.length > 0) pool = exact;
    else if (notAbove.length > 0) {
      const top = notAbove.reduce((a, b) => (compareVersions(a.cache.client_version, b.cache.client_version) >= 0 ? a : b));
      pool = notAbove.filter((c) => compareVersions(c.cache.client_version, top.cache.client_version) === 0);
    }
  }
  return pool.reduce((a, b) => (b.at > a.at ? b : a)).cache;
}

/**
 * Version of the codex binary Companion spawns (resolved from PATH like the
 * launcher does), cached per binary file so `codex --version` runs only when the
 * install changes — e.g. after `codex update`.
 */
let versionMemo: { key: string; version: string | null } | null = null;
export function runningCodexVersion(): string | null {
  const bin = resolveBinary("codex");
  if (!bin) return null;
  let key: string;
  try { const real = realpathSync(bin); key = `${real}:${statSync(real).mtimeMs}`; } catch { return null; }
  if (versionMemo?.key === key) return versionMemo.version;
  let version: string | null = null;
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: getEnrichedPath() } });
    version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch { version = null; }
  versionMemo = { key, version };
  return version;
}

function defaultPaths(): string[] {
  return candidateCachePaths(getLegacyCodexHome(), resolveCompanionCodexHome());
}

/** Signature of the candidate files, so the memo invalidates when any changes. */
function signature(paths: string[]): string {
  return paths
    .map((p) => { try { return `${p}:${statSync(p).mtimeMs}`; } catch { return p; } })
    .join("|");
}

let cached: { sig: string; cache: CodexModelsCache | null } | null = null;

/** The freshest catalogue, re-read only when one of the cache files changes. */
export function loadCodexCache(): CodexModelsCache | null {
  const paths = defaultPaths();
  const version = runningCodexVersion();
  const sig = `${version}|${signature(paths)}`;
  if (cached && cached.sig === sig) return cached.cache;
  const cache = readFreshestCache(paths, version);
  cached = { sig, cache };
  return cache;
}

/** Parsed models from the freshest cache. */
export function loadCodexModels(): CodexModelEntry[] {
  return loadCodexCache()?.models ?? [];
}

/** Effort levels the given Codex model accepts (empty if unknown). */
export function getCodexEffortLevels(model: string | undefined | null): EffortLevel[] {
  return codexEffortLevelsFrom(loadCodexModels(), model);
}

/** Codex's own default effort for the model, or null. */
export function getCodexDefaultEffort(model: string | undefined | null): EffortLevel | null {
  return codexDefaultEffortFrom(loadCodexModels(), model);
}

/** Whether `effort` is a level this Codex model actually accepts. */
export function isValidCodexEffort(
  model: string | undefined | null,
  effort: string | undefined | null,
): boolean {
  if (!effort) return false;
  return getCodexEffortLevels(model).includes(effort as EffortLevel);
}

/** `gpt-6-sol` → { family: "sol", version: 6 }; null for slugs without a family. */
export function parseFamily(slug: string): { family: string; version: number } | null {
  const m = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(slug);
  return m ? { family: m[2], version: Number(m[1]) } : null;
}

/**
 * Listed models, best first, with each family shown only at its newest version.
 *
 * When a new generation of a family ships (GPT-6 Sol after GPT-5.6 Sol) the old
 * one is superseded and leaves the picker; a family with no newer generation
 * (GPT-5.6 Terra) stays. This keeps the menu current across releases without
 * anyone editing a list. Superseded models keep working for sessions already
 * on them: their effort levels still come from the same catalogue.
 */
export function pickerModels(cache: CodexModelsCache): CodexPickerModel[] {
  const listed = cache.models.filter((m) => m.visibility === "list");

  const newest = new Map<string, number>();
  for (const m of listed) {
    const f = parseFamily(m.slug);
    if (f && f.version > (newest.get(f.family) ?? -Infinity)) newest.set(f.family, f.version);
  }

  return listed
    .filter((m) => {
      const f = parseFamily(m.slug);
      return !f || f.version === newest.get(f.family);
    })
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({ value: m.slug, label: m.display_name || m.slug, description: m.description || "" }));
}

/** Test seam: drop the memos. */
export function resetCodexModelsCache(): void { cached = null; versionMemo = null; }
