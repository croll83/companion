import type { PluginInfo } from "../api.js";
import { Toggle } from "./DomainToggle.js";

/**
 * The Claude Code marketplace plugins installed for the user, each turned on
 * or off for one domain. A plugin brings its skills and MCP servers: Claude
 * sessions load it whole (`enabledPlugins`), Codex sessions get its MCP
 * servers and skills (commands, agents and hooks stay Claude-only). Without a
 * choice of its own a domain follows GLOBAL, and GLOBAL the user's settings.
 */
export function DomainPlugins({
  plugins,
  states,
  isGlobal,
  busy,
  onToggle,
}: {
  plugins: PluginInfo[];
  states: Record<string, { on: boolean; own: boolean }>;
  isGlobal: boolean;
  busy: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div role="group" aria-label="Plugins">
      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Plugins</h3>
      {plugins.length === 0 ? (
        <p className="text-[11px] text-cc-muted">
          No plugins installed. Install one for the user with <span className="font-mono-code">claude plugin install</span>, then turn it on here.
        </p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {plugins.map((p) => {
            const state = states[p.id] ?? { on: p.enabledByUser, own: false };
            const brings = [
              p.skills.length > 0 ? `${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}` : "",
              p.mcpServers.length > 0 ? `MCP: ${p.mcpServers.map((s) => s.name).join(", ")}` : "",
            ].filter(Boolean).join(" · ");
            const inherited = isGlobal ? "as in your Claude settings" : "as in GLOBAL";
            return (
              <li key={p.id} className="flex items-start gap-2 text-[12px]">
                <Toggle label={`Plugin ${p.name}`} checked={state.on} disabled={busy} onChange={(on) => onToggle(p.id, on)} />
                <div className="min-w-0">
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-1.5 text-[10px] text-cc-muted">
                    {p.marketplace}{p.version ? ` · v${p.version}` : ""}{brings ? ` · ${brings}` : ""}
                    {!state.own ? ` · ${inherited}` : ""}
                  </span>
                  {p.description && <p className="text-[11px] text-cc-muted line-clamp-2">{p.description}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {plugins.length > 0 && (
        <p className="mt-1 text-[10px] text-cc-muted">
          Codex sessions get each plugin's MCP servers and skills; its commands, agents and hooks require Claude Code.
        </p>
      )}
    </div>
  );
}
