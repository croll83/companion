import type { ReactNode } from "react";
import type { DomainGroup as DomainGroupType } from "../utils/project-grouping.js";

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
 * Sidebar section of one domain: a collapsible header (domain name, running
 * and waiting dots, session count) above its sessions.
 */
export function DomainGroup({ group, isCollapsed, onToggleCollapse, isFirst, children }: DomainGroupProps) {
  return (
    <section aria-label={`Domain ${group.label}`} className={!isFirst ? "mt-4" : ""}>
      <button
        type="button"
        onClick={() => onToggleCollapse(domainCollapseKey(group.key))}
        aria-expanded={!isCollapsed}
        className="w-full px-2 py-1 flex items-center gap-1.5 rounded-md bg-cc-hover/40 hover:bg-cc-hover transition-colors cursor-pointer"
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
          {group.runningCount > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-cc-success" title={`${group.runningCount} running in ${group.label}`} />
          )}
          {group.permCount > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-cc-warning" title={`${group.permCount} waiting in ${group.label}`} />
          )}
        </span>
        <span className="text-[10px] text-cc-muted tabular-nums shrink-0">
          {group.sessionCount} session{group.sessionCount === 1 ? "" : "s"}
        </span>
      </button>
      {!isCollapsed && <div className="mt-1 pl-1.5">{children}</div>}
    </section>
  );
}
