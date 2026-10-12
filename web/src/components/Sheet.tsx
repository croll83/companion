import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A large panel over the page: a bottom sheet on phones, a centered dialog
 * on wider screens (same look as the folder picker). Closes with the ×
 * button, a click on the backdrop or Escape, after a short exit animation.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 150);
  }, [closing, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center transition-opacity duration-150 ${closing ? "opacity-0" : "opacity-100"}`}
      style={{ backgroundColor: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
      onClick={close}
      data-testid="sheet-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-2xl h-[min(680px,92dvh)] sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden transition-transform duration-150 ${closing ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100"}`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-cc-border shrink-0">
          <h2 className="text-sm font-semibold text-cc-fg">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="w-7 h-7 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
