import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api, type ClaudeConfigResponse, type NewConfigFileType } from "../api.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { ConfigFileEditor } from "./ConfigFileEditor.js";

/**
 * Project / User config panel at the top of the session TaskPanel.
 *
 * Claude Code sessions list CLAUDE.md / CLAUDE.local.md (from the session cwd
 * up to the repo root), settings*.json, .mcp.json, commands, agents and skills.
 * Codex sessions list only what Codex reads: AGENTS.md (walk-up), ~/.codex/
 * AGENTS.md and ~/.codex/config.toml; the Claude-only entries are hidden.
 *
 * Project CLAUDE.md files open the multi-file ClaudeMdEditor; everything else
 * opens ConfigFileEditor, which goes through the session-scoped config routes.
 */

type Scope = "project" | "user";

interface ConfigItem {
  key: string;
  label: string;
  path: string;
  sublabel?: string;
  title?: string;
  /** "claude-md" = project CLAUDE.md, opened in the multi-file ClaudeMdEditor */
  editor: "claude-md" | "file";
  description?: string;
}

interface ConfigGroup {
  title?: string;
  items: ConfigItem[];
}

interface NewOption {
  type: NewConfigFileType;
  label: string;
  /** Asks for a name (commands, agents, skills) */
  named?: boolean;
}

const basename = (p: string) => p.split("/").pop() || p;

