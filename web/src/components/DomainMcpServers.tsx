import { useId, useState } from "react";
import type { DomainMcpServerView } from "../api.js";
import { Toggle } from "./DomainToggle.js";

export type NewMcpServer = { url: string } | { command: string; args?: string[] };

/**
 * A domain's MCP servers: GLOBAL's, its own, and the ones every Claude
 * session loads by itself (the user's own config, claude.ai connectors:
 * "Claude only"), each on or off for the domain, with what it connects to. Servers of the domain's own mcp.json can
 * be removed, and new ones added: a URL (HTTP) or a command (stdio). Env and
 * headers (tokens) are set in mcp.json directly ("Edit mcp.json"). Claude and
 * Codex sessions get the same servers.
 */
export function DomainMcpServers({
  servers,
  error,
  isGlobal,
  busy,
  onToggle,
  onAdd,
  onRemove,
}: {
  servers: DomainMcpServerView[];
  error?: string;
  isGlobal: boolean;
  busy: boolean;
  onToggle: (name: string, on: boolean) => void;
  /** Resolves true when the server was saved (the form then closes). */
  onAdd: (name: string, server: NewMcpServer) => Promise<boolean>;
  onRemove: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div role="group" aria-label="MCP servers">
      <div className="mt-4 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">MCP servers</h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={busy || !!error}
            className="text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add server
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}
      {servers.length === 0 && !adding && <p className="text-[11px] text-cc-muted">None yet.</p>}
      {servers.length > 0 && (
        <ul className="mt-1 space-y-1">
          {servers.map((s) => (
            <li key={s.name} className="flex items-center gap-2 text-[12px] min-w-0">
              <Toggle label={`MCP server ${s.name}`} checked={s.enabled} disabled={busy || s.disabledGlobally} onChange={(on) => onToggle(s.name, on)} />
              <span className="font-mono-code shrink-0">{s.name}</span>
              <span className="text-[10px] text-cc-muted truncate min-w-0" title={s.target}>
                {s.type}{s.target ? ` · ${s.target}` : ""}{s.source === "global" && !isGlobal ? " · from GLOBAL" : ""}
                {s.source === "account" ? ` · Claude only${s.health && s.health !== "connected" ? ` · ${s.health}` : ""}` : ""}
              </span>
              {s.disabledGlobally && <span className="shrink-0 text-[10px] text-cc-muted">off in GLOBAL</span>}
              {s.source === "domain" && (
                <button
                  type="button"
                  onClick={() => onRemove(s.name)}
                  disabled={busy}
                  aria-label={`Remove MCP server ${s.name}`}
                  className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded text-cc-muted hover:text-cc-error hover:bg-cc-error/10 cursor-pointer disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddServerForm busy={busy} onCancel={() => setAdding(false)} onAdd={(n, s) => onAdd(n, s).then((ok) => { if (ok) setAdding(false); })} />}
    </div>
  );
}

function AddServerForm({
  busy,
  onCancel,
  onAdd,
}: {
  busy: boolean;
  onCancel: () => void;
  onAdd: (name: string, server: NewMcpServer) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"url" | "command">("url");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const ids = { name: useId(), kind: useId(), target: useId(), args: useId() };
  const field = "w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary";
  return (
    <form
      aria-label="Add MCP server"
      className="mt-2 p-2 rounded-lg border border-cc-border space-y-1.5 text-[11px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !target.trim()) return;
        const server: NewMcpServer = kind === "url"
          ? { url: target.trim() }
          : { command: target.trim(), args: args.split(/\s+/).filter(Boolean) };
        void onAdd(name.trim(), server);
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
      <p className="text-cc-muted">Env variables and headers (tokens) go in mcp.json: use "Edit mcp.json".</p>
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
