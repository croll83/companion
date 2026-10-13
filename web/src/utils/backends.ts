import type { BackendType } from "../types.js";
import type { BackendModelInfo } from "../api.js";

// Re-export the shared reasoning-effort capability matrix so UI code has a
// single import surface. The source of truth lives in server/ (also used by
// the launcher to decide whether to pass --effort).
export {
  EFFORT_LEVELS,
  DEFAULT_EFFORT,
  getEffortLevels,
  modelSupportsEffort,
  supportsUltracode,
  isValidEffort,
} from "../../server/effort.js";
export type { EffortLevel } from "../../server/effort.js";
import { CLAUDE_MODELS as SHARED_CLAUDE_MODELS } from "../../server/claude-models.js";
export { latestSonnet } from "../../server/claude-models.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
};

function pickIcon(slug: string, index: number): string {
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["\u25C6", "\u25CF", "\u25D5", "\u2726"]; // ◆ ● ◕ ✦
  return fallback[index % fallback.length];
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

/** The Claude catalog lives in server/claude-models.ts: the server resolves "latest Sonnet" from it. */
export const CLAUDE_MODELS: ModelOption[] = SHARED_CLAUDE_MODELS;

/**
 * Offline fallback only — the picker normally comes from Codex's own catalogue
 * via /backends/codex/models (see server/codex-models.ts). Mirrors that list as
 * of 2026-09-23 so a failed fetch still offers models that exist.
 */
export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-6-astra", label: "GPT-6-Astra", icon: "\u25A0" },
  { value: "gpt-6.1-sol", label: "GPT-6.1-Sol", icon: "\u25C6" },
  { value: "gpt-6-luna", label: "GPT-6-Luna", icon: "\u25CF" },
  { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", icon: "\u25D5" },
  { value: "gpt-5.5", label: "GPT-5.5", icon: "\u2726" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "plan", label: "Plan" },
];

// Agent-specific modes: "plan" is excluded because agents are autonomous
// and cannot wait for human plan approval.
export const CLAUDE_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "acceptEdits", label: "Auto-Edit" },
  { value: "default", label: "Supervised" },
];

export const CODEX_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "default", label: "Supervised" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: BackendType): ModelOption[] {
  return backend === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}

export function getModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_MODES : CLAUDE_MODES;
}

export function getAgentModesForBackend(backend: BackendType): ModeOption[] {
  return backend === "codex" ? CODEX_AGENT_MODES : CLAUDE_AGENT_MODES;
}

/**
 * Default model for a new Claude session. Decoupled from CLAUDE_MODELS ordering
 * so the list can be reordered (e.g. Fable 5 shown first) without silently
 * changing the default to a pricier model.
 */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export function getDefaultModel(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODELS[0].value : DEFAULT_CLAUDE_MODEL;
}

export function getDefaultMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_MODES[0].value : CLAUDE_MODES[0].value;
}

export function getDefaultAgentMode(backend: BackendType): string {
  return backend === "codex" ? CODEX_AGENT_MODES[0].value : CLAUDE_AGENT_MODES[0].value;
}