function relTo(root: string, p: string): string {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

const fileItem = (label: string, path: string, extra: Partial<ConfigItem> = {}): ConfigItem => ({
  key: path,
  label,
  path,
  editor: "file",
  ...extra,
});

const namedGroup = (
  title: string,
  entries: { name: string; path: string }[],
  prefix = "",
): ConfigGroup => ({
  title,
  items: entries.map((e) => fileItem(`${prefix}${e.name}`, e.path)),
});

function skillGroup(skills: ClaudeConfigResponse["user"]["skills"]): ConfigGroup {
  return {
    title: "Skills",
    items: skills.map((s) => fileItem(s.name, s.path, {
      sublabel: s.source === "synced" ? "synced" : s.description ? s.description.slice(0, 40) : undefined,
      title: s.source === "synced"
        ? "Synced from claude.ai (read-only)"
        : s.source === "link" ? `Symlinked skill: ${s.description}` : s.description || undefined,
    })),
  };
}

function buildGroups(config: ClaudeConfigResponse, isCodex: boolean): Record<Scope, ConfigGroup[]> {
  const { project, user } = config;
  const root = project.root;
  if (isCodex) {
    return {
      project: [{ items: project.agentsMd.map((f) => fileItem(relTo(root, f.path), f.path, { description: "Project instructions for Codex" })) }],
      user: [{
        items: [
          ...(user.codex.agentsMd ? [fileItem("AGENTS.md", user.codex.agentsMd.path, {
            sublabel: "all sessions",
            title: "Companion links ~/.codex/AGENTS.md into every Codex session's CODEX_HOME",
            description: "User instructions for Codex (linked into every session)",
          })] : []),
          ...(user.codex.config ? [fileItem("config.toml", user.codex.config.path, {
            sublabel: user.codex.config.editable ? undefined : "read-only",
          })] : []),
        ],
      }],
    };
  }
  const single = (label: string, f: { path: string } | null) => (f ? [fileItem(label, f.path)] : []);
  return {
    project: [
      {
        items: [
          ...project.claudeMd.map((f) => ({
            ...fileItem(relTo(root, f.path), f.path),
            editor: "claude-md" as const,
          })),
          ...project.claudeLocalMd.map((f) => fileItem(relTo(root, f.path), f.path, {
            description: "Personal project instructions (not committed)",
          })),
          ...single("settings.json", project.settings),
          ...single("settings.local.json", project.settingsLocal),
          ...single(".mcp.json", project.mcpJson),
        ],
      },
      namedGroup("Commands", project.commands, "/"),
      namedGroup("Agents", project.agents),
      skillGroup(project.skills),
    ],
    user: [
      {
        items: [
          ...(user.claudeMd ? [fileItem("CLAUDE.md", user.claudeMd.path, {
            description: "User instructions for Claude Code (all projects)",
          })] : []),
          ...single("settings.json", user.settings),
          ...single("settings.local.json", user.settingsLocal),
        ],
      },
      skillGroup(user.skills),
      namedGroup("Agents", user.agents),
      namedGroup("Commands", user.commands, "/"),
    ],
  };
}

function newOptions(config: ClaudeConfigResponse, scope: Scope, isCodex: boolean): NewOption[] {
  const { project, user } = config;
  const opts: NewOption[] = [];
  const add = (cond: boolean, type: NewConfigFileType, label: string) => {
    if (cond) opts.push({ type, label });
  };
  if (isCodex) {
    if (scope === "project") add(!project.agentsMd.some((f) => f.path === `${project.root}/AGENTS.md`), "agents-md", "AGENTS.md");
    else add(!user.codex.agentsMd, "agents-md", "AGENTS.md");
    return opts;
  }
  if (scope === "project") {
    add(!project.claudeMd.some((f) => f.path === `${project.root}/CLAUDE.md`), "claude-md", "CLAUDE.md");
    add(!project.claudeLocalMd.some((f) => f.path === `${project.root}/CLAUDE.local.md`), "claude-local-md", "CLAUDE.local.md");
    add(!project.settings, "settings", "settings.json");
    add(!project.settingsLocal, "settings-local", "settings.local.json");
    add(!project.mcpJson, "mcp-json", ".mcp.json");
  } else {
    add(!user.claudeMd, "claude-md", "CLAUDE.md");
    add(!user.settings, "settings", "settings.json");
    add(!user.settingsLocal, "settings-local", "settings.local.json");
  }
  opts.push(
    { type: "command", label: "Command…", named: true },
    { type: "agent", label: "Agent…", named: true },
    { type: "skill", label: "Skill…", named: true },
  );
  return opts;
}

// ─── Collapsible section header ──────────────────────────────────────────────

const ICON_PATHS: Record<Scope, string> = {
  project: "M1.5 2A1.5 1.5 0 000 3.5v2A1.5 1.5 0 001.5 7h1v5.5A1.5 1.5 0 004 14h8a1.5 1.5 0 001.5-1.5V7h1A1.5 1.5 0 0016 5.5v-2A1.5 1.5 0 0014.5 2h-13zM4 7h8v5.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5V7zm10-1H2V3.5a.5.5 0 01.5-.5h11a.5.5 0 01.5.5V6z",
  user: "M8.354 1.146a.5.5 0 00-.708 0l-6 6A.5.5 0 002 7.5V14a1 1 0 001 1h3.5a.5.5 0 00.5-.5V11a.5.5 0 01.5-.5h1a.5.5 0 01.5.5v3.5a.5.5 0 00.5.5H13a1 1 0 001-1V7.5a.5.5 0 00-.146-.354l-6-6z",
};

function SectionHeader({
  icon,
  title,
  expanded,
  onToggle,
  onNew,
  newOpen,
}: {
  icon: Scope;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  onNew: () => void;
  newOpen: boolean;
}) {
  return (
    <div className="flex items-center hover:bg-cc-hover/50 transition-colors">
      <button
        onClick={onToggle}
        className="flex-1 min-w-0 flex items-center gap-2 pl-4 pr-1 py-2 text-left cursor-pointer"
        aria-expanded={expanded}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          className={`w-3 h-3 text-cc-muted shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div className="w-4 h-4 flex items-center justify-center shrink-0">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary" aria-hidden="true">
            <path d={ICON_PATHS[icon]} />
          </svg>
        </div>
        <span className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider flex-1">
          {title}
        </span>
      </button>
      <button
        onClick={onNew}
        aria-label={`New ${icon} config file`}
        aria-expanded={newOpen}
        title="New…"
        className="mr-3 w-5 h-5 flex items-center justify-center rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3" aria-hidden="true">
          <path d="M8 3v10M3 8h10" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

// ─── Individual config item row ──────────────────────────────────────────────

function ConfigItemRow({ item, onClick }: { item: ConfigItem; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={item.title}
      className="w-full flex items-center gap-2 px-4 pl-10 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
    >
      <span className="text-[12px] text-cc-fg truncate flex-1">{item.label}</span>
      {item.sublabel && (
        <span className="text-[10px] text-cc-muted shrink-0 max-w-[45%] truncate">{item.sublabel}</span>
      )}
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="w-3 h-3 text-cc-muted shrink-0"
        aria-hidden="true"
      >
        <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

// ─── "New…" menu ─────────────────────────────────────────────────────────────

function NewFileMenu({
  scope,
  options,
  onCreate,
  onCancel,
}: {
  scope: Scope;
  options: NewOption[];
  onCreate: (type: NewConfigFileType, name?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [named, setNamed] = useState<NewOption | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (type: NewConfigFileType, n?: string) => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(type, n);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create file");
    } finally {
      setBusy(false);
    }
  };

  const kind = named?.label.replace("…", "").toLowerCase();

  return (
    <div className="px-4 pl-10 py-1.5 space-y-1.5" data-testid={`new-${scope}-menu`}>
      {named ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(named.type, name.trim()); }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={`New ${scope} ${kind} name`}
            placeholder={`${kind} name`}
            className="flex-1 min-w-0 px-2 py-1 text-[11px] bg-cc-bg border border-cc-border rounded text-cc-fg focus:outline-none focus:border-cc-primary"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="px-2 py-1 text-[11px] rounded bg-cc-primary text-white disabled:opacity-50 cursor-pointer"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => { setNamed(null); setName(""); setError(null); }}
            className="px-2 py-1 text-[11px] rounded text-cc-muted hover:bg-cc-hover cursor-pointer"
          >
            Back
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o.type}
              disabled={busy}
              onClick={() => (o.named ? setNamed(o) : void run(o.type))}
              className="px-2 py-0.5 text-[11px] font-mono-code rounded border border-cc-border text-cc-fg/80 hover:bg-cc-hover cursor-pointer disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
          <button
            onClick={onCancel}
            className="px-2 py-0.5 text-[11px] rounded text-cc-muted hover:bg-cc-hover cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ClaudeConfigBrowser({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  // The session cwd, not repo_root: the server walks from here up to the repo
  // root, so CLAUDE.md files in sub-directories are listed too.
  const cwd = session?.cwd || sdk?.cwd || session?.repo_root;
  const isCodex = (session?.backend_type || sdk?.backendType) === "codex";

  const [config, setConfig] = useState<ClaudeConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<Scope, boolean>>({ project: false, user: false });
  const [newMenu, setNewMenu] = useState<Scope | null>(null);
  const [activeItem, setActiveItem] = useState<ConfigItem | null>(null);

  const fetchConfig = useCallback(async () => {
    if (!cwd) return;
    try {
      setConfig(await api.getClaudeConfig(cwd, sessionId));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  if (!cwd) return null;

  if (loading) {
    return (
      <div className="shrink-0 px-4 py-2.5">
        <span className="text-[11px] text-cc-muted">Loading config...</span>
      </div>
    );
  }

  if (!config) return null;

  const groups = buildGroups(config, isCodex);
  const count = (scope: Scope) => groups[scope].reduce((n, g) => n + g.items.length, 0);

  const create = async (scope: Scope, type: NewConfigFileType, name?: string) => {
    const res = await api.createConfigFile(sessionId, scope, type, name);
    setNewMenu(null);
    await fetchConfig();
    const isProjectClaudeMd = scope === "project" && type === "claude-md";
    setActiveItem(fileItem(name || basename(res.path), res.path, isProjectClaudeMd ? { editor: "claude-md" } : {}));
  };

  const renderSection = (scope: Scope, title: string, emptyText: string) => {
    const n = count(scope);
    const open = expanded[scope] || newMenu === scope;
    return (
      <>
        <SectionHeader
          icon={scope}
          title={`${title} (${n})`}
          expanded={open}
          onToggle={() => {
            setExpanded((e) => ({ ...e, [scope]: !open }));
            if (open) setNewMenu(null);
          }}
          onNew={() => setNewMenu((m) => (m === scope ? null : scope))}
          newOpen={newMenu === scope}
        />
        {open && (
          <div className="pb-1">
            {newMenu === scope && (
              <NewFileMenu
                scope={scope}
                options={newOptions(config, scope, isCodex)}
                onCreate={(type, name) => create(scope, type, name)}
                onCancel={() => setNewMenu(null)}
              />
            )}
            {groups[scope].map((g, gi) => g.items.length > 0 && (
              <div key={g.title ?? gi}>
                {g.title && (
                  <div className="px-4 pl-10 py-1 text-[10px] text-cc-muted uppercase tracking-wider">
                    {g.title} ({g.items.length})
                  </div>
                )}
                {g.items.map((item) => (
                  <ConfigItemRow key={item.key} item={item} onClick={() => setActiveItem(item)} />
                ))}
              </div>
            ))}
            {n === 0 && <p className="px-4 pl-10 py-1.5 text-[11px] text-cc-muted">{emptyText}</p>}
          </div>
        )}
      </>
    );
  };

  const closeEditor = () => {
    setActiveItem(null);
    void fetchConfig();
  };

  return (
    <div className="shrink-0" data-testid="claude-config-browser">
      {renderSection("project", "Project", isCodex ? "No AGENTS.md found" : "No .claude config found")}
      {renderSection("user", "User", isCodex ? "No ~/.codex config found" : "No user config found")}

      {activeItem && createPortal(
        activeItem.editor === "claude-md" ? (
          <ClaudeMdEditor cwd={config.project.cwd || cwd} initialPath={activeItem.path} open onClose={closeEditor} />
        ) : (
          <ConfigFileEditor
            sessionId={sessionId}
            path={activeItem.path}
            label={activeItem.label}
            description={activeItem.description}
            onClose={closeEditor}
          />
        ),
        document.body,
      )}
    </div>
  );
}
