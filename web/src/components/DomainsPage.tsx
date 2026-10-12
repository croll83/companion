import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DomainsResponse } from "../api.js";
import { useMediaQuery } from "../hooks/use-media-query.js";
import type { DomainTab } from "../utils/routing.js";
import { ConfigFileEditor } from "./ConfigFileEditor.js";
import { DomainDetail, type DomainActions } from "./DomainDetail.js";
import { DomainList } from "./DomainList.js";

/**
 * Domains page: a domain is the unit that shares context and tools between
 * sessions — memory, skills, plugins, MCP servers and instructions — for
 * Claude Code and Codex alike. GLOBAL applies to every session on top of
 * its own domain.
 *
 * Phones: the list of domains (#/domains), then one domain (#/domains/<slug>)
 * whose MCP / Skills / Plugins views open as sheets. Desktop: the list on
 * the left, the selected domain on the right with those views as tabs.
 * Every change is a partial update (one switch at a time) and applies when a
 * session starts or reloads.
 */
export function DomainsPage({ slug, tab }: { slug?: string; tab?: DomainTab } = {}) {
  const [data, setData] = useState<DomainsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ slug: string; file: "CLAUDE.md" | "mcp.json"; name: string } | null>(null);
  const desktop = useMediaQuery("(min-width: 1024px)");

  const reload = useCallback(() => {
    api.listDomains().then((res) => { setData(res); setError(""); }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /** Run a change, then reload every domain (states depend on GLOBAL); resolves false (error shown) when it failed. */
  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try {
      await action();
      reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, [reload]);

  // The account's MCP servers (user config, claude.ai connectors) come from a
  // cached `claude mcp list`. When the cache is stale the server refreshes it
  // in the background; the page asks once and reloads when it is done.
  const [refreshingAccount, setRefreshingAccount] = useState(false);
  const refreshAccount = useCallback(() => {
    setRefreshingAccount(true);
    api.refreshAccountMcp().catch(() => {}).finally(() => { setRefreshingAccount(false); reload(); });
  }, [reload]);
  const askedForStale = useRef(false);
  useEffect(() => {
    if (data?.accountMcp?.stale && !askedForStale.current) {
      askedForStale.current = true;
      refreshAccount();
    }
  }, [data?.accountMcp?.stale, refreshAccount]);

  const actions: DomainActions = {
    onPatch: (s, patch) => void run(() => api.updateDomain(s, patch)),
    onAddServer: (s, name, server) => run(() => api.setDomainMcpServer(s, name, server)),
    onRemoveServer: (s, name) => run(() => api.removeDomainMcpServer(s, name)),
    onCreateSkill: (s, name, description) => run(() => api.createDomainSkill(s, name, description)),
    onRemoveSkill: (s, name) => run(() => api.removeDomainSkill(s, name)),
    onDelete: (s) => run(() => api.deleteDomain(s)).then((ok) => {
      if (ok) window.location.hash = "#/domains";
      return ok;
    }),
    onEdit: (s, file) => setEditing({ slug: s, file, name: data?.domains.find((d) => d.slug === s)?.name ?? s }),
    onRefreshAccount: refreshAccount,
  };

  // Desktop always shows a domain (GLOBAL when none is chosen); phones show the list until one is.
  const selected = data?.domains.find((d) => d.slug === slug) ?? (desktop ? data?.domains[0] : undefined);
  const unknown = !!data && !!slug && !data.domains.some((d) => d.slug === slug);

  const list = data && (
    <DomainList
      domains={data.domains}
      groups={data.skillGroups}
      plugins={data.plugins ?? []}
      selected={selected?.slug}
      busy={busy}
      onCreate={(name, description) => run(() => api.createDomain(name, description))}
    />
  );
  const detail = data && selected && (
    <DomainDetail
      domain={selected}
      data={data}
      tab={tab}
      desktop={desktop}
      busy={busy}
      refreshingAccount={refreshingAccount}
      actions={actions}
    />
  );

  return (
    <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-safe">
        {(desktop || !selected) && (
          <>
            <h1 className="text-lg font-semibold text-cc-fg">Domains</h1>
            <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed max-w-2xl">
              Sessions in a domain share its memory, skills, plugins, MCP servers and instructions, whether they run Claude Code or
              Codex. GLOBAL applies to every session and is the default for every domain.
            </p>
            {data && <p className="mt-1 text-[11px] text-cc-muted">Domain folders live in <span className="font-mono-code">{data.root}</span>.</p>}
          </>
        )}

        {error && <p role="alert" className="mt-3 text-[12px] text-cc-error">{error}</p>}
        {!data && !error && <p className="mt-6 text-[12px] text-cc-muted">Loading domains...</p>}
        {unknown && <p role="alert" className="mt-3 text-[12px] text-cc-error">No domain "{slug}".</p>}

        {data && (desktop ? (
          <div className="mt-5 grid grid-cols-[280px_1fr] gap-6 items-start">
            <div className="sticky top-0">{list}</div>
            <div className="min-w-0">{detail}</div>
          </div>
        ) : (
          <div className="mt-4">{selected ? detail : list}</div>
        ))}
      </div>

      {editing && (
        <ConfigFileEditor
          domain={editing.slug}
          path={editing.file}
          label={`${editing.name}: ${editing.file}`}
          description={editing.file === "CLAUDE.md"
            ? "Instructions for every Claude Code and Codex session of the domain"
            : "MCP servers of the domain ({\"mcpServers\": {...}}), turned on or off per domain"}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
