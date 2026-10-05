import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { api, type CompanionEnv, type EnvScope } from "../api.js";
import { useStore } from "../store.js";
import { FolderPicker } from "./FolderPicker.js";
import { FolderScopeSelector } from "./FolderScopeSelector.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

interface VarRow {
  key: string;
  value: string;
}

const SCOPE_DESCRIPTION =
  "Global profiles apply to every session. Project profiles apply to sessions started inside their folders; a deeper folder overrides a broader one.";
const FOLDER_HINT =
  "Applied to sessions whose working directory is one of these folders or inside one (worktrees of the repo included).";
const FOLDER_REQUIRED = "Select at least one project folder";

/* ─── Grouping ─────────────────────────────────────────────────────── */

interface EnvGroup {
  key: string;
  label: string;
  /** Full folder paths, shown as a tooltip for project groups. */
  title?: string;
  envs: CompanionEnv[];
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function isUnassigned(env: CompanionEnv): boolean {
  return env.scope !== "global" && env.scope !== "project";
}

/** Global first, then one group per folder set, then unassigned profiles. */
function groupEnvs(envs: CompanionEnv[]): EnvGroup[] {
  const projectGroups = new Map<string, EnvGroup>();
  for (const env of envs) {
    if (env.scope !== "project") continue;
    const folders = env.folders ?? [];
    const key = folders.slice().sort().join("\n");
    let group = projectGroups.get(key);
    if (!group) {
      group = {
        key: `project:${key}`,
        label: folders.map(folderName).join(", ") || "(no folder)",
        title: folders.join("\n"),
        envs: [],
      };
      projectGroups.set(key, group);
    }
    group.envs.push(env);
  }
  const groups: EnvGroup[] = [
    { key: "global", label: "Global", envs: envs.filter((e) => e.scope === "global") },
    ...[...projectGroups.values()].sort((a, b) => a.label.localeCompare(b.label)),
    { key: "unassigned", label: "Unassigned", envs: envs.filter(isUnassigned) },
  ];
  return groups.filter((g) => g.envs.length > 0);
}

function toVariables(rows: VarRow[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k) variables[k] = row.value;
  }
  return variables;
}

/* ─── Component ────────────────────────────────────────────────────── */

