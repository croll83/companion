import { useState } from "react";
import type { DomainPatch, DomainSummary, DomainsResponse } from "../api.js";
import { domainsHash, type DomainTab } from "../utils/routing.js";
import { DomainBrain } from "./DomainBrain.js";
import { DomainChrome } from "./DomainChrome.js";
import { domainCounts } from "./DomainList.js";
import { DomainMcpServers, type NewMcpServer } from "./DomainMcpServers.js";
import { DomainPlugins } from "./DomainPlugins.js";
import { DomainSkills } from "./DomainSkills.js";
import { Sheet } from "./Sheet.js";

const TABS: { id: DomainTab; label: string }[] = [
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
];

function names(list: string[], max = 3): string {
  if (list.length === 0) return "none";
  return list.slice(0, max).join(", ") + (list.length > max ? ` +${list.length - max}` : "");
}

export interface DomainActions {
  onPatch: (slug: string, patch: DomainPatch) => void;
  onAddServer: (slug: string, name: string, server: NewMcpServer) => Promise<boolean>;
  onRemoveServer: (slug: string, name: string) => Promise<boolean>;
  onCreateSkill: (slug: string, name: string, description: string) => Promise<boolean>;
  onRemoveSkill: (slug: string, name: string) => Promise<boolean>;
  onDelete: (slug: string) => Promise<boolean>;
  onEdit: (slug: string, file: "CLAUDE.md" | "mcp.json") => void;
  onRefreshAccount: () => void;
}

/**
 * One domain: what it has on, by name (MCP servers, skills, plugins), Claude
 * in Chrome, and its files. MCP / Skills / Plugins open their view: tabs
 * under the summary on desktop, a sheet on phones (#/domains/<slug>/<tab>,
 * so the phone's Back closes it). Changes apply when a session starts or
 * reloads.
 */
