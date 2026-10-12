import { useId, useMemo, useState } from "react";
import type { DomainMcpServerView, DomainSummary, DomainsResponse, PluginInfo } from "../api.js";
import { useStore } from "../store.js";
import { Toggle } from "./DomainToggle.js";
import { McpServerAuth } from "./McpServerAuth.js";

export type NewMcpServer = { url: string } | { command: string; args?: string[] };

const EMPTY: never[] = [];

/**
 * The MCP view of one domain (a sheet on phones, a tab on desktop). Servers
 * are grouped by where they come from: the domain's own mcp.json, GLOBAL's,
 * the ones every Claude session loads by itself (the user's config and the
 * claude.ai connectors: Claude only), and the ones its plugins bring (they
 * follow the plugin). Each can be turned on or off for this domain, or reset
 * to GLOBAL's choice; the details show where it runs now (live status of the
 * domain's open sessions), sign-in, removal, and the same switch for every
 * other domain. Claude and Codex sessions get the same servers, except the
 * Claude-only ones.
 */
export function DomainMcpServers({
  domain,
  domains,
  plugins,
  accountMcp,
  refreshingAccount,
  onRefreshAccount,
  busy,
  onSetMcp,
  onAdd,
  onRemove,
}: {
  domain: DomainSummary;
  domains: DomainSummary[];
  /** The plugins on for this domain (their servers are listed read-only). */
  plugins: PluginInfo[];
  accountMcp?: DomainsResponse["accountMcp"];
  refreshingAccount: boolean;
  onRefreshAccount: () => void;
  busy: boolean;
  /** Turn a server on/off for a domain, or (null) back to GLOBAL's choice. */
  onSetMcp: (slug: string, name: string, value: boolean | null) => void;
  /** Resolves true when the server was saved. */
  onAdd: (slug: string, name: string, server: NewMcpServer) => Promise<boolean>;
  onRemove: (slug: string, name: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const filterId = useId();
  const isGlobal = domain.slug === "global";
  const live = useLiveMcp(domain.slug);

  const match = (s: { name: string; target: string }) => {
    const q = filter.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.target.toLowerCase().includes(q);
  };
  const servers = domain.mcpServers.filter(match);
  const sections: { key: string; title: string; note?: string; items: DomainMcpServerView[] }[] = [
    { key: "domain", title: "This domain", items: servers.filter((s) => s.source === "domain") },
    { key: "global", title: isGlobal ? "GLOBAL's mcp.json" : "From GLOBAL", items: servers.filter((s) => s.source === "global") },
    {
      key: "account",
      title: "Your Claude config and claude.ai",
      note: "Claude only: every Claude session loads these by itself; Codex never gets them.",
      items: servers.filter((s) => s.source === "account"),
    },
  ];
  const pluginServers = plugins.flatMap((p) => p.mcpServers.map((s) => ({ ...s, plugin: p.name }))).filter(match);

  return (
    <div className="space-y-4">
      {domain.mcpServers.length > 8 && (
        <div>
          <label htmlFor={filterId} className="sr-only">Filter MCP servers</label>
          <input
            id={filterId}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter servers"
            className="w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[13px] focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
      )}
      {domain.mcpError && <p role="alert" className="text-[12px] text-cc-error">{domain.mcpError}</p>}

      {sections.map((sec) => (
        (sec.items.length > 0 || sec.key === "account") && (
          <section key={sec.key} aria-label={sec.title}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">
              {sec.title} <span className="font-normal">({sec.items.length})</span>
            </h3>
            {sec.key === "account" && (
              <AccountStatus info={accountMcp} refreshing={refreshingAccount} onRefresh={onRefreshAccount} note={sec.note!} />
            )}
            <ul className="mt-1 divide-y divide-cc-separator">
              {sec.items.map((s) => (
                <McpRow
                  key={s.name}
                  server={s}
                  domain={domain}
                  domains={domains}
                  live={live.get(s.name)}
                  busy={busy}
                  onSetMcp={onSetMcp}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          </section>
        )
      ))}

      {pluginServers.length > 0 && (
        <section aria-label="From plugins">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">
            From plugins <span className="font-normal">({pluginServers.length})</span>
          </h3>
          <ul className="mt-1 space-y-1">
            {pluginServers.map((s) => (
              <li key={`${s.plugin}:${s.name}`} className="text-[12px]">
                <span className="font-mono-code">{s.name}</span>
                <span className="ml-1.5 text-[10px] text-cc-muted">{s.type} · comes with the plugin {s.plugin} (turn it off in Plugins)</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding ? (
        <AddServerForm
          isGlobal={isGlobal}
          busy={busy}
          onCancel={() => setAdding(false)}
          onAdd={(target, name, server) => onAdd(target === "global" ? "global" : domain.slug, name, server).then((ok) => { if (ok) setAdding(false); })}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={busy || !!domain.mcpError}
          className="px-3 py-1.5 rounded-lg text-[12px] border border-cc-border hover:bg-cc-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add server
        </button>
      )}
      <p className="text-[11px] text-cc-muted">Changes apply when a session of the domain starts or reloads.</p>
    </div>
  );
}

/** Live status of each server across the domain's open sessions, and a session able to run its sign-in. */
interface LiveMcp {
  counts: Record<string, number>;
  /** A connected session of the domain where the server waits for a login. */
  signInSession?: string;
}

function useLiveMcp(slug: string): Map<string, LiveMcp> {
  const sdkSessions = useStore((s) => s.sdkSessions);
  const mcpServers = useStore((s) => s.mcpServers);
  const cliConnected = useStore((s) => s.cliConnected);
  return useMemo(() => {
    const out = new Map<string, LiveMcp>();
    for (const sdk of sdkSessions ?? EMPTY) {
      if ((sdk.domain || "global") !== slug || sdk.archived) continue;
      for (const srv of mcpServers.get(sdk.sessionId) ?? EMPTY) {
        // Claude reports plugin servers as plugin:<plugin>:<name>; the row is the plain name.
        const name = srv.name.startsWith("plugin:") ? srv.name.split(":").pop()! : srv.name;
        const entry = out.get(name) ?? { counts: {} };
        entry.counts[srv.status] = (entry.counts[srv.status] ?? 0) + 1;
        if (srv.status === "needs-auth" && cliConnected.get(sdk.sessionId) && !entry.signInSession) {
          entry.signInSession = sdk.sessionId;
        }
        out.set(name, entry);
      }
    }
    return out;
  }, [sdkSessions, mcpServers, cliConnected, slug]);
}

function stateLabel(s: DomainMcpServerView, isGlobal: boolean): string {
  if (isGlobal) return s.own ? (s.enabled ? "On by default" : "Off by default in every domain") : "On (default)";
  if (s.own) return s.enabled ? "On here" : "Off here";
  return s.disabledGlobally ? "Off in GLOBAL" : "As in GLOBAL";
}

function McpRow({
  server: s,
  domain,
  domains,
  live,
  busy,
  onSetMcp,
  onRemove,
}: {
  server: DomainMcpServerView;
  domain: DomainSummary;
  domains: DomainSummary[];
  live?: LiveMcp;
  busy: boolean;
  onSetMcp: (slug: string, name: string, value: boolean | null) => void;
  onRemove: (slug: string, name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const isGlobal = domain.slug === "global";
  const removable = s.source === "domain" || (isGlobal && s.source === "global");
  const liveText = live
    ? Object.entries(live.counts).map(([status, n]) => `${status} in ${n}`).join(" · ")
    : "";
  const others = domains.filter((d) => d.slug !== domain.slug)
    .map((d) => ({ d, entry: d.mcpServers.find((x) => x.name === s.name) }))
    .filter((o): o is { d: DomainSummary; entry: DomainMcpServerView } => !!o.entry);

  return (
    <li className="py-2">
      <div className="flex items-center gap-2 min-w-0">
        <Toggle label={`MCP server ${s.name}`} checked={s.enabled} disabled={busy} onChange={(on) => onSetMcp(domain.slug, s.name, on)} />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`Details of ${s.name}`}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <span className="block text-[13px] font-medium truncate">{s.name}</span>
          <span className="block text-[10px] text-cc-muted truncate">
            {s.type}{s.target ? ` · ${s.target}` : ""}{s.health && s.health !== "connected" ? ` · ${s.health}` : ""}
          </span>
        </button>
        <span className={`shrink-0 text-[10px] ${s.own ? "text-cc-fg" : "text-cc-muted"}`}>{stateLabel(s, isGlobal)}</span>
        {s.own && (
          <button
            type="button"
            onClick={() => onSetMcp(domain.slug, s.name, null)}
            disabled={busy}
            aria-label={`Reset ${s.name} to ${isGlobal ? "the default" : "GLOBAL's choice"}`}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-40"
          >
            Reset
          </button>
        )}
      </div>

      {(live?.signInSession || open) && (
        <div className="mt-2 pl-10 space-y-2 text-[11px]">
          {live?.signInSession && (
            <div>
              <McpServerAuth sessionId={live.signInSession} serverName={s.name} />
              <p className="mt-0.5 text-cc-muted">One sign-in serves every session of the same CLI.</p>
            </div>
          )}
          {open && (
            <>
              <p className="font-mono-code break-all text-cc-muted">{s.target || "(no target)"}</p>
              <p className="text-cc-muted">
                {liveText ? `Now: ${liveText} open session(s) of this domain` : "Not running in an open session of this domain."}
                {s.source === "account" ? " Claude only." : ""}
              </p>
              {s.source === "account" && s.type === "claude.ai" && (
                <p>
                  <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer" className="text-cc-primary hover:underline">
                    Manage this connector on claude.ai
                  </a>
                </p>
              )}
              {others.length > 0 && (
                <div role="group" aria-label={`${s.name} in the other domains`}>
                  <p className="text-cc-muted">Other domains</p>
                  <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {others.map(({ d, entry }) => (
                      <li key={d.slug} className="flex items-center gap-2">
                        <Toggle
                          label={`${s.name} in ${d.name}`}
                          checked={entry.enabled}
                          disabled={busy}
                          onChange={(on) => onSetMcp(d.slug, s.name, on)}
                        />
                        <span className="truncate">{d.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {removable && (
                confirmRemove ? (
                  <div className="flex items-center gap-2">
                    <span>Remove {s.name} from {isGlobal ? "GLOBAL" : domain.name}'s mcp.json?</span>
                    <button
                      type="button"
                      onClick={() => void onRemove(domain.slug, s.name).then(() => setConfirmRemove(false))}
                      className="px-2 py-0.5 rounded bg-cc-error/15 text-cc-error hover:bg-cc-error/25 cursor-pointer"
                    >
                      Remove
                    </button>
                    <button type="button" onClick={() => setConfirmRemove(false)} className="px-2 py-0.5 rounded text-cc-muted hover:bg-cc-hover cursor-pointer">
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    disabled={busy}
                    aria-label={`Remove MCP server ${s.name}`}
                    className="px-2 py-0.5 rounded text-cc-muted hover:text-cc-error hover:bg-cc-error/10 cursor-pointer disabled:opacity-40"
                  >
                    Remove…
                  </button>
                )
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Age of the account's server list (a cached `claude mcp list`), with a button to read it again. */
function AccountStatus({
  info,
  refreshing,
  onRefresh,
  note,
}: {
  info?: DomainsResponse["accountMcp"];
  refreshing: boolean;
  onRefresh: () => void;
  note: string;
}) {
  const minutes = info?.at ? Math.max(0, Math.round((Date.now() - info.at) / 60_000)) : null;
  return (
    <div className="mt-0.5 text-[11px] text-cc-muted">
      <p>{note}</p>
      <div className="flex items-center gap-2">
        <span>
          List {refreshing ? "being read..." : minutes === null ? "not read yet" : `read ${minutes === 0 ? "just now" : `${minutes} min ago`}`}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="px-1.5 py-0.5 rounded text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Refresh
        </button>
      </div>
      {info?.error && !refreshing && <p role="alert" className="text-cc-error">{info.error}</p>}
    </div>
  );
}

function AddServerForm({
  isGlobal,
  busy,
  onCancel,
  onAdd,
}: {
  isGlobal: boolean;
  busy: boolean;
  onCancel: () => void;
  onAdd: (target: "domain" | "global", name: string, server: NewMcpServer) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"url" | "command">("url");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [where, setWhere] = useState<"domain" | "global">("domain");
  const ids = { name: useId(), kind: useId(), target: useId(), args: useId(), where: useId() };
  const field = "w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary";
  return (
    <form
      aria-label="Add MCP server"
      className="p-3 rounded-lg border border-cc-border space-y-2 text-[11px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !target.trim()) return;
        const server: NewMcpServer = kind === "url"
          ? { url: target.trim() }
          : { command: target.trim(), args: args.split(/\s+/).filter(Boolean) };
        void onAdd(isGlobal ? "global" : where, name.trim(), server);
      }}
    >
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <label htmlFor={ids.name} className="block text-cc-muted">Name</label>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" className={field} />
        </div>
        <div>
          <label htmlFor={ids.kind} className="block text-cc-muted">Type</label>
          <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as "url" | "command")} className={field}>
            <option value="url">HTTP (URL)</option>
            <option value="command">stdio (command)</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={ids.target} className="block text-cc-muted">{kind === "url" ? "URL" : "Command"}</label>
        <input
          id={ids.target}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={kind === "url" ? "http://host:port/mcp" : "npx"}
          className={`${field} font-mono-code`}
        />
      </div>
      {kind === "command" && (
        <div>
          <label htmlFor={ids.args} className="block text-cc-muted">Arguments (space separated)</label>
          <input id={ids.args} value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y some-mcp-server" className={`${field} font-mono-code`} />
        </div>
      )}
      {!isGlobal && (
        <div>
          <label htmlFor={ids.where} className="block text-cc-muted">Add to</label>
          <select id={ids.where} value={where} onChange={(e) => setWhere(e.target.value as "domain" | "global")} className={field}>
            <option value="domain">This domain</option>
            <option value="global">GLOBAL (every domain)</option>
          </select>
        </div>
      )}
      <p className="text-cc-muted">Env variables and headers (tokens) go in mcp.json: use "Edit mcp.json" in the domain's menu.</p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim() || !target.trim()}
          className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Add
        </button>
        <button type="button" onClick={onCancel} className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer">
          Cancel
        </button>
      </div>
    </form>
  );
}
