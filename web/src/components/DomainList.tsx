import { useId, useState } from "react";
import type { DomainSummary, PluginInfo, SkillGroupInfo } from "../api.js";
import { domainsHash } from "../utils/routing.js";

/** What a domain has on, for the list and the detail summary. */
export function domainCounts(domain: DomainSummary, groups: SkillGroupInfo[], plugins: PluginInfo[]) {
  const mcpOn = domain.mcpServers.filter((s) => s.enabled);
  const skillTotal = groups.reduce((n, g) => n + g.skills.length, 0) + (domain.ownSkills?.length ?? 0);
  const skillOn = groups.reduce((n, g) => n + (domain.skillGroupStates[g.id]?.onCount ?? g.skills.length), 0) + (domain.ownSkills?.length ?? 0);
  const pluginsOn = plugins.filter((p) => domain.pluginStates[p.id]?.on ?? p.enabledByUser);
  // A broken mcp.json, or a server that is on but waits for a login.
  const attention = !!domain.mcpError || mcpOn.some((s) => s.health === "needs-auth");
  return { mcpOn, mcpTotal: domain.mcpServers.length, skillOn, skillTotal, pluginsOn, attention };
}

/**
 * The list of domains (GLOBAL first): name, description, sessions, and what
 * each has on. A row opens the domain (#/domains/<slug>); on desktop the
 * list stays on the left of the selected domain. "New domain" creates one.
 */
export function DomainList({
  domains,
  groups,
  plugins,
  selected,
  busy,
  onCreate,
}: {
  domains: DomainSummary[];
  groups: SkillGroupInfo[];
  plugins: PluginInfo[];
  selected?: string;
  busy: boolean;
  onCreate: (name: string, description?: string) => Promise<boolean>;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <nav aria-label="Domains">
      <ul className="divide-y divide-cc-separator rounded-xl border border-cc-border bg-cc-card overflow-hidden">
        {domains.map((d) => {
          const c = domainCounts(d, groups, plugins);
          const current = d.slug === selected;
          return (
            <li key={d.slug}>
              <a
                href={domainsHash(d.slug)}
                aria-current={current ? "page" : undefined}
                className={`block px-3 py-2.5 hover:bg-cc-hover ${current ? "bg-cc-active" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold truncate">{d.name}</span>
                  {c.attention && <span className="w-1.5 h-1.5 rounded-full bg-cc-warning shrink-0" title="Needs attention (sign-in or mcp.json)" />}
                  <span className="ml-auto text-[10px] text-cc-muted shrink-0">
                    {d.sessionCount} session{d.sessionCount === 1 ? "" : "s"}
                  </span>
                </div>
                {d.description && <p className="text-[11px] text-cc-muted truncate">{d.description}</p>}
                <p className="text-[10px] text-cc-muted">
                  MCP {c.mcpOn.length}/{c.mcpTotal} · Skills {c.skillOn}/{c.skillTotal} · Plugins {c.pluginsOn.length}
                  {d.effectiveBrain ? ` · Brain ${d.effectiveBrain.name}` : ""}
                </p>
              </a>
            </li>
          );
        })}
      </ul>
      {creating ? (
        <CreateDomain busy={busy} onCancel={() => setCreating(false)} onCreate={(n, desc) => onCreate(n, desc).then((ok) => { if (ok) setCreating(false); })} />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="mt-2 w-full px-3 py-2 rounded-xl border border-dashed border-cc-border text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
        >
          New domain
        </button>
      )}
    </nav>
  );
}

function CreateDomain({
  busy,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  onCreate: (name: string, description?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameId = useId();
  const descId = useId();
  const field = "w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[13px] focus:outline-none focus:ring-1 focus:ring-cc-primary";
  return (
    <form
      className="mt-2 p-3 rounded-xl border border-cc-border bg-cc-card space-y-2"
      aria-label="New domain"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        void onCreate(name.trim(), description.trim() || undefined);
      }}
    >
      <p className="text-[11px] text-cc-muted">
        Give a macro-topic its own domain, so its sessions share memory and tools without mixing them with other projects.
      </p>
      <div>
        <label htmlFor={nameId} className="block text-[11px] text-cc-muted">Name</label>
        <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Herd" className={field} />
      </div>
      <div>
        <label htmlFor={descId} className="block text-[11px] text-cc-muted">What it is about (optional)</label>
        <input id={descId} value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Create domain
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer">
          Cancel
        </button>
      </div>
    </form>
  );
}
