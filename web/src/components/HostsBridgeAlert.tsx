import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { HostsCheckResult } from "../api.js";

const DISMISS_KEY = "companion_hosts_bridge_dismissed";
const POLL_INTERVAL_MS = 30_000;

interface Props {
  /**
   * Backend type of the active session. The banner is only rendered for
   * Claude-Code sessions because Codex does not use --sdk-url and is therefore
   * unaffected by the 2.1.142 allowlist.
   */
  backendType?: "claude" | "codex";

  /** Inject a custom fetcher for tests. Defaults to api.getHostsCheck. */
  fetcher?: () => Promise<HostsCheckResult>;
}

/**
 * Banner shown above the chat view when the user's hosts file does not map
 * the allowlisted Anthropic hostname to 127.0.0.1. Without this mapping,
 * Claude Code 2.1.142+ sessions cannot connect to the embedded TLS proxy
 * and `claude spawn` will fail with the misleading "host ... is not an
 * approved Anthropic endpoint" error.
 *
 * The banner offers the platform-specific copy-paste command the user must
 * run; we deliberately do NOT attempt to write /etc/hosts ourselves because
 * that would require sudo and is a privileged operation we don't want to
 * perform silently.
 */
export function HostsBridgeAlert({ backendType, fetcher }: Props) {
  const [check, setCheck] = useState<HostsCheckResult | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  });
  const [copied, setCopied] = useState(false);

  const fetchCheck = useCallback(async () => {
    try {
      const fn = fetcher ?? api.getHostsCheck;
      const result = await fn();
      setCheck(result);
    } catch {
      // Network/auth errors are non-fatal — the banner just won't render.
      // The user can still consult server logs for the same warning.
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
      // Surface the failure silently — the command is still visible.
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
              Claude Code can&rsquo;t connect &mdash; hosts file missing entry
            </strong>
          </div>
          <p className="text-xs text-cc-muted mb-2">
            Anthropic restricts <code className="px-1 py-0.5 rounded bg-cc-bg/60 text-cc-fg">--sdk-url</code> to a fixed hostname list.
            Add this line to your hosts file ({check.hostsPath}) to route a permitted hostname to localhost:
          </p>
          <div className="flex items-center gap-2">
            <code
              data-testid="hosts-bridge-command"
              className="flex-1 px-2 py-1.5 rounded bg-cc-bg/80 border border-cc-border text-xs font-mono text-cc-fg overflow-x-auto whitespace-pre"
            >
              {check.suggestedCommand}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-card hover:bg-cc-bg border border-cc-border text-cc-fg transition-colors cursor-pointer shrink-0"
              aria-label="Copy hosts file command"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
          aria-label="Dismiss hosts file alert"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
