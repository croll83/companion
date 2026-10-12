import { useCallback, useEffect, useId, useState } from "react";
import { api, type ConnectedBrowser, type DomainSummary, type DomainsResponse, type PluginInfo, type SkillGroupInfo } from "../api.js";
import { ConfigFileEditor } from "./ConfigFileEditor.js";
import { Toggle } from "./DomainToggle.js";
import { DomainPlugins } from "./DomainPlugins.js";
import { DomainMcpServers, type NewMcpServer } from "./DomainMcpServers.js";

/**
 * Domains page: a domain is the unit that shares context and tools between
 * sessions — memory, skills, MCP servers and instructions — for Claude Code
 * and Codex alike. GLOBAL applies to every session on top of its own domain.
 *
 * Per domain: its folder, session count, memory notes, skills, MCP servers
 * (on/off per domain, add/remove the domain's own), marketplace plugins
 * (on/off per domain), skill groups installed outside the domain (on/off),
 * Claude in Chrome (Claude Code only), CLAUDE.md and mcp.json editing.
 * Deleting a domain removes it from the list only: files stay on disk.
 * Every change applies at the next start or reload of each session.
 */
export function DomainsPage() {
  const [data, setData] = useState<DomainsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ slug: string; file: "CLAUDE.md" | "mcp.json"; name: string } | null>(null);

  const reload = useCallback(() => {
    api.listDomains().then((res) => { setData(res); setError(""); }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /** Run a change, then reload the list; resolves false (error shown) when it failed. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
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
  }

  return (
    <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
        <h1 className="text-lg font-semibold text-cc-fg">Domains</h1>
        <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
          Sessions in a domain share its memory, skills, MCP servers and instructions, whether they run Claude Code or Codex.
          GLOBAL applies to every session in addition to its own domain. Changes apply when a session starts or reloads.
        </p>
        {data && <p className="mt-1 text-[11px] text-cc-muted">Domain folders live in <span className="font-mono-code">{data.root}</span>.</p>}

        <CreateDomain busy={busy} onCreate={(name, description) => run(() => api.createDomain(name, description)).then(() => undefined)} />

        {error && <p role="alert" className="mt-3 text-[12px] text-cc-error">{error}</p>}
        {!data && !error && <p className="mt-6 text-[12px] text-cc-muted">Loading domains...</p>}

        <div className="mt-5 space-y-4">
          {data?.domains.map((d) => (
            <DomainCard
              key={d.slug}
              domain={d}
              skillGroups={data.skillGroups}
              plugins={data.plugins ?? []}
              busy={busy}
              onUpdate={(patch) => run(() => api.updateDomain(d.slug, patch)).then(() => undefined)}
              onAddServer={(name, server) => run(() => api.setDomainMcpServer(d.slug, name, server))}
              onRemoveServer={(name) => run(() => api.removeDomainMcpServer(d.slug, name))}
              onDelete={() => run(() => api.deleteDomain(d.slug)).then(() => undefined)}
              onEdit={(file) => setEditing({ slug: d.slug, file, name: d.name })}
            />
          ))}
        </div>
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

function CreateDomain({ busy, onCreate }: { busy: boolean; onCreate: (name: string, description?: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameId = useId();
  const descId = useId();
  return (
    <form
      className="mt-5 p-3 rounded-xl border border-cc-border bg-cc-card space-y-2"
      aria-label="New domain"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim(), description.trim() || undefined).then(() => { setName(""); setDescription(""); });
      }}
    >
      <h2 className="text-[13px] font-semibold">New domain</h2>
      <p className="text-[11px] text-cc-muted">
        Give a macro-topic its own domain, so its sessions share memory and tools without mixing them with other projects.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1">
          <label htmlFor={nameId} className="block text-[11px] text-cc-muted">Name</label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Herd"
            className="w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[13px] focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
        <div className="flex-[2]">
          <label htmlFor={descId} className="block text-[11px] text-cc-muted">What it is about (optional)</label>
          <input
            id={descId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md bg-cc-input-bg border border-cc-border text-[13px] focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
      </div>
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
      >
        Create domain
      </button>
    </form>
  );
}

const MANUAL = "__manual__";

/**
 * Which browser a domain's Chrome sessions drive. "Prefer local browser"
 * (default) drives the browser on Companion's own machine, falling back to a
 * remote one (so a VPS session can drive the user's Mac). The connected
 * browsers come from a short isolated Claude query; when that list can't be
 * fetched, the user can still prefer local or type a browser deviceId by hand.
 * Claude Code only — Codex is unaffected.
 */
function ChromeBrowserPicker({
  domain,
  busy,
  onUpdate,
}: {
  domain: DomainSummary;
  busy: boolean;
  onUpdate: (patch: Parameters<typeof api.updateDomain>[1]) => Promise<void>;
}) {
  const [browsers, setBrowsers] = useState<ConnectedBrowser[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const selectId = useId();
  const manualId = useId();

  const pref = domain.chromeBrowser || "local";
  const known = pref === "local" || browsers.some((b) => b.deviceId === pref);
  // Show the manual deviceId field when the user asked for it, or when the
  // saved value is a deviceId not in the list (list unfetched, browser offline).
  const [manualMode, setManualMode] = useState(false);
  const [manual, setManual] = useState(pref !== "local" ? pref : "");
  const manualOpen = manualMode || !known;

  const load = useCallback((force?: boolean) => {
    setLoading(true);
    setNote("");
    api.listChromeBrowsers(force)
      .then((res) => {
        setBrowsers(res.browsers);
        if (res.error) setNote(res.error);
        else if (res.browsers.length === 0) setNote("No browser is connected to Claude in Chrome right now.");
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyManual = () => {
    const id = manual.trim();
    if (id && id !== pref) void onUpdate({ chromeBrowser: id });
  };

  return (
    <div className="mt-2 pl-10 space-y-1.5">
      <div className="flex items-center gap-2">
        <label htmlFor={selectId} className="text-[11px] text-cc-muted">Browser to drive</label>
        <select
          id={selectId}
          value={manualOpen ? MANUAL : pref}
          disabled={busy}
          onChange={(e) => {
            if (e.target.value === MANUAL) { setManualMode(true); setManual(pref === "local" ? "" : pref); }
            else { setManualMode(false); setManual(""); void onUpdate({ chromeBrowser: e.target.value }); }
          }}
          className="px-1.5 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary"
        >
          <option value="local">Prefer local browser</option>
          {browsers.map((b) => (
            <option key={b.deviceId} value={b.deviceId}>
              {b.name}{b.osPlatform ? ` (${b.osPlatform})` : ""} · {b.isLocal ? "local" : "remote"}
            </option>
          ))}
          <option value={MANUAL}>Enter a deviceId…</option>
        </select>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={busy || loading}
          className="px-2 py-0.5 rounded-md text-[11px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-wait"
        >
          {loading ? "Detecting…" : "Detect browsers"}
        </button>
      </div>
      {manualOpen && (
        <div className="flex items-center gap-2">
          <label htmlFor={manualId} className="text-[11px] text-cc-muted">Browser deviceId</label>
          <input
            id={manualId}
            value={manual}
            disabled={busy}
            onChange={(e) => setManual(e.target.value)}
            onBlur={applyManual}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyManual(); } }}
            placeholder="deviceId from the list"
            className="w-48 px-2 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
          />
        </div>
      )}
      <p className="text-[10px] text-cc-muted leading-snug">
        "Prefer local browser" drives the browser on this machine, or a remote one (e.g. your Mac) when Companion runs on a
        server and no local browser is connected.
      </p>
      {note && <p role="status" className="text-[10px] text-cc-muted">{note}</p>}
    </div>
  );
}

const CODEX_NOTE: Record<SkillGroupInfo["codex"], string> = {
  linked: "Codex too (linked into its skills)",
  toggled: "Codex too (turned off in its config)",
  unsupported: "Requires Claude Code",
};

function DomainCard({
  domain,
  skillGroups,
  plugins,
  busy,
  onUpdate,
  onDelete,
  onEdit,
  onAddServer,
  onRemoveServer,
}: {
  domain: DomainSummary;
  skillGroups: SkillGroupInfo[];
  plugins: PluginInfo[];
  busy: boolean;
  onUpdate: (patch: Parameters<typeof api.updateDomain>[1]) => Promise<void>;
  onDelete: () => Promise<void>;
  onEdit: (file: "CLAUDE.md" | "mcp.json") => void;
  onAddServer: (name: string, server: NewMcpServer) => Promise<boolean>;
  onRemoveServer: (name: string) => Promise<boolean>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isGlobal = domain.slug === "global";
  const setServer = (name: string, on: boolean) => {
    const off = new Set(domain.mcpDisabled);
    if (on) off.delete(name);
    else off.add(name);
    return onUpdate({ mcpDisabled: [...off] });
  };

  return (
    <article aria-label={`Domain ${domain.name}`} className="p-4 rounded-xl border border-cc-border bg-cc-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">{domain.name}</h2>
          {domain.description && <p className="text-[12px] text-cc-muted">{domain.description}</p>}
          <p className="mt-0.5 text-[11px] text-cc-muted font-mono-code break-all">{domain.path}</p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button type="button" onClick={() => onEdit("CLAUDE.md")} className="px-2 py-1 text-[11px] rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer">
            Edit CLAUDE.md
          </button>
          <button type="button" onClick={() => onEdit("mcp.json")} className="px-2 py-1 text-[11px] rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer">
            Edit mcp.json
          </button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div><dt className="text-cc-muted">Sessions</dt><dd className="font-medium">{domain.sessionCount}</dd></div>
        <div><dt className="text-cc-muted">Memory notes</dt><dd className="font-medium">{domain.memoryNotes}</dd></div>
        <div><dt className="text-cc-muted">Skills</dt><dd className="font-medium">{domain.skills.length > 0 ? domain.skills.join(", ") : "none"}</dd></div>
      </dl>

      <DomainMcpServers
        servers={domain.mcpServers}
        error={domain.mcpError}
        isGlobal={isGlobal}
        busy={busy}
        onToggle={setServer}
        onAdd={onAddServer}
        onRemove={(name) => void onRemoveServer(name)}
      />

      <DomainPlugins
        plugins={plugins}
        states={domain.pluginStates ?? {}}
        isGlobal={isGlobal}
        busy={busy}
        onToggle={(id, on) => void onUpdate({ plugins: { [id]: on } })}
      />

      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Skills installed outside the domain</h3>
      <ul className="mt-1 space-y-1.5">
        {skillGroups.map((g) => {
          const state = domain.skillGroupStates[g.id] ?? { on: true, own: false };
          return (
            <li key={g.id} className="flex items-start gap-2 text-[12px]">
              <Toggle
                label={`Skill group ${g.label}`}
                checked={state.on}
                disabled={busy}
                onChange={(on) => onUpdate({ skillGroups: { [g.id]: on } })}
              />
              <div className="min-w-0">
                <span className="font-medium">{g.label}</span>
                <span className="ml-1.5 text-[10px] text-cc-muted">
                  {g.skills.length} skill{g.skills.length === 1 ? "" : "s"} · {CODEX_NOTE[g.codex]}
                  {!isGlobal && !state.own ? " · as in GLOBAL" : ""}
                </span>
                <p className="text-[11px] text-cc-muted truncate" title={g.skills.join(", ")}>{g.description}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Claude in Chrome</h3>
      <div className="mt-1 flex items-center gap-2 text-[12px]">
        <Toggle label="Claude in Chrome" checked={domain.chrome} disabled={busy} onChange={(on) => onUpdate({ chrome: on })} />
        <span>Start Claude sessions with Chrome on</span>
        <span className="text-[10px] text-cc-muted">Requires Claude Code (Codex sessions are not affected)</span>
      </div>
      {domain.chrome && <ChromeBrowserPicker domain={domain} busy={busy} onUpdate={onUpdate} />}

      {!isGlobal && (
        <div className="mt-4 pt-3 border-t border-cc-separator">
          {confirmDelete ? (
            <div className="space-y-1.5 text-[11px]">
              <p>
                Remove <strong>{domain.name}</strong> from the list? Its folder and files stay on disk ({domain.path}).
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => onDelete().then(() => setConfirmDelete(false))} className="px-2.5 py-1 rounded-md bg-cc-error/15 text-cc-error hover:bg-cc-error/25 cursor-pointer">
                  Remove domain
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="px-2.5 py-1 rounded-md text-cc-muted hover:bg-cc-hover cursor-pointer">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-cc-muted">
                {domain.totalSessions > 0
                  ? `Used by ${domain.totalSessions} session${domain.totalSessions === 1 ? "" : "s"} (archived included): it cannot be removed.`
                  : "Removing a domain never deletes its files."}
              </span>
              <button
                type="button"
                disabled={busy || domain.totalSessions > 0}
                onClick={() => setConfirmDelete(true)}
                className="px-2.5 py-1 rounded-md text-cc-error hover:bg-cc-error/10 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
