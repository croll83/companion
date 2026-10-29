import type { ReactNode } from "react";
import type { DomainGroup as DomainGroupType } from "../utils/project-grouping.js";
import { domainsHash } from "../utils/routing.js";

interface DomainGroupProps {
  group: DomainGroupType;
  isCollapsed: boolean;
  onToggleCollapse: (key: string) => void;
  isFirst: boolean;
  /** The domain's session rows (SessionItem elements). */
  children: ReactNode;
}

/** Collapse key of a domain in the sidebar. */
export function domainCollapseKey(slug: string): string {
  return `domain:${slug}`;
}

/**
 * Sidebar section of one domain: a collapsible header (domain name, a badge
 * counting the sessions with a result not seen yet, a dot when one waits for
 * an approval, session count) above its sessions, and a gear opening the
 * domain's settings (#/domains/<slug>).
 */
export function DomainGroup({ group, isCollapsed, onToggleCollapse, isFirst, children }: DomainGroupProps) {
  return (
    <section aria-label={`Domain ${group.label}`} className={!isFirst ? "mt-4" : ""}>
      <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onToggleCollapse(domainCollapseKey(group.key))}
        aria-expanded={!isCollapsed}
        className="flex-1 min-w-0 px-2 py-1 flex items-center gap-1.5 rounded-md bg-cc-hover/40 hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
          className={`w-2 h-2 text-cc-muted transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="text-[11px] font-bold text-cc-fg/80 truncate uppercase tracking-wider">{group.label}</span>
        <span className="flex items-center gap-1 ml-auto shrink-0">
          {group.permCount > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-cc-warning" title={`${group.permCount} waiting for your approval in ${group.label}`} />
          )}
          {group.unreadCount > 0 && (
            <span
              className="min-w-4 h-4 px-1 rounded-full bg-cc-error text-white text-[10px] font-semibold leading-4 text-center tabular-nums"
              title={`${group.unreadCount} session${group.unreadCount === 1 ? "" : "s"} with a new result in ${group.label}`}
            >
              {group.unreadCount}
              <span className="sr-only"> unread</span>
            </span>
          )}
        </span>
        <span className="text-[10px] text-cc-muted tabular-nums shrink-0">
          {group.sessionCount} session{group.sessionCount === 1 ? "" : "s"}
        </span>
      </button>
      <a
        href={domainsHash(group.key)}
        aria-label={`Settings of domain ${group.label}`}
        title={`MCP servers, skills and plugins of ${group.label}`}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="w-3.5 h-3.5" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" strokeLinecap="round" />
        </svg>
      </a>
      </div>
      {!isCollapsed && <div className="mt-1 pl-1.5">{children}</div>}
    </section>
  );
}
