/**
 * Server-only reader for Codex's models cache (`$CODEX_HOME/models_cache.json`).
 *
 * Codex publishes per-model capabilities there, including each model's
 * `supported_reasoning_levels` and `default_reasoning_level`. Those differ per
 * model (astra reaches `ultra`, gpt-5.5 stops at `xhigh`, sol defaults to
 * `low`), so effort for Codex cannot be a static table like the Claude one.
 *
 * Kept out of `effort.ts` on purpose: that module is re-exported into the
 * browser bundle and must not touch `node:fs`.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getLegacyCodexHome } from "./codex-home.js";
import {
  codexEffortLevelsFrom,
  codexDefaultEffortFrom,
  type CodexModelEntry,
  type EffortLevel,
} from "./effort.js";

function cachePath(): string {
  return join(getLegacyCodexHome(), "models_cache.json");
}

let cached: { mtimeMs: number; models: CodexModelEntry[] } | null = null;

/** Parsed models cache, re-read only when the file changes on disk. */
export function loadCodexModels(): CodexModelEntry[] {
  const path = cachePath();
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return []; }
  if (cached && cached.mtimeMs === mtimeMs) return cached.models;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { models?: CodexModelEntry[] };
    const models = Array.isArray(raw.models) ? raw.models : [];
    cached = { mtimeMs, models };
    return models;
  } catch {
    return cached?.models ?? [];
  }
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

/** Test seam: drop the mtime cache. */
export function resetCodexModelsCache(): void { cached = null; }
