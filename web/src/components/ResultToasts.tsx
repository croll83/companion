import { useEffect } from "react";
import { useStore } from "../store.js";
import { navigateToSession } from "../utils/routing.js";
import { sessionTitle } from "../utils/session-unread.js";

/** How long a toast stays while the page is visible. */
export const TOAST_MS = 10_000;

/**
 * "Result ready" toasts, top right: a session the user is not looking at
 * finished a turn (utils/session-unread.ts). Clicking one opens that
 * session; each closes by itself after 10 s of the page being visible, so
 * a toast raised while the user was away is still there when they return.
 */
export function ResultToasts() {
  const toasts = useStore((s) => s.resultToasts);
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Sessions with a new result"
      className="fixed top-3 right-3 z-50 flex flex-col gap-2 w-[min(20rem,calc(100vw-1.5rem))]"
    >
      {toasts.map((t) => <ResultToast key={t.key} toastKey={t.key} sessionId={t.sessionId} />)}
    </div>
  );
}

function ResultToast({ toastKey, sessionId }: { toastKey: number; sessionId: string }) {
  const dismiss = useStore((s) => s.dismissResultToast);
  // Re-read the title when names change (auto-naming can land with the result).
  useStore((s) => s.sessionNames.get(sessionId));
  const title = sessionTitle(sessionId);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer || document.visibilityState !== "visible") return;
      timer = setTimeout(() => dismiss(toastKey), TOAST_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      document.removeEventListener("visibilitychange", arm);
      if (timer) clearTimeout(timer);
    };
  }, [toastKey, dismiss]);

  return (
    <div className="flex items-start gap-2 p-3 rounded-xl bg-cc-card border border-cc-border shadow-xl animate-[menu-appear_150ms_ease-out]">
      <span className="mt-1 w-2 h-2 rounded-full bg-cc-success shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={() => {
          dismiss(toastKey);
          navigateToSession(sessionId);
        }}
        className="flex-1 min-w-0 text-left cursor-pointer"
      >
        <span className="block text-[13px] font-medium text-cc-fg truncate">{title}</span>
        <span className="block text-[11px] text-cc-muted">Result ready · open the session</span>
      </button>
      <button
        type="button"
        onClick={() => dismiss(toastKey)}
        aria-label={`Dismiss the notification of ${title}`}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-3 h-3" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