export function EnvManager({ onClose, embedded = false }: Props) {
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<VarRow[]>([]);
  const [editScope, setEditScope] = useState<EnvScope | null>(null);
  const [editFolders, setEditFolders] = useState<string[]>([]);
  const [error, setError] = useState("");

  // New env form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newVars, setNewVars] = useState<VarRow[]>([{ key: "", value: "" }]);
  const [newScope, setNewScope] = useState<EnvScope>("global");
  const [newFolders, setNewFolders] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Which form the folder picker adds to
  const [folderPickerFor, setFolderPickerFor] = useState<"create" | "edit" | null>(null);

  // Current session cwd: pre-fills the folder list when switching to project scope
  const cwd = useStore((s) => {
    if (!s.currentSessionId) return "";
    return s.sessions.get(s.currentSessionId)?.cwd
      || s.sdkSessions.find((sdk) => sdk.sessionId === s.currentSessionId)?.cwd
      || "";
  });

  const groups = useMemo(() => groupEnvs(envs), [envs]);
  const unassignedCount = useMemo(() => envs.filter(isUnassigned).length, [envs]);

  const refresh = useCallback(() => {
    api.listEnvs().then(setEnvs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function startEdit(env: CompanionEnv) {
    setEditingSlug(env.slug);
    setEditName(env.name);
    const rows = Object.entries(env.variables).map(([key, value]) => ({ key, value }));
    if (rows.length === 0) rows.push({ key: "", value: "" });
    setEditVars(rows);
    setEditScope(isUnassigned(env) ? null : env.scope!);
    setEditFolders(env.folders ?? []);
    setError("");
  }

  function cancelEdit() {
    setEditingSlug(null);
    setError("");
  }

  function changeEditScope(scope: EnvScope) {
    setEditScope(scope);
    if (scope === "project" && editFolders.length === 0 && cwd) setEditFolders([cwd]);
  }

  function changeNewScope(scope: EnvScope) {
    setNewScope(scope);
    if (scope === "project" && newFolders.length === 0 && cwd) setNewFolders([cwd]);
  }

  async function saveEdit() {
    if (!editingSlug) return;
    if (editScope === "project" && editFolders.length === 0) {
      setError(FOLDER_REQUIRED);
      return;
    }
    try {
      await api.updateEnv(editingSlug, {
        name: editName.trim() || undefined,
        variables: toVariables(editVars),
        // An unassigned profile left unassigned keeps no scope.
        ...(editScope ? { scope: editScope, folders: editScope === "project" ? editFolders : [] } : {}),
      });
      setEditingSlug(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(slug: string) {
    try {
      await api.deleteEnv(slug);
      if (editingSlug === slug) setEditingSlug(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (newScope === "project" && newFolders.length === 0) {
      setError(FOLDER_REQUIRED);
      return;
    }
    setCreating(true);
    try {
      await api.createEnv(
        name,
        toVariables(newVars),
        newScope === "project" ? { scope: newScope, folders: newFolders } : { scope: newScope },
      );
      setNewName("");
      setNewVars([{ key: "", value: "" }]);
      setNewScope("global");
      setNewFolders([]);
      setShowCreate(false);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const createScopeSelector = (
    <FolderScopeSelector
      scope={newScope}
      onScopeChange={changeNewScope}
      folders={newFolders}
      onRemoveFolder={(path) => setNewFolders((f) => f.filter((p) => p !== path))}
      onAddFolder={() => setFolderPickerFor("create")}
      description={SCOPE_DESCRIPTION}
      folderHint={FOLDER_HINT}
    />
  );

  const editScopeSelector = (
    <div className="space-y-2">
      {editScope === null && (
        <p className="text-xs text-cc-muted">
          Unassigned: applied only when picked explicitly at session creation. Choose a scope to apply it automatically.
        </p>
      )}
      <FolderScopeSelector
        scope={editScope}
        onScopeChange={changeEditScope}
        folders={editFolders}
        onRemoveFolder={(path) => setEditFolders((f) => f.filter((p) => p !== path))}
        onAddFolder={() => setFolderPickerFor("edit")}
        description={SCOPE_DESCRIPTION}
        folderHint={FOLDER_HINT}
      />
    </div>
  );

  const folderPicker = folderPickerFor && (
    <FolderPicker
      initialPath={cwd || "/"}
      onSelect={(path) => {
        const add = (prev: string[]) => (prev.includes(path) ? prev : [...prev, path]);
        if (folderPickerFor === "create") setNewFolders(add);
        else setEditFolders(add);
        setFolderPickerFor(null);
      }}
      onClose={() => setFolderPickerFor(null)}
    />
  );

  const unassignedNotice = unassignedCount > 0 && <UnassignedNotice count={unassignedCount} />;

  /* ─── Embedded (full page) ───────────────────────────────────────── */

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto overflow-x-hidden">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-cc-fg">Environments</h1>
              <p className="mt-0.5 text-[13px] text-cc-muted leading-relaxed">
                Environment variables for sessions, applied globally or per project folder.
              </p>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 mt-4 mb-5">
            <div className="flex-1" />
            <button
              onClick={() => setShowCreate(!showCreate)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors cursor-pointer shrink-0 ${
                showCreate
                  ? "bg-cc-active text-cc-fg"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white"
              }`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                {showCreate ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M12 5v14M5 12h14" />}
              </svg>
              <span className="hidden sm:inline">{showCreate ? "Cancel" : "New Environment"}</span>
            </button>
          </div>

          {/* Inline create form */}
          {showCreate && (
            <div
              className="mb-6 rounded-xl bg-cc-card p-4 sm:p-5 space-y-3"
              style={{ animation: "fadeSlideIn 150ms ease-out" }}
            >
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Environment name (e.g. production)"
                aria-label="Environment name"
                className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) handleCreate();
                }}
              />
              {createScopeSelector}
              <VarEditor rows={newVars} onChange={setNewVars} />

              {error && (
                <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
              )}

              <div className="flex items-center justify-between pt-1">
                <p className="text-[11px] text-cc-muted">
                  Stored in <code className="text-[10px]">~/.companion/envs/</code> (owner-only)
                </p>
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || creating}
                  className={`px-4 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-colors ${
                    newName.trim() && !creating
                      ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                      : "bg-cc-hover text-cc-muted cursor-not-allowed"
                  }`}
                >
                  {creating ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          )}

          {unassignedNotice}

          {/* Stats */}
          <div className="flex items-center gap-2 mb-3 text-[12px] text-cc-muted">
            <span>{envs.length} environment{envs.length !== 1 ? "s" : ""}</span>
          </div>

          {/* Env list, grouped by scope */}
          {loading ? (
            <div className="py-12 text-center text-sm text-cc-muted">Loading environments...</div>
          ) : envs.length === 0 ? (
            <div className="py-12 text-center text-sm text-cc-muted">No environments yet.</div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h2
                    className="text-[11px] uppercase tracking-wider text-cc-muted font-semibold mb-1.5 px-1"
                    title={group.title}
                  >
                    {group.label}
                  </h2>
                  <div className="space-y-1">
                    {group.envs.map((env) => {
                      if (editingSlug === env.slug) {
                        return (
                          <div
                            key={env.slug}
                            className="rounded-xl bg-cc-card p-4 space-y-3"
                            style={{ animation: "fadeSlideIn 150ms ease-out" }}
                          >
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="Environment name"
                              aria-label="Environment name"
                              className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
                            />
                            {editScopeSelector}
                            <div>
                              <div className="text-[11px] font-medium text-cc-muted mb-1.5">Variables</div>
                              <VarEditor rows={editVars} onChange={setEditVars} />
                            </div>
                            {error && (
                              <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
                            )}
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={cancelEdit}
                                className="px-3 py-2.5 min-h-[44px] text-sm rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => void saveEdit()}
                                className="px-4 py-2.5 min-h-[44px] text-sm rounded-lg font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <EnvRow
                          key={env.slug}
                          env={env}
                          onStartEdit={() => startEdit(env)}
                          onDelete={() => void handleDelete(env.slug)}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* Error banner (when not inside a form) */}
          {error && !showCreate && !editingSlug && (
            <div className="mt-4 px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>
          )}
        </div>
        {folderPicker}
      </div>
    );
  }

  /* ─── Modal mode ─────────────────────────────────────────────────── */

  const createForm = (
    <div className="rounded-xl bg-cc-card p-4 space-y-2.5">
      <span className="text-sm font-medium text-cc-fg">New Environment</span>
      <input
        type="text"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="Environment name (e.g. production)"
        aria-label="Environment name"
        className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
        onKeyDown={(e) => {
          if (e.key === "Enter" && newName.trim()) handleCreate();
        }}
      />
      {createScopeSelector}
      <VarEditor rows={newVars} onChange={setNewVars} />
      <button
        onClick={handleCreate}
        disabled={!newName.trim() || creating}
        className={`px-4 py-2.5 min-h-[44px] text-sm font-medium rounded-lg transition-colors ${
          newName.trim() && !creating
            ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
            : "bg-cc-hover text-cc-muted cursor-not-allowed"
        }`}
      >
        {creating ? "Creating..." : "Create"}
      </button>
    </div>
  );

  const environmentsList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading environments...</div>
  ) : envs.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">No environments yet.</div>
  ) : (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-cc-muted font-semibold px-1" title={group.title}>
            {group.label}
          </h3>
          {group.envs.map((env) => (
            <div key={env.slug} className="rounded-xl bg-cc-card overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="text-sm font-medium text-cc-fg flex-1">{env.name}</span>
                <span className="text-xs text-cc-muted">
                  {Object.keys(env.variables).length} var{Object.keys(env.variables).length !== 1 ? "s" : ""}
                </span>
                {editingSlug === env.slug ? (
                  <button onClick={cancelEdit} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-fg cursor-pointer">Cancel</button>
                ) : (
                  <>
                    <button onClick={() => startEdit(env)} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-fg cursor-pointer">Edit</button>
                    <button onClick={() => handleDelete(env.slug)} className="text-xs px-2 py-1.5 min-h-[44px] text-cc-muted hover:text-cc-error cursor-pointer">Delete</button>
                  </>
                )}
              </div>

              {editingSlug === env.slug && (
                <div className="px-3 py-3 space-y-2">
                  <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Environment name" aria-label="Environment name"
                    className="w-full px-3 py-2.5 min-h-[44px] text-sm bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow" />
                  {editScopeSelector}
                  <div><div className="text-[11px] font-medium text-cc-muted mb-1.5">Variables</div><VarEditor rows={editVars} onChange={setEditVars} /></div>
                  <button onClick={saveEdit} className="px-4 py-2.5 min-h-[44px] text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer">Save</button>
                </div>
              )}

              {editingSlug !== env.slug && Object.keys(env.variables).length > 0 && (
                <div className="px-3 py-2.5 space-y-1">
                  {Object.entries(env.variables).map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-1.5 text-xs leading-5">
                      <span className="font-mono-code text-cc-fg break-all">{k}</span>
                      <span className="text-cc-muted">=</span>
                      <span className="font-mono-code text-cc-muted break-all whitespace-pre-wrap">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );

  const panel = (
    <div
      className="w-full max-w-lg max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-cc-fg">Manage Environments</h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 pb-safe space-y-4">
        {error && <div className="px-3 py-2 rounded-lg bg-cc-error/10 text-xs text-cc-error">{error}</div>}
        {unassignedNotice}
        {environmentsList}
        {createForm}
      </div>
      {folderPicker}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      {panel}
    </div>,
    document.body,
  );
}

/* ─── Unassigned notice ──────────────────────────────────────────────── */

function UnassignedNotice({ count }: { count: number }) {
  return (
    <div role="note" className="mb-4 rounded-lg border border-cc-warning/30 bg-cc-warning/10 px-3 py-2.5 text-xs leading-relaxed text-cc-fg">
      <span className="font-semibold">
        {count} environment{count !== 1 ? "s are" : " is"} unassigned.
      </span>{" "}
      {count !== 1 ? "They were" : "It was"} created before environments had a scope, so {count !== 1 ? "they apply" : "it applies"} only
      when picked explicitly at session creation. Edit {count !== 1 ? "each one" : "it"} to make it Global or scope it to project folders.
    </div>
  );
}

/* ─── Scope badge ────────────────────────────────────────────────────── */

function ScopeBadge({ env }: { env: CompanionEnv }) {
  if (env.scope === "global") {
    return <span className="text-[10px] uppercase tracking-wider text-cc-muted">global</span>;
  }
  if (env.scope === "project") {
    return (
      <span className="inline-flex items-center gap-1 flex-wrap">
        {(env.folders ?? []).map((f) => (
          <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-cc-primary/10 text-cc-primary font-mono-code" title={f}>
            {folderName(f)}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-warning/10 text-cc-fg uppercase tracking-wider">unassigned</span>
  );
}

/* ─── Env Row (for embedded page — display only) ─────────────────── */

interface EnvRowProps {
  env: CompanionEnv;
  onStartEdit: () => void;
  onDelete: () => void;
}

function EnvRow({ env, onStartEdit, onDelete }: EnvRowProps) {
  const varCount = Object.keys(env.variables).length;
  return (
    <div className="group flex items-start gap-3 px-3 py-3 min-h-[44px] rounded-lg hover:bg-cc-hover/60 transition-colors">
      {/* Icon */}
      <div className="shrink-0 mt-0.5 w-7 h-7 rounded-md bg-cc-primary/10 flex items-center justify-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 text-cc-primary">
          <path d="M12 3v18M3 12h18M4.5 6.5l15 0M4.5 17.5h15M6.5 4.5v15M17.5 4.5v15" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cc-fg truncate">{env.name}</span>
          <ScopeBadge env={env} />
        </div>
        <p className="mt-0.5 text-xs text-cc-muted">
          {varCount} variable{varCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          onClick={onStartEdit}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          aria-label="Edit"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
          </svg>
        </button>
        <button
          onClick={onDelete}
          className="p-2 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 rounded-md text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
          aria-label="Delete"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
          </svg>
        </button>
      </div>
    </div>
  );
}


/* ─── Key-Value Editor ────────────────────────────────────────────── */

function VarEditor({ rows, onChange }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void }) {
  function updateRow(i: number, field: "key" | "value", val: string) {
    const next = [...rows];
    next[i] = { ...next[i], [field]: val };
    onChange(next);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (next.length === 0) next.push({ key: "", value: "" });
    onChange(next);
  }

  function addRow() {
    onChange([...rows, { key: "", value: "" }]);
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={row.key}
            onChange={(e) => updateRow(i, "key", e.target.value)}
            placeholder="KEY"
            aria-label={`Variable ${i + 1} name`}
            className="flex-1 min-w-0 px-3 py-2.5 min-h-[44px] text-xs font-mono-code bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
          />
          <span className="text-[10px] text-cc-muted">=</span>
          <input
            type="text"
            value={row.value}
            onChange={(e) => updateRow(i, "value", e.target.value)}
            placeholder="value"
            aria-label={`Variable ${i + 1} value`}
            className="flex-1 min-w-0 px-3 py-2.5 min-h-[44px] text-xs font-mono-code bg-cc-bg rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:ring-1 focus:ring-cc-primary/40 transition-shadow"
          />
          <button
            onClick={() => removeRow(i)}
            aria-label="Remove variable"
            className="w-10 h-10 min-h-[44px] flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer shrink-0"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        className="text-xs py-2 min-h-[44px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
      >
        + Add variable
      </button>
    </div>
  );
}
