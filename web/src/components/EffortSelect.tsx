import { useId } from "react";
import { effortLabel, type EffortLevel } from "../utils/backends.js";
import { localEffortLabel } from "../utils/local-session.js";

interface EffortSelectProps {
  /** Accessible name of the select. */
  label: string;
  /** The levels the selected backend and model take (effortChoiceFor). */
  levels: EffortLevel[];
  /** The chosen level; "" = the model's default (only with `defaultEffort` offered). */
  value: string;
  onChange: (value: string) => void;
  /**
   * Offer "Default (<level>)" as the first option, value "". Undefined: no
   * default option (the value is always a level). Null: the model's default is
   * not known, shown as "Default".
   */
  defaultEffort?: EffortLevel | null;
  /** Shown, and the select disabled, when the model has no levels (or they are unknown). */
  unavailableNote: string;
  /** An extra line under the select (e.g. "runs use the model's default"). */
  note?: string;
  className?: string;
  /** Names to show instead of the effort's own (a local provider's model levels). */
  labels?: Record<string, string>;
}

/**
 * Reasoning-effort picker for settings that apply before any session exists
 * (an agent's runs, brain consolidation). It lists only the levels the
 * selected backend and model take, so it never offers one the CLI would drop.
 * A saved level the model no longer takes stays visible as "(not supported)"
 * instead of the select silently showing another one. When the model has no
 * levels the select is disabled with `unavailableNote`: Codex without its
 * catalogue, or a Claude model without effort control (parity rule: disable
 * with a note rather than offer something that does nothing).
 */
export function EffortSelect({ label, levels, value, onChange, defaultEffort, unavailableNote, note, className = "", labels }: EffortSelectProps) {
  const name = (level: string) => (labels ? localEffortLabel(labels, level) : effortLabel(level));
  const noteId = useId();
  const offersDefault = defaultEffort !== undefined;
  const unavailable = levels.length === 0;
  const stale = !!value && !levels.includes(value as EffortLevel);
  // Disabled without levels, except to let a stale level be put back to the default.
  const disabled = unavailable && !(stale && offersDefault);
  const lines = [unavailable ? unavailableNote : "", note ?? ""].filter(Boolean);
  return (
    <span className="inline-flex flex-col gap-0.5">
      <select
        aria-label={label}
        aria-describedby={lines.length ? noteId : undefined}
        value={stale || !unavailable ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${className} disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {(offersDefault || unavailable) && (
          <option value="">{defaultEffort ? `Default (${name(defaultEffort)})` : "Default"}</option>
        )}
        {levels.map((l) => <option key={l} value={l}>{name(l)}</option>)}
        {stale && <option value={value}>{`${name(value)} (not supported)`}</option>}
      </select>
      {lines.length > 0 && <span id={noteId} className="text-[10px] text-cc-muted">{lines.join(" ")}</span>}
    </span>
  );
}
