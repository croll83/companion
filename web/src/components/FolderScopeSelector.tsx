import { useId } from "react";

export type FolderScope = "global" | "project";

interface FolderScopeSelectorProps {
  /** Current scope; null = not assigned yet (neither option pressed). */
  scope: FolderScope | null;
  onScopeChange: (scope: FolderScope) => void;
  folders: string[];
  onRemoveFolder: (path: string) => void;
  onAddFolder: () => void;
  /** Explains what the scope controls for this kind of resource. */
  description: string;
  /** Explains what a folder-scoped resource does. */
  folderHint: string;
}

const optionClass = (active: boolean) =>
  `inline-flex min-h-[40px] items-center rounded-full border px-4 py-2 text-sm transition-colors cursor-pointer ${
    active
      ? "border-cc-primary/40 text-cc-primary bg-cc-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
      : "border-cc-border text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
  }`;

/**
 * Global / Project-folders scope picker shared by saved prompts and env
 * profiles: a folder-scoped resource applies to sessions whose working
 * directory is one of the folders or below one of them.
 */
export function FolderScopeSelector({
  scope,
  onScopeChange,
  folders,
  onRemoveFolder,
  onAddFolder,
  description,
  folderHint,
}: FolderScopeSelectorProps) {
  const labelId = useId();
  return (
    <div className="space-y-3" role="group" aria-labelledby={labelId}>
      <div>
        <p id={labelId} className="block text-xs font-medium uppercase tracking-[0.24em] text-cc-muted">Scope</p>
        <p className="mt-1 text-xs text-cc-muted/80">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={scope === "global"}
          onClick={() => onScopeChange("global")}
          className={optionClass(scope === "global")}
        >
          Global
        </button>
        <button
          type="button"
          aria-pressed={scope === "project"}
          onClick={() => onScopeChange("project")}
          className={optionClass(scope === "project")}
        >
          Project folders
        </button>
      </div>

      {scope === "project" && (
        <div className="rounded-2xl border border-cc-border/70 bg-cc-bg/60 p-3 space-y-3">
          <div>
            <p className="text-sm font-medium text-cc-fg">Project folders</p>
            <p className="mt-1 text-xs text-cc-muted">{folderHint}</p>
          </div>
          {folders.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {folders.map((folder) => (
                <span
                  key={folder}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-full border border-cc-border/80 bg-cc-hover px-3 py-1.5 text-xs font-mono-code text-cc-fg"
                >
                  <span className="truncate max-w-[200px]" title={folder}>
                    {folder.split("/").pop() || folder}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveFolder(folder)}
                    className="text-cc-muted hover:text-cc-error cursor-pointer shrink-0"
                    aria-label={`Remove folder ${folder}`}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onAddFolder}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-dashed border-cc-border px-3 py-2 text-sm text-cc-muted transition-colors cursor-pointer hover:text-cc-fg hover:bg-cc-hover"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            Add folder
          </button>
        </div>
      )}
    </div>
  );
}
