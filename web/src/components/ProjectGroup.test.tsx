// @vitest-environment jsdom
/**
 * ProjectGroup is a folder's group in the sidebar. Its label is short (and
 * made unambiguous by project-grouping), so the full folder path is the
 * header's tooltip. Covers render, collapse and the preview of a collapsed group.
 */
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ProjectGroup } from "./ProjectGroup.js";
import type { SessionItem } from "../utils/project-grouping.js";

const session: SessionItem = {
  id: "s1", model: "m", cwd: "/home/u/herd/web", gitBranch: "", gitAhead: 0, gitBehind: 0, linesAdded: 0, linesRemoved: 0,
  isConnected: true, isReconnecting: false, status: null, sdkState: "connected", createdAt: 1, archived: false,
  backendType: "claude", repoRoot: "", permCount: 0,
};

function renderGroup(isCollapsed: boolean, onToggleCollapse = vi.fn()) {
  return render(
    <ProjectGroup
      group={{ key: "/home/u/herd/web", label: "herd/web", title: "/home/u/herd/web", sessions: [session], runningCount: 0, permCount: 0, mostRecentActivity: 1 }}
      isCollapsed={isCollapsed}
      onToggleCollapse={onToggleCollapse}
      currentSessionId={null}
      sessionNames={new Map([["s1", "Brave Falcon"]])}
      pendingPermissions={new Map()}
      recentlyRenamed={new Set()}
      onSelect={vi.fn()}
      onStartRename={vi.fn()}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onDelete={vi.fn()}
      onConnectTelegram={vi.fn()}
      telegramConfigured={false}
      onClearRecentlyRenamed={vi.fn()}
      editingSessionId={null}
      editingName=""
      setEditingName={vi.fn()}
      onConfirmRename={vi.fn()}
      onCancelRename={vi.fn()}
      editInputRef={createRef<HTMLInputElement>()}
      isFirst
    />,
  );
}

describe("ProjectGroup", () => {
  it("renders the short label with the full folder path as tooltip", () => {
    renderGroup(false);
    expect(screen.getByText("herd/web")).toHaveAttribute("title", "/home/u/herd/web");
    expect(screen.getByText("Brave Falcon")).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = renderGroup(true);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("toggles collapse and shows a preview when collapsed", () => {
    const onToggle = vi.fn();
    renderGroup(true, onToggle);
    expect(screen.getByText("Brave Falcon")).toBeInTheDocument(); // preview line
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledWith("/home/u/herd/web");
  });
});
