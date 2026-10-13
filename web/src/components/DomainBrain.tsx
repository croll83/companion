import { useId } from "react";
import type { DomainSummary } from "../api.js";
import { brainsHash } from "../utils/routing.js";

const INHERIT = "__inherit__";
const NONE = "__none__";

/**
 * The brain of one domain (see BrainsPage): one per domain. A domain uses
 * its own choice, else GLOBAL's brain (the default for every domain), else
 * none. Choosing a brain replaces the current one. Works for Claude Code and
 * Codex sessions alike; applies when a session starts or reloads.
 */
export function DomainBrain({
  domain,
  brains,
  globalBrain,
  busy,
  onChange,
}: {
  domain: DomainSummary;
  brains: { slug: string; name: string }[];
  /** GLOBAL's brain name (for "As in GLOBAL"), when it has one. */
  globalBrain?: string;
  busy: boolean;
  /** A slug, null (no brain) or "inherit" (GLOBAL's). */
  onChange: (brain: string | null) => void;
}) {
  const selectId = useId();
  const isGlobal = domain.slug === "global";
  const value = domain.brain === undefined ? (isGlobal ? NONE : INHERIT) : domain.brain === null ? NONE : domain.brain;
  const current = domain.effectiveBrain;
  // A choice pointing at a brain that no longer exists shows as "none".
  const known = value === INHERIT || value === NONE || brains.some((b) => b.slug === value);

  return (
    <section aria-label="Brain">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Brain</h3>
      <p className="mt-1 text-[12px]">
        {current
          ? <>Uses <a href={brainsHash(current.slug)} className="text-cc-primary hover:underline">{current.name}</a>{!current.own && " (as in GLOBAL)"}</>
          : "No brain"}
        {isGlobal && <span className="text-cc-muted"> · default for every domain</span>}
      </p>
      {brains.length === 0 ? (
        <p className="mt-1 text-[11px] text-cc-muted">
          No brain yet. <a href={brainsHash()} className="text-cc-primary hover:underline">Connect one in Brains</a>.
        </p>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <label htmlFor={selectId} className="text-[11px] text-cc-muted">{isGlobal ? "Default brain" : "Brain for this domain"}</label>
          <select
            id={selectId}
            value={known ? value : NONE}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              onChange(v === NONE ? null : v === INHERIT ? "inherit" : v);
            }}
            className="px-1.5 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary"
          >
            {!isGlobal && <option value={INHERIT}>As in GLOBAL ({globalBrain ?? "no brain"})</option>}
            <option value={NONE}>No brain</option>
            {brains.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
          </select>
        </div>
      )}
      <p className="mt-1 text-[10px] text-cc-muted leading-snug">
        {isGlobal
          ? "GLOBAL's brain is the default for every domain without a choice of its own. A brain makes one domain's knowledge readable by all its sessions: prefer one brain per topic."
          : "A domain has one brain: choosing one replaces the current one."}
        {" "}Claude Code and Codex sessions get it when they start or reload.
      </p>
    </section>
  );
}
