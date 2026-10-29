import { useEffect, useId, useState } from "react";
import { api, type DomainPatch, type DomainSummary, type LocalProviderView } from "../api.js";

const ANTHROPIC = "";

/**
 * Where new sessions of a domain run by default: the Anthropic account, or
 * a local provider and model (Settings → Local providers). The Home page
 * preselects it when the domain is picked; it can still be changed there.
 * Claude Code only (Codex sessions are not affected). Hidden until a local
 * provider exists, unless the domain already has a default.
 */
export function DomainLocalDefault({
  domain,
  busy,
  onUpdate,
}: {
  domain: DomainSummary;
  busy: boolean;
  onUpdate: (patch: DomainPatch) => void;
}) {
  const [providers, setProviders] = useState<LocalProviderView[] | null>(null);
  const id = useId();
  useEffect(() => {
    let active = true;
    api.listLocalProviders().then((list) => { if (active) setProviders(list); }).catch(() => { if (active) setProviders([]); });
    return () => { active = false; };
  }, []);

  const current = domain.localDefault;
  if (!providers || (providers.length === 0 && !current)) return null;
  const value = current ? `${current.provider}\u0000${current.model ?? ""}` : ANTHROPIC;
  const known = !current || providers.some((p) => p.id === current.provider);

  return (
    <section aria-label="Default for new sessions">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">New sessions run on</h3>
      <div className="mt-1 flex items-center gap-2 text-[12px] flex-wrap">
        <label htmlFor={id} className="sr-only">Default for new sessions of {domain.name}</label>
        <select
          id={id}
          value={value}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === ANTHROPIC) return onUpdate({ localDefault: null });
            const [provider, model] = e.target.value.split("\u0000");
            onUpdate({ localDefault: { provider, ...(model ? { model } : {}) } });
          }}
          className="px-2 py-1 text-[12px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg"
        >
          <option value={ANTHROPIC}>The Anthropic account (Claude)</option>
          {providers.map((p) => [
            <option key={p.id} value={`${p.id}\u0000`}>Local · {p.name} (its default model)</option>,
            ...p.models.map((m) => <option key={`${p.id}/${m}`} value={`${p.id}\u0000${m}`}>Local · {p.name}/{m}</option>),
          ])}
          {!known && current && <option value={value}>Local · {current.provider} (deleted)</option>}
        </select>
        <span className="text-[10px] text-cc-muted">Requires Claude Code (Codex sessions are not affected)</span>
      </div>
    </section>
  );
}
