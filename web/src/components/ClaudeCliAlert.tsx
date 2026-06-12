import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { ClaudeCliCheckResult } from "../api.js";

const DISMISS_KEY = "companion_claude_cli_dismissed";
const POLL_INTERVAL_MS = 30_000;

interface Props {
  /**
   * Backend type of the active session. The banner is only rendered for
   * Claude-Code sessions; Codex uses its own CLI and is unaffected.
   */
  backendType?: "claude" | "codex";

  /** Inject a custom fetcher for tests. Defaults to api.getClaudeCliCheck. */
  fetcher?: () => Promise<ClaudeCliCheckResult>;
}

/**
 * Banner shown above the chat view when the installed Claude CLI is too old
 * for the stdio bridge (missing required flags) or otherwise failed to start
 * a session with an "unknown option" error. The fix is always `claude update`.
 *
 * Driven by GET /api/system/claude-cli-check, which combines a proactive
 * `claude --help` feature probe with a runtime backstop set by the launcher
 * when a session dies immediately with a flag error.
 */
export function ClaudeCliAlert({ backendType, fetcher }: Props) {
  const [check, setCheck] = useState<ClaudeCliCheckResult | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  });
  const [copied, setCopied] = useState(false);

  const fetchCheck = useCallback(async () => {
    try {
      const fn = fetcher ?? (() => api.getClaudeCliCheck());
      setCheck(await fn());
    } catch {
      // Network/auth errors are non-fatal — the banner just won't render.
    }
  }, [fetcher]);

  useEffect(() => {
    if (backendType !== "claude") return;
    fetchCheck();
    const id = setInterval(fetchCheck, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [backendType, fetchCheck]);

  if (backendType !== "claude") return null;
  if (!check || check.ok || dismissed) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(check.suggestedCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / insecure contexts may reject clipboard writes.
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      className="px-4 py-3 bg-gradient-to-r from-cc-error/10 to-cc-error/5 border-b border-cc-error/30 text-cc-fg animate-[fadeSlideIn_0.3s_ease-out]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-cc-error shrink-0" aria-hidden />
            <strong className="text-sm font-semibold">
              {check.found ? "Claude CLI needs updating" : "Claude CLI not found"}
            </strong>
          </div>
          <p className="text-xs text-cc-muted mb-2">
            {check.reason ?? "Your Claude CLI is incompatible with this Companion build."}{" "}
            Run this, then start a new session:
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="claude-cli-command"
              className="flex-1 px-2 py-1.5 rounded bg-cc-bg/80 border border-cc-border text-xs font-mono text-cc-fg overflow-x-auto whitespace-pre"
            >
              {check.suggestedCommand}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-card hover:bg-cc-bg border border-cc-border text-cc-fg transition-colors cursor-pointer shrink-0"
              aria-label="Copy claude update command"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
          aria-label="Dismiss Claude CLI alert"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
