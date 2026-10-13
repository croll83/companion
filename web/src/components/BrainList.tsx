import type { BrainHealth, BrainInfo } from "../api.js";
import { brainsHash } from "../utils/routing.js";

/** A brain's health as the page knows it: not asked yet / being checked, or the last answer. */
export type BrainHealthState = BrainHealth | "checking" | undefined;

/** One line for a health answer: "Reachable · 80 pages · v0.3.0", or why not. */
export function healthText(health: BrainHealthState): string {
  if (!health || health === "checking") return "Checking…";
  if (!health.reachable) return `Unreachable${health.error ? `: ${health.error}` : ""}`;
  return ["Reachable", health.pages !== undefined ? `${health.pages} pages` : "", health.version ? `v${health.version}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** Green when reachable, red when not, grey while checking. */
export function HealthDot({ health }: { health: BrainHealthState }) {
  const color = !health || health === "checking" ? "bg-cc-muted" : health.reachable ? "bg-cc-success" : "bg-cc-error";
  return <span role="img" aria-label={healthText(health)} title={healthText(health)} className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

/** "GLOBAL (default), Herd" or "no domain". */
export function brainDomainsText(brain: BrainInfo): string {
  if (brain.domains.length === 0) return "On no domain";
  return `Used by ${brain.domains.map((d) => (d.slug === "global" ? "GLOBAL (default)" : d.name)).join(", ")}`;
}

/**
 * The list of brains: name, about, URL, health, and the domains using each.
 * A row opens the brain (#/brains/<slug>); "Connect remote brain" opens the form.
 */
export function BrainList({
  brains,
  health,
  selected,
  onConnect,
}: {
  brains: BrainInfo[];
  health: Record<string, BrainHealthState>;
  selected?: string;
  onConnect: () => void;
}) {
  return (
    <nav aria-label="Brains">
      {brains.length > 0 ? (
        <ul className="divide-y divide-cc-separator rounded-xl border border-cc-border bg-cc-card overflow-hidden">
          {brains.map((b) => (
            <li key={b.slug}>
              <a
                href={brainsHash(b.slug)}
                aria-current={b.slug === selected ? "page" : undefined}
                className={`block px-3 py-2.5 hover:bg-cc-hover ${b.slug === selected ? "bg-cc-active" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <HealthDot health={health[b.slug]} />
                  <span className="text-[13px] font-semibold truncate">{b.name}</span>
                  <span className="ml-auto text-[10px] text-cc-muted shrink-0">Remote</span>
                </div>
                {b.about && <p className="text-[11px] text-cc-muted truncate">{b.about}</p>}
                <p className="text-[10px] text-cc-muted font-mono-code truncate">{b.remote?.baseUrl ?? b.urls.mcpUrl}</p>
                <p className="text-[10px] text-cc-muted">
                  {brainDomainsText(b)}
                  {b.collisions.some((c) => c.domains.length > 0) ? " · a plugin serves the same URL" : ""}
                </p>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-cc-border bg-cc-card px-3 py-3 text-[12px] text-cc-muted">
          No brain yet. Connect a remote one: a knowledge base with an MCP server, such as a wiki on your tailnet.
        </p>
      )}
      <button
        type="button"
        onClick={onConnect}
        className="mt-2 w-full px-3 py-2 rounded-xl border border-dashed border-cc-border text-[12px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
      >
        Connect remote brain
      </button>
    </nav>
  );
}
