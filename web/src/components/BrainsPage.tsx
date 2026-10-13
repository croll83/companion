import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BrainInfo, type BrainInput } from "../api.js";
import { useMediaQuery } from "../hooks/use-media-query.js";
import { brainsHash } from "../utils/routing.js";
import { BrainDetail, type BrainActions } from "./BrainDetail.js";
import { BrainForm } from "./BrainForm.js";
import { BrainList, type BrainHealthState } from "./BrainList.js";
import { Sheet } from "./Sheet.js";

/**
 * Brains page (#/brains): knowledge bases with an MCP server that the
 * sessions of a domain can search and read. Phase 1 connects REMOTE brains
 * (an URL, no auth, a bearer token or OAuth with a pre-registered client).
 * One brain per domain, chosen on the domain's page; a new brain is on
 * nowhere. A health check that refetched the server's skill reloads the list.
 *
 * Phones: the list, then one brain (#/brains/<slug>); desktop: both side by
 * side. "Connect remote brain" opens a sheet. Health is checked once per
 * brain when the page opens, and on demand.
 */
export function BrainsPage({ slug }: { slug?: string } = {}) {
  const [brains, setBrains] = useState<BrainInfo[] | null>(null);
  const [health, setHealth] = useState<Record<string, BrainHealthState>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const desktop = useMediaQuery("(min-width: 1024px)");
  const asked = useRef(new Set<string>());

  const reload = useCallback(() => {
    api.listBrains().then((res) => { setBrains(res.brains); setError(""); }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const checkHealth = useCallback((s: string) => {
    setHealth((h) => ({ ...h, [s]: "checking" }));
    api.brainHealth(s)
      .then((res) => {
        setHealth((h) => ({ ...h, [s]: res }));
        // The server reported another wiki version and its skill was fetched again.
        if (res.skillRefresh === "updated" || res.skillRefresh === "failed") reload();
      })
      .catch((e: unknown) => setHealth((h) => ({ ...h, [s]: { reachable: false, error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() } })));
  }, [reload]);

  useEffect(() => {
    for (const b of brains ?? []) {
      if (asked.current.has(b.slug)) continue;
      asked.current.add(b.slug);
      checkHealth(b.slug);
    }
  }, [brains, checkHealth]);

  /** Run a change, then reload; resolves false (error shown) when it failed. */
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

  const connect = (input: BrainInput) => run(async () => {
    const created = await api.createBrain(input);
    setConnecting(false);
    window.location.hash = brainsHash(created.slug);
  });

  const actions: BrainActions = {
    onUpdate: (s, input) => run(async () => {
      await api.updateBrain(s, input);
      // New URLs or token: check again.
      if (input.baseUrl !== undefined || input.token !== undefined) checkHealth(s);
    }),
    onDelete: (s) => run(() => api.deleteBrain(s)).then((ok) => {
      if (ok) window.location.hash = brainsHash();
      return ok;
    }),
    onAdopt: (s, pluginId) => run(() => api.adoptPluginAsBrain(s, pluginId)),
    onTest: (s) => api.testBrain(s).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }),
    onCheckHealth: checkHealth,
    onRefreshSkill: (s) => run(() => api.refreshBrainSkill(s)),
  };

  const selected = brains?.find((b) => b.slug === slug) ?? (desktop ? brains?.[0] : undefined);
  const unknown = !!brains && !!slug && !brains.some((b) => b.slug === slug);

  const list = brains && (
    <BrainList brains={brains} health={health} selected={selected?.slug} onConnect={() => setConnecting(true)} />
  );
  const detail = selected && (
    <BrainDetail key={selected.slug} brain={selected} health={health[selected.slug]} desktop={desktop} busy={busy} actions={actions} />
  );

  return (
    <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-safe">
        {(desktop || !selected) && (
          <>
            <h1 className="text-lg font-semibold text-cc-fg">Brains</h1>
            <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed max-w-2xl">
              A brain is a knowledge base with an MCP server, such as a curated wiki with its sources. The sessions of a domain
              that uses it, Claude Code and Codex alike, can search and read it. Each domain has at most one brain; a new brain is
              on nowhere until you choose it in a domain (GLOBAL's brain is the default for every domain).
            </p>
            <p className="mt-1 text-[11px] text-cc-muted">
              Memory = the CLI's private notes; Brain = a curated, shared wiki with sources.
            </p>
          </>
        )}

        {error && <p role="alert" className="mt-3 text-[12px] text-cc-error">{error}</p>}
        {!brains && !error && <p className="mt-6 text-[12px] text-cc-muted">Loading brains...</p>}
        {unknown && <p role="alert" className="mt-3 text-[12px] text-cc-error">No brain "{slug}".</p>}

        {brains && (desktop ? (
          <div className="mt-5 grid grid-cols-[280px_1fr] gap-6 items-start">
            <div className="sticky top-0">{list}</div>
            <div className="min-w-0">{detail}</div>
          </div>
        ) : (
          <div className="mt-4">{selected ? detail : list}</div>
        ))}
      </div>

      {connecting && (
        <Sheet title="Connect remote brain" onClose={() => setConnecting(false)}>
          <p className="mb-3 text-[12px] text-cc-muted leading-relaxed">
            A brain that runs elsewhere and is reachable at an URL: a server on your tailnet, a team brain. Companion adds its MCP
            server and a skill to the sessions of the domains you choose; it never writes into the brain.
          </p>
          <BrainForm busy={busy} onSubmit={connect} onCancel={() => setConnecting(false)} />
        </Sheet>
      )}
    </div>
  );
}
