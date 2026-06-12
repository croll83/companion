import { useState } from "react";
import { useStore } from "../store.js";
import { createClientMessageId, sendToSession } from "../ws.js";

/** Fallback model offered when the active model refuses. */
const FALLBACK_MODEL = "claude-opus-4-8";
const FALLBACK_LABEL = "Opus 4.8";

/** Human-readable description for known refusal categories. */
const CATEGORY_LABELS: Record<string, string> = {
  cyber: "Cybersecurity policy",
  bio: "Biosecurity policy",
  frontier_llm: "Frontier-model policy",
  reasoning_extraction: "Reasoning-extraction policy",
};

interface RefusalBannerProps {
  refusal: { category?: string; explanation?: string; model?: string };
}

/**
 * Shown when a model returns `stop_reason: "refusal"` (an HTTP 200 with empty
 * content). Surfaces the category/explanation and offers a manual fallback:
 * switch to Opus 4.8 and re-send the last user prompt. (Automatic server-side
 * fallback is handled upstream at the gateway; this is the in-UI escape hatch.)
 */
export function RefusalBanner({ refusal }: RefusalBannerProps) {
  const [retried, setRetried] = useState(false);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const messages = useStore((s) =>
    currentSessionId ? s.messages.get(currentSessionId) : undefined,
  );

  const categoryLabel = refusal.category
    ? CATEGORY_LABELS[refusal.category] || refusal.category
    : null;
  const refusedByFallback = refusal.model === FALLBACK_MODEL;

  function handleRetry() {
    if (!currentSessionId) return;
    // Find the most recent user prompt to re-run on the fallback model.
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
    if (!lastUser) return;

    setRetried(true);

    // Switch model first — this relaunches the CLI with --resume. The
    // user_message below is queued by the bridge and delivered once the new
    // CLI reconnects, so the prompt re-runs on the fallback model in-context.
    sendToSession(currentSessionId, { type: "set_model", model: FALLBACK_MODEL });
    const { sdkSessions, setSdkSessions } = useStore.getState();
    setSdkSessions(
      sdkSessions.map((sdk) =>
        sdk.sessionId === currentSessionId ? { ...sdk, model: FALLBACK_MODEL } : sdk,
      ),
    );

    const clientMsgId = createClientMessageId();
    sendToSession(currentSessionId, {
      type: "user_message",
      content: lastUser.content,
      session_id: currentSessionId,
      client_msg_id: clientMsgId,
    });
    useStore.getState().appendMessage(currentSessionId, {
      id: clientMsgId,
      role: "user",
      content: lastUser.content,
      timestamp: Date.now(),
    });
  }

  return (
    <div className="px-2 sm:px-4 py-3" role="alert">
      <div className="max-w-3xl mx-auto rounded-xl border border-cc-warning/30 bg-cc-warning/[0.06] px-3 sm:px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 w-6 h-6 rounded-lg bg-cc-warning/15 border border-cc-warning/25 flex items-center justify-center shrink-0">
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
              <path fillRule="evenodd" d="M10 2a8 8 0 100 16 8 8 0 000-16zM9 6a1 1 0 112 0v4a1 1 0 11-2 0V6zm1 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-cc-warning">Model declined to respond</span>
              {categoryLabel && (
                <span className="text-[10px] font-medium text-cc-muted bg-cc-warning/10 px-1.5 py-0.5 rounded">
                  {categoryLabel}
                </span>
              )}
            </div>
            {refusal.explanation && (
              <p className="text-[13px] text-cc-fg mt-1 leading-relaxed break-words">
                {refusal.explanation}
              </p>
            )}
            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
              {!refusedByFallback && (
                <button
                  onClick={handleRetry}
                  disabled={retried}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-cc-primary/90 hover:bg-cc-primary text-white disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                    <path d="M2 8a6 6 0 1010-4.5M2 3v3h3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {retried ? `Retrying on ${FALLBACK_LABEL}…` : `Retry with ${FALLBACK_LABEL}`}
                </button>
              )}
              {refusedByFallback && (
                <span className="text-[11px] text-cc-muted italic">
                  {FALLBACK_LABEL} also declined — try rephrasing the request.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
