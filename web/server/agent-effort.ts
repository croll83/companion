/**
 * Reasoning effort of an agent run, for both backends.
 *
 * Claude's levels come from the static table in effort.ts; Codex's from the
 * models catalogue Codex publishes (codex-models.ts), which is why this module
 * is server-only. Used by the agent routes (validation), the executor (the
 * level each run launches with) and brain consolidation (its "high" default).
 *
 * "No effort chosen" means the model's default, and it is resolved here and
 * passed explicitly instead of leaving the CLI to pick: the session then
 * reports the level it really runs at. Left to themselves the CLIs pick a
 * level Companion cannot see (Claude: per model and per user settings,
 * medium on Sonnet 5.5; Codex: the catalogue's default_reasoning_level, low
 * on GPT-6.1-Sol), and the UI showed "High" for runs that were at low.
 */
import {
  EFFORT_LEVELS,
  getDefaultEffort,
  getEffortLevels,
  settleEffort,
  type EffortLevel,
} from "./effort.js";
import { defaultCodexModel, getCodexDefaultEffort, getCodexEffortLevels } from "./codex-models.js";

export type AgentBackend = "claude" | "codex";

/**
 * The model a run really gets: Codex without a model gets the catalogue's
 * first one (as the launcher does), Claude without one stays undefined (the
 * CLI's default model, whose levels Companion does not know).
 */
function runModel(backend: AgentBackend, model: string | undefined | null): string | undefined {
  if (model) return model;
  return backend === "codex" ? defaultCodexModel() : undefined;
}

/** The levels the model of a run accepts ([] = no effort control, or unknown). */
export function effortLevelsFor(backend: AgentBackend, model: string | undefined | null): EffortLevel[] {
  const m = runModel(backend, model);
  return backend === "codex" ? getCodexEffortLevels(m) : getEffortLevels(m);
}

/** The default level of the model of a run: Codex's own, or Companion's for Claude (DEFAULT_EFFORT). */
export function defaultEffortFor(backend: AgentBackend, model: string | undefined | null): EffortLevel | null {
  const m = runModel(backend, model);
  return backend === "codex" ? getCodexDefaultEffort(m) : getDefaultEffort(m);
}

/**
 * Why `effort` cannot be saved on an agent of this backend and model, or null.
 * Absent (undefined, null, "") is always fine: it means the model's default.
 */
export function agentEffortError(backend: AgentBackend, model: string | undefined | null, effort: unknown): string | null {
  if (effort === undefined || effort === null || effort === "") return null;
  if (typeof effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return `effort must be one of ${EFFORT_LEVELS.join(", ")} (or empty for the model's default)`;
  }
  const levels = effortLevelsFor(backend, model);
  const name = runModel(backend, model) ?? "the CLI's default model";
  if (levels.length === 0) {
    return backend === "codex"
      ? `Codex reports no reasoning-effort levels for ${name} (its models catalogue is missing or does not list it): leave effort empty`
      : `${name} has no reasoning-effort setting: leave effort empty`;
  }
  if (!levels.includes(effort as EffortLevel)) {
    return `${name} does not support effort "${effort}" (it supports ${levels.join(", ")})`;
  }
  return null;
}

/**
 * The level a run launches with: the wanted one when the model takes it, else
 * the model's default; undefined when the model has no effort control. A
 * stored level the model no longer takes (a catalogue change) falls back to
 * the default rather than being dropped silently by the CLI.
 */
export function resolveRunEffort(
  backend: AgentBackend,
  model: string | undefined | null,
  wanted: string | undefined | null,
): { effort?: EffortLevel; fallback: boolean } {
  return settleEffort(wanted, effortLevelsFor(backend, model), defaultEffortFor(backend, model));
}
