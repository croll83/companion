import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { api, type TelegramBinding } from "../api.js";

interface TelegramBridgeModalProps {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
  /** Notify parent that the binding for this session changed (set or removed). */
  onChanged?: (sessionId: string, bound: boolean) => void;
}

/** Split an allowlist textarea into numeric ids and @username tokens. */
function parseAllowlist(text: string): { ids: number[]; usernames: string[] } {
  const ids: number[] = [];
  const usernames: string[] = [];
  for (const tok of text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)) {
    if (/^-?\d+$/.test(tok)) ids.push(Number(tok));
    else usernames.push(tok.startsWith("@") ? tok : "@" + tok);
  }
  return { ids, usernames };
}

export function TelegramBridgeModal({ sessionId, sessionName, onClose, onChanged }: TelegramBridgeModalProps) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [requireMention, setRequireMention] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getTelegramBinding(sessionId)
      .then((res) => {
        if (!alive) return;
        const b = res.binding;
        if (b) {
          setExisting(true);
          setGroupId(String(b.groupId));
          setTopicId(b.topicId == null ? "" : String(b.topicId));
          setAllowlistText(b.allowlist.join("\n"));
          setRequireMention(b.requireMention);
          setEnabled(b.enabled);
        }
      })
      .catch(() => { /* no binding yet */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    setError(null);
    const gid = Number(groupId.trim());
    if (!groupId.trim() || !Number.isInteger(gid)) { setError("Group ID non valido (es. -1001234567890)."); return; }
    const tid = topicId.trim() === "" ? null : Number(topicId.trim());
    if (tid !== null && !Number.isInteger(tid)) { setError("Topic ID non valido (numero, o vuoto per DM/generale)."); return; }

    const { ids, usernames } = parseAllowlist(allowlistText);
    setSaving(true);
    try {
      const resolved: number[] = [...ids];
      const failed: string[] = [];
      for (const u of usernames) {
        try {
          const r = await api.resolveTelegramUsername(u);
          resolved.push(r.id);
        } catch { failed.push(u); }
      }
      if (failed.length) {
        setError(`Non risolti: ${failed.join(", ")}. Fai mandare a queste persone un messaggio al bot, poi inserisci l'id numerico.`);
        setSaving(false);
        return;
      }
      const allowlist = Array.from(new Set(resolved));
      if (allowlist.length === 0) { setError("Aggiungi almeno un id o @username in allowlist."); setSaving(false); return; }

      const binding: TelegramBinding = { groupId: gid, topicId: tid, allowlist, requireMention, enabled };
      await api.setTelegramBinding(sessionId, binding);
      onChanged?.(sessionId, true);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Salvataggio fallito.");
      setSaving(false);
    }
  }, [groupId, topicId, allowlistText, requireMention, enabled, sessionId, onChanged, onClose]);

  const handleDelete = useCallback(async () => {
    setSaving(true);
    try {
      await api.deleteTelegramBinding(sessionId);
      onChanged?.(sessionId, false);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Rimozione fallita.");
      setSaving(false);
    }
  }, [sessionId, onChanged, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Connect session to Telegram"
        className="mx-4 w-full max-w-md bg-cc-card border border-cc-border rounded-xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-cc-fg">Connect to Telegram</h3>
            <p className="text-[11px] text-cc-muted mt-0.5 truncate max-w-[20rem]">{sessionName}</p>
          </div>
          <button aria-label="Close" onClick={onClose} className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer">
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor"><path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z" /></svg>
          </button>
        </div>

        {loading ? (
          <p className="text-[12px] text-cc-muted py-6 text-center">Carico…</p>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[11px] text-cc-muted">Group ID</span>
              <input
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
                placeholder="-1001234567890"
                className="mt-1 w-full px-2 py-1.5 text-[12px] bg-cc-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-cc-muted">Topic ID <span className="opacity-60">(vuoto = DM / generale)</span></span>
              <input
                value={topicId}
                onChange={(e) => setTopicId(e.target.value)}
                placeholder="3"
                className="mt-1 w-full px-2 py-1.5 text-[12px] bg-cc-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary"
              />
            </label>
            <label className="block">
              <span className="text-[11px] text-cc-muted">Allowlist <span className="opacity-60">(id numerici o @username, uno per riga)</span></span>
              <textarea
                value={allowlistText}
                onChange={(e) => setAllowlistText(e.target.value)}
                rows={3}
                placeholder={"172751380\n@emacosc"}
                className="mt-1 w-full px-2 py-1.5 text-[12px] font-mono bg-cc-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary resize-none"
              />
            </label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-[11px] text-cc-fg cursor-pointer">
                <input type="checkbox" checked={requireMention} onChange={(e) => setRequireMention(e.target.checked)} />
                Solo se taggato
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-cc-fg cursor-pointer">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                Attivo
              </label>
            </div>

            {error && <p role="alert" className="text-[11px] text-cc-error">{error}</p>}

            <div className="flex items-center justify-between pt-1">
              {existing ? (
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="px-3 py-1.5 text-[12px] rounded-md text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Rimuovi
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button onClick={onClose} disabled={saving} className="px-3 py-1.5 text-[12px] rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer disabled:opacity-50">
                  Annulla
                </button>
                <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 text-[12px] rounded-md bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:opacity-50">
                  {saving ? "Salvo…" : "Salva"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
