import { useEffect, useId, useState } from "react";
import { api, type DomainSummary } from "../../api.js";
import { FolderPicker } from "../FolderPicker.js";

export type FolderMode = "new" | "existing";

const NEW_DOMAIN = "__new__";

/** "Brave Falcon" → "brave-falcon" (what the server will create). */
export function folderSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

interface Props {
  domain: string;
  onDomainChange: (slug: string) => void;
  folderMode: FolderMode;
  onFolderModeChange: (mode: FolderMode) => void;
  /** Name of the new folder (inside the domain folder). */
  folderName: string;
  onFolderNameChange: (name: string) => void;
  /** The existing folder to attach. */
  cwd: string;
  onCwdChange: (path: string) => void;
}

/**
 * Where a new session runs (home page). It replaces the plain folder picker:
 *  - Domain: GLOBAL by default, or a domain (created inline with "+ New
 *    domain"). Sessions in a domain share its memory, skills, MCP servers
 *    and instructions — Claude Code and Codex alike.
 *  - Folder: a new folder inside the domain (named after the session, created
 *    by the server) or an existing folder attached where it is (never moved).
 */
export function DomainFolderPicker({
  domain,
  onDomainChange,
  folderMode,
  onFolderModeChange,
  folderName,
  onFolderNameChange,
  cwd,
  onCwdChange,
}: Props) {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const selectId = useId();
  const newDomainId = useId();
  const folderNameId = useId();
  const noteId = useId();

  useEffect(() => {
    let alive = true;
    api.listDomains().then((res) => {
      if (!alive) return;
      setDomains(res.domains);
      // A remembered domain that no longer exists falls back to GLOBAL.
      if (!res.domains.some((d) => d.slug === domain)) onDomainChange("global");
    }).catch(() => {});
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = domains.find((d) => d.slug === domain);
  const target = folderMode === "new"
    ? `${current?.path ?? `companion_domain_${domain}`}/${folderSlug(folderName) || "…"}`
    : cwd;

  async function createDomain() {
    const name = newName.trim();
    if (!name) return;
    setError("");
    try {
      const created = await api.createDomain(name);
      setDomains((prev) => [...prev, created]);
      onDomainChange(created.slug);
      setCreating(false);
      setNewName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const modeButton = (mode: FolderMode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={folderMode === mode}
      onClick={() => onFolderModeChange(mode)}
      className={`px-2 py-0.5 rounded-md text-[11px] cursor-pointer ${folderMode === mode ? "bg-cc-active text-cc-fg font-medium" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="px-3 sm:px-4 py-2 border-t border-cc-border/60 space-y-1.5" aria-label="Session domain and folder" role="group">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <label htmlFor={selectId} className="text-[11px] text-cc-muted">Domain</label>
        {creating ? (
          <span className="flex items-center gap-1">
            <label htmlFor={newDomainId} className="sr-only">New domain name</label>
            <input
              id={newDomainId}
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); createDomain(); }
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="Domain name"
              className="w-36 px-2 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
            <button type="button" onClick={createDomain} disabled={!newName.trim()} className="px-2 py-0.5 rounded-md text-[11px] bg-cc-primary text-white disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)} className="px-2 py-0.5 rounded-md text-[11px] text-cc-muted hover:bg-cc-hover cursor-pointer">
              Cancel
            </button>
          </span>
        ) : (
          <select
            id={selectId}
            value={domain}
            aria-describedby={noteId}
            onChange={(e) => {
              if (e.target.value === NEW_DOMAIN) setCreating(true);
              else onDomainChange(e.target.value);
            }}
            className="px-1.5 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary"
          >
            {domains.length === 0 && <option value="global">GLOBAL</option>}
            {domains.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            <option value={NEW_DOMAIN}>+ New domain…</option>
          </select>
        )}

        <span className="w-px h-3 bg-cc-border mx-1" aria-hidden="true" />
        <span className="text-[11px] text-cc-muted" id={`${folderNameId}-label`}>Folder</span>
        <span role="radiogroup" aria-labelledby={`${folderNameId}-label`} className="flex gap-0.5">
          {modeButton("new", "New folder in this domain")}
          {modeButton("existing", "Existing folder")}
        </span>
        {folderMode === "new" ? (
          <>
            <label htmlFor={folderNameId} className="sr-only">New folder name</label>
            <input
              id={folderNameId}
              value={folderName}
              onChange={(e) => onFolderNameChange(e.target.value)}
              className="w-36 px-2 py-0.5 rounded-md bg-cc-input-bg border border-cc-border text-[12px] font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="max-w-[220px] truncate px-2 py-0.5 rounded-md border border-cc-border text-[12px] font-mono-code text-cc-fg hover:bg-cc-hover cursor-pointer"
            title={cwd}
          >
            {cwd ? cwd.split("/").filter(Boolean).pop() : "Choose folder"}
          </button>
        )}
      </div>
      <p id={noteId} className="text-[11px] text-cc-muted leading-snug">
        Sessions in a domain share memory, skills, MCP servers and instructions. If this session has its own macro-topic,
        create a dedicated domain.
        {target && <> Runs in <span className="font-mono-code break-all">{target}</span>.</>}
      </p>
      {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}
      {showPicker && (
        <FolderPicker
          initialPath={cwd}
          onSelect={(path) => { onCwdChange(path); onFolderModeChange("existing"); }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
