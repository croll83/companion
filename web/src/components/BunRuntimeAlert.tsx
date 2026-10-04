import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { BunRuntimeCheckResult } from "../api.js";

/**
 * localStorage key holding the Bun version the user dismissed the banner for.
 * Dismissal is per Bun version: if Companion is still on an outdated Bun after
 * another update (a different version string), the banner comes back.
 */
export const BUN_RUNTIME_DISMISS_KEY = "companion_bun_runtime_dismissed_version";
// The Bun version can only change across a server restart, so a slow poll is
// enough to clear the banner after `bun upgrade` + restart without a reload.
const POLL_INTERVAL_MS = 5 * 60_000;
const UPGRADE_COMMAND = "bun upgrade";
const RESTART_COMMAND = "the-companion restart";

interface Props {
  /** Inject a custom fetcher for tests / the Playground. Defaults to api.getBunRuntimeCheck. */
  fetcher?: () => Promise<BunRuntimeCheckResult>;
  /**
   * localStorage key for the per-version dismissal. Defaults to
   * BUN_RUNTIME_DISMISS_KEY (the app-wide banner). The Playground passes its
   * own key so dismissing a sample card (which may show a real outdated
   * version like 1.3.9) never suppresses the real banner on the same origin.
   */
  storageKey?: string;
}

function readDismissedVersion(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** A command in a code box with its own copy button. */
function CopyableCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / insecure contexts may reject clipboard writes.
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 px-2 py-1.5 rounded bg-cc-bg/80 border border-cc-border text-xs font-mono text-cc-fg overflow-x-auto whitespace-pre">
        {command}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-card hover:bg-cc-bg border border-cc-border text-cc-fg transition-colors cursor-pointer shrink-0"
        aria-label={label}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Banner shown when Companion runs on a Bun older than the supported minimum
 * (1.4.0). Those versions have a subprocess-stream bug (oven-sh/bun#32743)
 * that can end a live CLI session's stdout, killing the session mid-work —
 * for both Claude Code and Codex sessions, hence it's mounted app-wide.
 *
 * Companion's auto-updater never upgrades Bun itself, so after an update the
 * service restarts on the same old runtime. The fix is manual: `bun upgrade`,
 * then restart Companion. Nothing is shown when the check passes, when the
 * version is unparseable (reason "unknown"), or when the request fails.
 */
export function BunRuntimeAlert({ fetcher, storageKey = BUN_RUNTIME_DISMISS_KEY }: Props) {
  const [check, setCheck] = useState<BunRuntimeCheckResult | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    readDismissedVersion(storageKey),
  );

  const fetchCheck = useCallback(async () => {
    try {
      const fn = fetcher ?? (() => api.getBunRuntimeCheck());
      setCheck(await fn());
    } catch {
      // Network/auth errors are non-fatal — the banner just won't render.
    }
  }, [fetcher]);

  useEffect(() => {
    fetchCheck();
    const id = setInterval(fetchCheck, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchCheck]);

  if (!check || check.ok || !check.version) return null;
  if (dismissedVersion === check.version) return null;

  const handleDismiss = () => {
    try {
      localStorage.setItem(storageKey, check.version!);
    } catch {
      // Storage may be unavailable (private mode); dismiss for this view only.
    }
    setDismissedVersion(check.version);
  };

  return (
    <div
      role="alert"
      className="px-4 py-3 bg-gradient-to-r from-cc-warning/10 to-cc-warning/5 border-b border-cc-warning/30 text-cc-fg animate-[fadeSlideIn_0.3s_ease-out]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-cc-warning shrink-0" aria-hidden />
            <strong className="text-sm font-semibold">Bun needs updating</strong>
          </div>
          <p className="text-xs text-cc-muted mb-2">
            Companion is running on Bun {check.version}; versions older than {check.minimum} have a bug that
            can drop live sessions. Companion updates don't upgrade Bun. Run this
            {check.isServiceMode ? ", then restart Companion:" : ", then restart Companion."}
          </p>
          <div className="space-y-1.5">
            <CopyableCommand command={UPGRADE_COMMAND} label="Copy bun upgrade command" />
            {check.isServiceMode && (
              <CopyableCommand command={RESTART_COMMAND} label="Copy restart command" />
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-cc-muted hover:text-cc-fg transition-colors cursor-pointer shrink-0"
          aria-label="Dismiss Bun runtime alert"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4" aria-hidden>
            <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
