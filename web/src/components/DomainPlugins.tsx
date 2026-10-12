import { useState } from "react";
import type { DomainSummary, PluginInfo } from "../api.js";
import { Toggle } from "./DomainToggle.js";

/**
 * The plugins view of one domain: the Claude Code marketplace plugins
 * installed for the user, each on or off for this domain (or reset to
 * GLOBAL's choice, and for GLOBAL to the user's Claude settings). A plugin
 * brings its skills and MCP servers: Claude sessions load it whole
 * (`enabledPlugins`), Codex sessions get its MCP servers and skills
 * (commands, agents and hooks stay Claude-only). The details list what it
 * brings and the same switch for every other domain.
 */
export function DomainPlugins({
  domain,
  domains,
  plugins,
  busy,
  onSetPlugin,
}: {
  domain: DomainSummary;
  domains: DomainSummary[];
  plugins: PluginInfo[];
  busy: boolean;
  /** Turn a plugin on/off for a domain, or (null) back to the inherited state. */
  onSetPlugin: (slug: string, id: string, value: boolean | null) => void;
}) {
  if (plugins.length === 0) {
    return (
      <p className="text-[12px] text-cc-muted">
        No plugins installed. Install one for the user with <span className="font-mono-code">claude plugin install</span>, then turn it on here.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-cc-separator">
        {plugins.map((p) => (
          <PluginRow key={p.id} plugin={p} domain={domain} domains={domains} busy={busy} onSetPlugin={onSetPlugin} />
        ))}
      </ul>
      <p className="text-[11px] text-cc-muted">
        Codex sessions get each plugin's MCP servers and skills; its commands, agents and hooks require Claude Code.
        Changes apply when a session of the domain starts or reloads.
      </p>
    </div>
  );
}

function PluginRow({
  plugin: p,
  domain,
  domains,
  busy,
  onSetPlugin,
}: {
  plugin: PluginInfo;
  domain: DomainSummary;
  domains: DomainSummary[];
  busy: boolean;
  onSetPlugin: (slug: string, id: string, value: boolean | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isGlobal = domain.slug === "global";
  const state = domain.pluginStates[p.id] ?? { on: p.enabledByUser, own: false };
  const inherited = isGlobal ? "As in your Claude settings" : "As in GLOBAL";
  const brings = [
    p.skills.length > 0 ? `${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}` : "",
    p.mcpServers.length > 0 ? `${p.mcpServers.length} MCP` : "",
  ].filter(Boolean).join(" · ");

  return (
    <li className="py-2">
      <div className="flex items-center gap-2 min-w-0">
        <Toggle label={`Plugin ${p.name}`} checked={state.on} disabled={busy} onChange={(on) => onSetPlugin(domain.slug, p.id, on)} />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`Details of ${p.name}`}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <span className="block text-[13px] font-medium truncate">{p.name}</span>
          <span className="block text-[10px] text-cc-muted truncate">
            {p.marketplace}{p.version ? ` · v${p.version}` : ""}{brings ? ` · ${brings}` : ""}
          </span>
        </button>
        <span className={`shrink-0 text-[10px] ${state.own ? "text-cc-fg" : "text-cc-muted"}`}>
          {state.own ? (state.on ? "On here" : "Off here") : inherited}
        </span>
        {state.own && (
          <button
            type="button"
            onClick={() => onSetPlugin(domain.slug, p.id, null)}
            disabled={busy}
            aria-label={`Reset ${p.name} to ${isGlobal ? "your Claude settings" : "GLOBAL's choice"}`}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-40"
          >
            Reset
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 pl-10 space-y-2 text-[11px]">
          {p.description && <p className="text-cc-muted">{p.description}</p>}
          {p.skills.length > 0 && <p><span className="text-cc-muted">Skills:</span> {p.skills.join(", ")}</p>}
          {p.mcpServers.length > 0 && (
            <p><span className="text-cc-muted">MCP servers:</span> {p.mcpServers.map((s) => `${s.name} (${s.type})`).join(", ")}</p>
          )}
          <div role="group" aria-label={`${p.name} in the other domains`}>
            <p className="text-cc-muted">Other domains</p>
            <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
              {domains.filter((d) => d.slug !== domain.slug).map((d) => (
                <li key={d.slug} className="flex items-center gap-2">
                  <Toggle
                    label={`${p.name} in ${d.name}`}
                    checked={d.pluginStates[p.id]?.on ?? p.enabledByUser}
                    disabled={busy}
                    onChange={(on) => onSetPlugin(d.slug, p.id, on)}
                  />
                  <span className="truncate">{d.name}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}
