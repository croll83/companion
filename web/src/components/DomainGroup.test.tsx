// @vitest-environment jsdom
/**
 * DomainGroup is a domain's section in the sidebar: a collapsible header
 * (name, unread badge, waiting dot, session count) above its sessions.
 * Green means "new result" in the sidebar now, so the header no longer
 * shows a green "running" dot: the badge counts the unread sessions.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainGroup, domainCollapseKey } from "./DomainGroup.js";

const group = { key: "herd", label: "Herd", sessions: [], sessionCount: 3, runningCount: 2, permCount: 1, unreadCount: 2 };

describe("DomainGroup", () => {
  it("renders the domain header and its sessions", () => {
    render(<DomainGroup group={group} isCollapsed={false} onToggleCollapse={vi.fn()} isFirst><p>session row</p></DomainGroup>);
    expect(screen.getByRole("region", { name: "Domain Herd" })).toBeInTheDocument();
    expect(screen.getByText("3 sessions")).toBeInTheDocument();
    expect(screen.getByTitle("2 sessions with a new result in Herd")).toHaveTextContent("2 unread");
    expect(screen.queryByTitle(/running in Herd/)).toBeNull();
    expect(screen.getByTitle("1 waiting for your approval in Herd")).toBeInTheDocument();
    expect(screen.getByText("session row")).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DomainGroup group={{ ...group, sessionCount: 1, runningCount: 0, permCount: 0 }} isCollapsed onToggleCollapse={vi.fn()} isFirst={false}><p>x</p></DomainGroup>,
    );
    expect(await axe(container)).toHaveNoViolations();
    expect(screen.getByText("1 session")).toBeInTheDocument();
  });

  it("shows no badge when every result was seen, and a singular title for one", () => {
    const { rerender } = render(<DomainGroup group={{ ...group, unreadCount: 0 }} isCollapsed={false} onToggleCollapse={vi.fn()} isFirst><p>x</p></DomainGroup>);
    expect(screen.queryByText(/unread/)).toBeNull();
    rerender(<DomainGroup group={{ ...group, unreadCount: 1 }} isCollapsed={false} onToggleCollapse={vi.fn()} isFirst><p>x</p></DomainGroup>);
    expect(screen.getByTitle("1 session with a new result in Herd")).toBeInTheDocument();
  });

  // Collapse state lives in the store's collapsed set, under a prefixed key.
  it("toggles collapse with its own key and hides the sessions when collapsed", () => {
    const onToggle = vi.fn();
    render(<DomainGroup group={group} isCollapsed onToggleCollapse={onToggle} isFirst><p>session row</p></DomainGroup>);
    expect(screen.queryByText("session row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledWith(domainCollapseKey("herd"));
    expect(domainCollapseKey("herd")).toBe("domain:herd");
  });

  // The gear opens the domain's settings (its MCP servers, skills, plugins).
  it("links the domain's settings from the header", () => {
    render(<DomainGroup group={group} isCollapsed={false} onToggleCollapse={vi.fn()} isFirst><p>session row</p></DomainGroup>);
    expect(screen.getByRole("link", { name: "Settings of domain Herd" })).toHaveAttribute("href", "#/domains/herd");
  });
});
