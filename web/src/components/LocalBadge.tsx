import type { SdkSessionInfo } from "../types.js";
import { localSessionLabel } from "../utils/local-session.js";

/**
 * "Local · <provider>/<model>" on a session that runs on a local provider
 * (Claude Code pointed at a Companion LLM proxy) instead of the Anthropic
 * account. `compact` is the sidebar's two-letter pill (like CC / CX), with
 * the full label as its accessible name and tooltip.
 */
export function LocalBadge({ local, compact = false }: { local: NonNullable<SdkSessionInfo["local"]>; compact?: boolean }) {
  const label = localSessionLabel(local);
  const title = local.missing ? `${label} (provider deleted: the session cannot start again)` : label;
  if (compact) {
    return (
      <span
        role="img"
        aria-label={title}
        title={title}
        className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-600 dark:text-violet-300 leading-none"
      >
        LO
      </span>
    );
  }
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 max-w-[16rem] truncate text-[11px] font-medium px-2 py-0.5 rounded-full border ${
        local.missing
          ? "border-cc-error/30 text-cc-error bg-cc-error/5"
          : "border-violet-500/30 text-violet-700 dark:text-violet-300 bg-violet-500/10"
      }`}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 shrink-0" aria-hidden="true">
        <rect x="2.5" y="3" width="11" height="7" rx="1" />
        <path d="M5.5 13h5M8 10v3" strokeLinecap="round" />
      </svg>
      <span className="truncate">{label}</span>
    </span>
  );
}
