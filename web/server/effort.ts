/**
 * Reasoning-effort capability matrix.
 *
 * Newer Claude models (fable-5, Opus 4.6+) control reasoning depth via a
 * 5-level `effort` setting instead of a thinking-token budget. The Claude Code
 * CLI exposes this only as a launch flag (`--effort <level>`) — there is no
 * runtime control_request to change it — so the companion treats an effort
 * change like a model change: kill + relaunch the CLI with `--resume`.
 *
 * The per-model level sets below mirror the CLI's own gating (verified against
 * Claude Code 2.1.x): every effort-capable model supports low/medium/high;
 * `xhigh` and `max` are gated per model. Keeping this list in `server/` lets
 * both the backend (to decide whether to pass `--effort`) and the frontend
 * (which re-exports server types) share a single source of truth.
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Default effort when a model supports it but none was chosen. */
export const DEFAULT_EFFORT: EffortLevel = "high";

/**
 * Effort levels each model accepts. A model absent from this map does not
 * support effort at all (e.g. Sonnet/Haiku, Codex) and must never receive a
 * `--effort` flag — passing one to a non-supporting model is rejected.
 */
const MODEL_EFFORT_LEVELS: Record<string, EffortLevel[]> = {
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  // Opus 4.6 supports `max` but not `xhigh` (matches CLI gating).
  "claude-opus-4-6": ["low", "medium", "high", "max"],
};

/** Ordered effort levels a model supports, or [] if it doesn't support effort. */
export function getEffortLevels(model: string | undefined | null): EffortLevel[] {
  if (!model) return [];
  return MODEL_EFFORT_LEVELS[model] ?? [];
}

/** Whether a model exposes reasoning-effort control. */
export function modelSupportsEffort(model: string | undefined | null): boolean {
  return getEffortLevels(model).length > 0;
}

/** Whether `effort` is a level the given model actually accepts. */
export function isValidEffort(model: string | undefined | null, effort: string | undefined | null): effort is EffortLevel {
  if (!effort) return false;
  return getEffortLevels(model).includes(effort as EffortLevel);
}
