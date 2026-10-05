import { useState, useEffect, useId } from "react";
import { api, type ConfigFileFormat } from "../api.js";

/**
 * Single-file editor for the Claude Code / Codex config files listed in the
 * session panel (ClaudeConfigBrowser): markdown (skills, agents, commands,
 * CLAUDE.local.md, AGENTS.md...), JSON (settings*.json, .mcp.json) and TOML
 * (~/.codex/config.toml).
 *
 * It reads and writes through the session-scoped /fs/config-file routes, which
 * accept only known config paths but work for projects outside $HOME. JSON is
 * validated here before saving (the server validates JSON and TOML again); an
 * invalid document is never written and the user's text stays in the editor.
 * The server decides `readOnly` (claude.ai-synced skills, config.toml without a
 * TOML parser).
 */
export function ConfigFileEditor({
  sessionId,
  path,
  label,
  description,
  onClose,
  onSaved,
}: {
  sessionId: string;
  path: string;
  label: string;
  /** Short line under the title, e.g. "User instructions for Claude Code (all projects)" */
  description?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [content, setContent] = useState("");
  const [format, setFormat] = useState<ConfigFileFormat>("markdown");
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  // A file that could not be read (too large, unreadable...) must never be
  // replaced by whatever is typed into an editor that only LOOKS empty.
  const [loadFailed, setLoadFailed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    api.readConfigFile(sessionId, path).then((res) => {
      if (cancelled) return;
      setContent(res.content);
      setFormat(res.format ?? "markdown");
      setReadOnly(!!res.readOnly);
      setLoading(false);
    }).catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : "Failed to read file");
      setLoadFailed(true);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId, path]);

  const handleSave = async () => {
    if (format === "json") {
      try {
        JSON.parse(content);
      } catch (e: unknown) {
        setError(`Invalid JSON, not saved: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      await api.writeConfigFile(sessionId, path, content);
      setDirty(false);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={handleClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed inset-4 sm:inset-8 md:inset-x-[10%] md:inset-y-[5%] z-50 flex flex-col bg-cc-bg border border-cc-border rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 sm:px-5 py-3 bg-cc-card border-b border-cc-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 shrink-0 rounded-lg bg-cc-primary/10 flex items-center justify-center">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-primary" aria-hidden="true">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-semibold text-cc-fg truncate">{label}</h2>
              <p className="text-[11px] text-cc-muted truncate">{description || path}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : loadFailed ? (
          // No textarea and no Save: the error below says why the file did not open.
          <div className="flex-1 flex items-center justify-center px-4 text-[12px] text-cc-muted">
            This file could not be opened, so it cannot be edited here.
          </div>
        ) : (
          <>
            {/* Save bar */}
            <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 bg-cc-card border-b border-cc-border">
              <span className="text-[12px] text-cc-muted font-mono-code truncate" title={path}>{path}</span>
              <div className="flex items-center gap-2 shrink-0">
                {readOnly ? (
                  <span className="text-[10px] text-cc-muted">Read-only</span>
                ) : (
                  <>
                    {dirty && <span className="text-[10px] text-cc-warning font-medium">Unsaved</span>}
                    <button
                      onClick={handleSave}
                      disabled={!dirty || saving}
                      className={`px-3 py-1 text-[11px] font-medium rounded-md transition-colors cursor-pointer ${
                        dirty && !saving
                          ? "bg-cc-primary text-white hover:bg-cc-primary/90"
                          : "bg-cc-hover text-cc-muted cursor-not-allowed"
                      }`}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <textarea
              value={content}
              readOnly={readOnly}
              aria-label={`Contents of ${label}`}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              spellCheck={false}
              className="flex-1 w-full p-4 bg-cc-bg text-cc-fg text-[13px] font-mono-code leading-relaxed resize-none focus:outline-none"
              placeholder="File contents..."
            />
          </>
        )}

        {error && (
          <div role="alert" className="shrink-0 px-4 py-2 bg-cc-error/10 border-t border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}
      </div>
    </>
  );
}
