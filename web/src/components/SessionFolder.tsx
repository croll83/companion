import { useEffect, useState } from "react";
import { api, type SessionFolderPreview } from "../api.js";
import { useStore } from "../store.js";
import { FolderPicker } from "./FolderPicker.js";

type Step =
  | { kind: "idle" }
  | { kind: "edit"; path: string; error?: string; checking?: boolean }
  | { kind: "review"; preview: SessionFolderPreview; moving?: boolean; error?: string }
  | { kind: "done"; to: string };

const DONE_MS = 5_000;

function memoryLine(preview: SessionFolderPreview): string | null {
  if (!preview.memory) return null;
  const { dir, notes } = preview.memory;
  const count = notes === 0 ? "no notes yet" : `${notes} note${notes === 1 ? "" : "s"}`;
  return `The memory does not change: the session keeps ${dir} (${count}).`;
}

/**
 * "Change folder": move the focused session to another working folder and
 * restart its CLI there on the same conversation, so the context is kept.
 * Project instructions, skills and settings then come from the new folder;
 * the memory does not: a domain session keeps its domain's memory, and a
 * session from before domains keeps the memory of the folder it was in
 * (pinned by the server). The review step names the memory kept.
 * Works for Claude Code and Codex sessions; worktree sessions are refused by
 * the server.
 */
export function SessionFolder({ sessionId }: { sessionId: string }) {
  // The session's own folder (stable), not the CLI's drifting working dir.
  const sdkFolder = useStore((s) => {
    const sdk = s.sdkSessions.find((x) => x.sessionId === sessionId);
    return sdk?.folder || sdk?.cwd || "";
  });
  const bridgeCwd = useStore((s) => s.sessions.get(sessionId)?.cwd ?? "");
  const currentCwd = sdkFolder || bridgeCwd;
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => setStep({ kind: "idle" }), [sessionId]);

  useEffect(() => {
    if (step.kind !== "done") return;
    const timer = setTimeout(() => setStep({ kind: "idle" }), DONE_MS);
    return () => clearTimeout(timer);
  }, [step.kind]);

  async function review(path: string) {
    setStep({ kind: "edit", path, checking: true });
    try {
      const preview = await api.previewSessionFolder(sessionId, path);
      setStep({ kind: "review", preview });
    } catch (err) {
      setStep({ kind: "edit", path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function move(preview: SessionFolderPreview) {
    setStep({ kind: "review", preview, moving: true });
    try {
      await api.changeSessionFolder(sessionId, preview.to);
      setStep({ kind: "done", to: preview.to });
    } catch (err) {
      setStep({ kind: "review", preview, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section aria-label="Session folder" className="shrink-0 px-4 py-2.5 border-b border-cc-separator">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted">Folder</h3>
          <p className="text-[11px] text-cc-fg font-mono-code truncate" title={currentCwd}>{currentCwd || "unknown"}</p>
        </div>
        {step.kind === "idle" || step.kind === "done" ? (
          <button
            type="button"
            onClick={() => setStep({ kind: "edit", path: currentCwd })}
            className="shrink-0 text-[11px] px-2 py-0.5 rounded-md text-cc-primary hover:bg-cc-primary/10 cursor-pointer"
          >
            Change folder
          </button>
        ) : null}
      </div>

      {step.kind === "edit" && (
        <form
          className="mt-2 space-y-1.5"
          aria-label="Choose the new folder"
          onSubmit={(e) => { e.preventDefault(); review(step.path); }}
        >
          <label className="block text-[11px] text-cc-muted">
            New folder
            <input
              type="text"
              value={step.path}
              onChange={(e) => setStep({ kind: "edit", path: e.target.value })}
              className="mt-0.5 w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs font-mono-code focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
          </label>
          {step.error && <p role="alert" className="text-[11px] text-cc-error">{step.error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="px-2.5 py-1 text-[11px] rounded-md text-cc-fg hover:bg-cc-hover border border-cc-border cursor-pointer"
            >
              Browse
            </button>
            <button
              type="submit"
              disabled={step.checking || step.path.trim() === ""}
              className="px-2.5 py-1 text-[11px] rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {step.checking ? "Checking..." : "Review"}
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "idle" })}
              className="px-2.5 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {step.kind === "review" && (
        <div className="mt-2 space-y-1.5 text-[11px]" role="group" aria-label="Review the folder change">
          <p className="text-cc-fg">
            Move to <span className="font-mono-code break-all">{step.preview.to}</span> and restart the CLI on the same
            conversation. Project instructions, skills and settings will come from the new folder.
          </p>
          {memoryLine(step.preview) && <p className="text-cc-warning">{memoryLine(step.preview)}</p>}
          {step.preview.interruptsWork && (
            <p className="text-cc-warning">The session is working: the restart interrupts what it is doing.</p>
          )}
          {step.error && <p role="alert" className="text-cc-error">{step.error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => move(step.preview)}
              disabled={step.moving}
              className="px-2.5 py-1 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
            >
              {step.moving ? "Moving..." : "Move and restart"}
            </button>
            <button
              type="button"
              onClick={() => setStep({ kind: "edit", path: step.preview.to })}
              disabled={step.moving}
              className="px-2.5 py-1 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer disabled:cursor-not-allowed"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <p role="status" className="mt-1 text-[11px] text-cc-success">
          Moved. The CLI is restarting in <span className="font-mono-code break-all">{step.to}</span>.
        </p>
      )}

      {pickerOpen && step.kind === "edit" && (
        <FolderPicker
          initialPath={step.path || currentCwd}
          onSelect={(path) => { setPickerOpen(false); setStep({ kind: "edit", path }); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
