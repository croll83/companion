// @vitest-environment jsdom
/**
 * DomainGroup is a domain's section in the sidebar: a collapsible header
 * (name, running/waiting dots, session count) above its sessions.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainGroup, domainCollapseKey } from "./DomainGroup.js";

const group = { key: "herd", label: "Herd", sessions: [], sessionCount: 3, runningCount: 2, permCount: 1 };

describe("DomainGroup", () => {
  it("renders the domain header and its sessions", () => {
    render(<DomainGroup group={group} isCollapsed={false} onToggleCollapse={vi.fn()} isFirst><p>session row</p></DomainGroup>);
    expect(screen.getByRole("region", { name: "Domain Herd" })).toBeInTheDocument();
    expect(screen.getByText("3 sessions")).toBeInTheDocument();
    expect(screen.getByTitle("2 running in Herd")).toBeInTheDocument();
    expect(screen.getByTitle("1 waiting in Herd")).toBeInTheDocument();
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