export function DomainDetail({
  domain,
  data,
  tab,
  desktop,
  busy,
  refreshingAccount,
  actions,
}: {
  domain: DomainSummary;
  data: DomainsResponse;
  tab?: DomainTab;
  desktop: boolean;
  busy: boolean;
  refreshingAccount: boolean;
  actions: DomainActions;
}) {
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isGlobal = domain.slug === "global";
  const plugins = data.plugins ?? [];
  const c = domainCounts(domain, data.skillGroups, plugins);
  const skillsOff = data.skillGroups.flatMap((g) => g.skills.filter((n) => domain.skillStates?.[`${g.id}:${n}`]?.on === false));
  const shown: DomainTab = tab ?? "mcp";

  const view = (t: DomainTab) => {
    if (t === "mcp") {
      return (
        <DomainMcpServers
          domain={domain}
          domains={data.domains}
          plugins={c.pluginsOn}
          accountMcp={data.accountMcp}
          refreshingAccount={refreshingAccount}
          onRefreshAccount={actions.onRefreshAccount}
          busy={busy}
          onSetMcp={(slug, name, value) => actions.onPatch(slug, { mcp: { [name]: value } })}
          onAdd={actions.onAddServer}
          onRemove={actions.onRemoveServer}
        />
      );
    }
    if (t === "skills") {
      return (
        <DomainSkills
          domain={domain}
          groups={data.skillGroups}
          busy={busy}
          onPatch={actions.onPatch}
          onCreateSkill={actions.onCreateSkill}
          onRemoveSkill={actions.onRemoveSkill}
        />
      );
    }
    return (
      <DomainPlugins
        domain={domain}
        domains={data.domains}
        plugins={plugins}
        busy={busy}
        onSetPlugin={(slug, id, value) => actions.onPatch(slug, { plugins: { [id]: value } })}
      />
    );
  };

  const summary: Record<DomainTab, string> = {
    mcp: `${c.mcpOn.length} of ${c.mcpTotal} on: ${names(c.mcpOn.map((s) => s.name))}`,
    skills: `${c.skillOn} of ${c.skillTotal} on${skillsOff.length ? ` · off: ${names(skillsOff)}` : ""}`,
    plugins: `${c.pluginsOn.length} on${c.pluginsOn.length ? `: ${names(c.pluginsOn.map((p) => p.name))}` : ""}`,
  };

  return (
    <article aria-label={`Domain ${domain.name}`} className="space-y-4">
      <header>
        {!desktop && (
          <a href={domainsHash()} className="text-[12px] text-cc-primary hover:underline">‹ Domains</a>
        )}
        <div className="mt-1 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold">{domain.name}</h2>
            {domain.description && <p className="text-[12px] text-cc-muted">{domain.description}</p>}
            <p className="text-[11px] text-cc-muted font-mono-code break-all">{domain.path}</p>
            <p className="text-[11px] text-cc-muted">
              {domain.sessionCount} session{domain.sessionCount === 1 ? "" : "s"} · {domain.memoryNotes} memory notes
              {domain.effectiveBrain ? ` · brain ${domain.effectiveBrain.name}` : ""}
              {isGlobal ? " · applies to every session" : ""}
            </p>
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label="Domain actions"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
              className="w-8 h-8 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
            >
              ⋯
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 mt-1 z-10 w-44 rounded-lg border border-cc-border bg-cc-card shadow-lg py-1 text-[12px]">
                <button type="button" role="menuitem" onClick={() => { setMenu(false); actions.onEdit(domain.slug, "CLAUDE.md"); }} className="block w-full text-left px-3 py-1.5 hover:bg-cc-hover cursor-pointer">
                  Edit CLAUDE.md
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); actions.onEdit(domain.slug, "mcp.json"); }} className="block w-full text-left px-3 py-1.5 hover:bg-cc-hover cursor-pointer">
                  Edit mcp.json
                </button>
                {!isGlobal && (
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setConfirmDelete(true); }} className="block w-full text-left px-3 py-1.5 text-cc-error hover:bg-cc-error/10 cursor-pointer">
                    Remove domain…
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {confirmDelete && (
          <div role="alert" className="mt-2 p-2 rounded-lg border border-cc-error/30 text-[12px] space-y-1.5">
            {domain.totalSessions > 0 ? (
              <p>Used by {domain.totalSessions} session{domain.totalSessions === 1 ? "" : "s"} (archived included): move or delete them first.</p>
            ) : (
              <p>Remove <strong>{domain.name}</strong> from the list? Its folder and files stay on disk.</p>
            )}
            <div className="flex gap-2">
              {domain.totalSessions === 0 && (
                <button type="button" onClick={() => void actions.onDelete(domain.slug)} className="px-2.5 py-1 rounded-md bg-cc-error/15 text-cc-error hover:bg-cc-error/25 cursor-pointer">
                  Remove domain
                </button>
              )}
              <button type="button" onClick={() => setConfirmDelete(false)} className="px-2.5 py-1 rounded-md text-cc-muted hover:bg-cc-hover cursor-pointer">
                Cancel
              </button>
            </div>
          </div>
        )}
      </header>

      {desktop ? (
        <div>
          <div role="tablist" aria-label="Domain settings" className="flex gap-1 border-b border-cc-border">
            {TABS.map((t) => (
              <a
                key={t.id}
                role="tab"
                aria-selected={shown === t.id}
                href={domainsHash(domain.slug, t.id)}
                className={`px-3 py-2 text-[12px] -mb-px border-b-2 ${shown === t.id ? "border-cc-primary text-cc-fg font-medium" : "border-transparent text-cc-muted hover:text-cc-fg"}`}
              >
                {t.label}
                <span className="block text-[10px] font-normal text-cc-muted truncate max-w-[220px]">{summary[t.id]}</span>
              </a>
            ))}
          </div>
          <div role="tabpanel" aria-label={TABS.find((t) => t.id === shown)!.label} className="pt-3">{view(shown)}</div>
        </div>
      ) : (
        <ul className="rounded-xl border border-cc-border bg-cc-card divide-y divide-cc-separator">
          {TABS.map((t) => (
            <li key={t.id}>
              <a href={domainsHash(domain.slug, t.id)} className="flex items-center gap-2 px-3 py-3 hover:bg-cc-hover">
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium">{t.label}</span>
                  <span className="block text-[11px] text-cc-muted truncate">{summary[t.id]}</span>
                </div>
                <span aria-hidden="true" className="text-cc-muted">›</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <DomainBrain
        domain={domain}
        brains={data.brains ?? []}
        globalBrain={data.domains.find((d) => d.slug === "global")?.effectiveBrain?.name}
        busy={busy}
        onChange={(brain) => actions.onPatch(domain.slug, { brain })}
      />

      <DomainChrome domain={domain} busy={busy} onUpdate={async (patch) => actions.onPatch(domain.slug, patch)} />

      {!desktop && tab && (
        <Sheet title={`${domain.name} · ${TABS.find((t) => t.id === tab)!.label}`} onClose={() => { window.location.hash = domainsHash(domain.slug); }}>
          {view(tab)}
        </Sheet>
      )}
    </article>
  );
}
