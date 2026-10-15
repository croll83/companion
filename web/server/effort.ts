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
 *
 * Codex works the same way — effort is a launch-time config, not a runtime
 * control — but its levels are NOT a fixed table: each model declares its own
 * `supported_reasoning_levels` in Codex's models cache (astra reaches `ultra`,
 * gpt-5.5 stops at `xhigh`, and defaults differ per model). The parsing helpers
 * below are pure so this module stays importable from the browser bundle; the
 * filesystem read lives in `codex-models.ts` (server only).
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Default effort when a model supports it but none was chosen. */
export const DEFAULT_EFFORT: EffortLevel = "high";

/**
 * Effort levels each model accepts. Entries outlive the model picker on
 * purpose: a session started on an older model keeps running on it, and
 * dropping its row here would silently stop passing --effort mid-session.
 *
 * A model absent from this map does not
 * support effort at all (e.g. Sonnet 4.6, Codex) and must never receive a
 * `--effort` flag. The CLI does not reject a level it cannot apply: it drops
 * it silently (probed on CLI 2.1.293: `--effort xhigh` on Opus 4.6 runs at
 * high, `--effort ultra` on Sonnet 5.5 at medium), so a wrong row here means a
 * session that runs at a level other than the one shown.
 */
const MODEL_EFFORT_LEVELS: Record<string, EffortLevel[]> = {
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  // Opus 4.6 supports `max` but not `xhigh` (matches CLI gating).
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  // Probed on CLI 2.1.293 (get_settings `applied.effort` after `--effort`):
  // low, high, xhigh and max are applied as given. Without this row a brain
  // consolidating on "latest Sonnet" ran at the CLI's own default (medium).
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
};

/** Ordered effort levels a model supports, or [] if it doesn't support effort. */
export function getEffortLevels(model: string | undefined | null): EffortLevel[] {
  if (!model) return [];
  return MODEL_EFFORT_LEVELS[model] ?? [];
}

/**
 * Companion's default level for a Claude model that takes effort: DEFAULT_EFFORT
 * (what a new session starts on), or the model's highest level should it ever
 * lack it. Null for a model without effort control.
 */
export function getDefaultEffort(model: string | undefined | null): EffortLevel | null {
  const levels = getEffortLevels(model);
  if (levels.length === 0) return null;
  return levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : levels[levels.length - 1];
}

/**
 * A wanted level settled against what a model takes: the wanted one when the
 * model supports it, else the model's default. `fallback` says the wanted level
 * was not usable, so a UI can say so. No level at all when the model has none
 * (the CLI then runs on its own). Pure, shared by the server (agent runs, brain
 * consolidation) and the browser (the notes next to the effort pickers).
 */
export function settleEffort(
  wanted: string | undefined | null,
  levels: readonly string[],
  modelDefault: EffortLevel | null | undefined,
): { effort?: EffortLevel; fallback: boolean } {
  if (wanted && levels.includes(wanted)) return { effort: wanted as EffortLevel, fallback: false };
  const effort = modelDefault && levels.includes(modelDefault) ? modelDefault : undefined;
  return { ...(effort ? { effort } : {}), fallback: !!wanted };
}

/** Whether a model exposes reasoning-effort control. */
export function modelSupportsEffort(model: string | undefined | null): boolean {
  return getEffortLevels(model).length > 0;
}

/** Shape of the entries Codex writes to its models cache (subset we use). */
export interface CodexModelEntry {
  slug?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

/** Effort levels a Codex model accepts, in the order Codex lists them. */
export function codexEffortLevelsFrom(
  models: CodexModelEntry[] | undefined | null,
  model: string | undefined | null,
): EffortLevel[] {
  if (!models || !model) return [];
  const entry = models.find((m) => m.slug === model);
  if (!entry) return [];
  const known = new Set<string>(EFFORT_LEVELS);
  return (entry.supported_reasoning_levels ?? [])
    .map((l) => l.effort)
    .filter((e): e is EffortLevel => !!e && known.has(e));
}

/** Codex's own default level for a model, when it is one we know. */
export function codexDefaultEffortFrom(
  models: CodexModelEntry[] | undefined | null,
  model: string | undefined | null,
): EffortLevel | null {
  if (!models || !model) return null;
  const d = models.find((m) => m.slug === model)?.default_reasoning_level;
  return d && (EFFORT_LEVELS as readonly string[]).includes(d) ? (d as EffortLevel) : null;
}

/** Whether `effort` is a level the given model actually accepts. */
export function isValidEffort(model: string | undefined | null, effort: string | undefined | null): effort is EffortLevel {
  if (!effort) return false;
  return getEffortLevels(model).includes(effort as EffortLevel);
}

/**
 * Whether the CLI can run ultracode on this model.
 *
 * Ultracode is xhigh effort plus standing dynamic-workflow orchestration; the
 * CLI refuses it on a model without xhigh ("the model does not support xhigh
 * effort"). Mirrors that gate so the toggle is only offered where it can work.
 */
export function supportsUltracode(model: string | undefined | null): boolean {
  return getEffortLevels(model).includes("xhigh");
}
