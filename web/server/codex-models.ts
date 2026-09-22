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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * The most recently fetched cache among `paths`.
 *
 * Ordered by Codex's own `fetched_at`, not file mtime: a session home seeded by
 * copying the host cache gets a new mtime but carries the old catalogue.
 */
export function readFreshestCache(paths: string[]): CodexModelsCache | null {
  let best: { cache: CodexModelsCache; at: number } | null = null;
  for (const path of paths) {
    try {
      const cache = JSON.parse(readFileSync(path, "utf8")) as CodexModelsCache;
      if (!Array.isArray(cache.models)) continue;
      const at = Date.parse(cache.fetched_at ?? "") || 0;
      if (!best || at > best.at) best = { cache, at };
    } catch { /* unreadable or mid-write — skip it */ }
  }
  return best?.cache ?? null;
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
  const sig = signature(paths);
  if (cached && cached.sig === sig) return cached.cache;
  const cache = readFreshestCache(paths);
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

/** Test seam: drop the memo. */
export function resetCodexModelsCache(): void { cached = null; }
