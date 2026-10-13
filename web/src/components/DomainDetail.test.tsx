// @vitest-environment jsdom
/**
 * One domain: summary of what it has on (by name), MCP / Skills / Plugins as
 * tabs on desktop and as sheets on phones (the sheet's hash is the domain's
 * view, closing goes back to the domain), Chrome, and the actions menu
 * (edit CLAUDE.md / mcp.json, remove the domain when unused).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ listChromeBrowsers: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));
vi.mock("../ws.js", () => ({ sendMcpAuthenticate: vi.fn(), sendMcpOAuthCallback: vi.fn() }));

import { DomainDetail, type DomainActions } from "./DomainDetail.js";
import { domainsResponse, globalDomain, herdDomain } from "../test-fixtures/domains.js";
import type { DomainSummary } from "../api.js";
import type { DomainTab } from "../utils/routing.js";

function actions(): DomainActions {
  return {
    onPatch: vi.fn(),
    onAddServer: vi.fn(async () => true),
    onRemoveServer: vi.fn(async () => true),
    onCreateSkill: vi.fn(async () => true),
    onRemoveSkill: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onEdit: vi.fn(),
    onRefreshAccount: vi.fn(),
  };
}

function setup(opts: { domain?: DomainSummary; tab?: DomainTab; desktop?: boolean } = {}) {
  const a = actions();
  render(
    <DomainDetail domain={opts.domain ?? herdDomain()} data={domainsResponse()} tab={opts.tab} desktop={opts.desktop ?? false}
      busy={false} refreshingAccount={false} actions={a} />,
  );
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [] });
  window.location.hash = "";
});
afterEach(() => vi.useRealTimers());

describe("DomainDetail", () => {
  it("renders the domain with what it has on, by name (phone)", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Herd" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "‹ Domains" })).toHaveAttribute("href", "#/domains");
    expect(screen.getByText("2 sessions · 3 memory notes")).toBeInTheDocument();
    const mcp = screen.getByRole("link", { name: /MCP servers/ });
    expect(mcp).toHaveAttribute("href", "#/domains/herd/mcp");
    expect(mcp).toHaveTextContent("2 of 4 on: ping, claude.ai Gmail");
    expect(screen.getByRole("link", { name: /Skills/ })).toHaveTextContent("2 of 4 on · off: ton-audit, pdf");
    expect(screen.getByRole("link", { name: /Plugins/ })).toHaveTextContent("1 on: hercle-brain");
    expect(screen.getByRole("switch", { name: "Claude in Chrome" })).toBeInTheDocument();
  });

  it("passes axe accessibility scan on desktop and with a sheet open on phones", async () => {
    const { axe } = await import("vitest-axe");
    const { container, unmount } = render(
      <DomainDetail domain={herdDomain()} data={domainsResponse()} tab="mcp" desktop busy={false} refreshingAccount={false} actions={actions()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    render(<DomainDetail domain={herdDomain()} data={domainsResponse()} tab="skills" desktop={false} busy={false} refreshingAccount={false} actions={actions()} />);
    // The sheet is portaled to <body>: scan the dialog itself (a whole-body
    // scan only flags the test container being outside page landmarks).
    expect(await axe(screen.getByRole("dialog"))).toHaveNoViolations();
  });

  it("shows MCP / Skills / Plugins as tabs on desktop, MCP by default", () => {
    setup({ desktop: true });
    expect(screen.queryByRole("link", { name: "‹ Domains" })).toBeNull();
    expect(screen.getByRole("tab", { name: /MCP servers/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "MCP servers" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "MCP server ping" })).toBeInTheDocument();
  });

  it("wires each view to the domain's actions", () => {
    const a = setup({ desktop: true, tab: "mcp" });
    fireEvent.click(screen.getByRole("switch", { name: "MCP server ping" }));
    expect(a.onPatch).toHaveBeenCalledWith("herd", { mcp: { ping: false } });
  });

  it("wires the plugins and skills views", () => {
    const a = setup({ desktop: true, tab: "plugins" });
    fireEvent.click(screen.getByRole("switch", { name: "Plugin hercle-brain" }));
    expect(a.onPatch).toHaveBeenCalledWith("herd", { plugins: { "hercle-brain@hercle-lab": false } });
  });

  it("opens a view as a sheet on phones; closing goes back to the domain", () => {
    vi.useFakeTimers();
    setup({ tab: "skills" });
    expect(screen.getByRole("dialog", { name: "Herd · Skills" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(window.location.hash).toBe("#/domains/herd");
  });

  it("edits files and removes an unused domain from the actions menu", async () => {
    const a = setup({ domain: herdDomain({ totalSessions: 0 }) });
    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit CLAUDE.md" }));
    expect(a.onEdit).toHaveBeenCalledWith("herd", "CLAUDE.md");
    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit mcp.json" }));
    expect(a.onEdit).toHaveBeenCalledWith("herd", "mcp.json");
    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove domain…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Its folder and files stay on disk");
    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    expect(a.onDelete).toHaveBeenCalledWith("herd");
  });

  it("explains why a domain in use cannot be removed, and GLOBAL has no removal", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove domain…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Used by 2 sessions");
    expect(screen.queryByRole("button", { name: "Remove domain" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The Brain section patches the domain with one partial change; the
  // header names the brain the domain uses.
  it("wires the Brain select and names the brain in the summary", () => {
    const a = actions();
    render(
      <DomainDetail domain={herdDomain({ effectiveBrain: { slug: "jarvis", name: "Jarvis", own: false } })}
        data={domainsResponse({ brains: [{ slug: "jarvis", name: "Jarvis" }, { slug: "team", name: "Team" }], domains: [globalDomain({ brain: "jarvis", effectiveBrain: { slug: "jarvis", name: "Jarvis", own: true } }), herdDomain()] })}
        desktop={false} busy={false} refreshingAccount={false} actions={a} />,
    );
    expect(screen.getByText("2 sessions · 3 memory notes · brain Jarvis")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "As in GLOBAL (Jarvis)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Brain for this domain"), { target: { value: "team" } });
    expect(a.onPatch).toHaveBeenCalledWith("herd", { brain: "team" });
  });

  it("for GLOBAL: applies to every session, nothing on by name, no removal", () => {
    setup({ domain: globalDomain({ mcpServers: [] }) });
    expect(screen.getByText(/applies to every session/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MCP servers/ })).toHaveTextContent("0 of 0 on: none");
    expect(screen.getByRole("link", { name: /Plugins/ })).toHaveTextContent("0 on");
    fireEvent.click(screen.getByRole("button", { name: "Domain actions" }));
    expect(screen.queryByRole("menuitem", { name: "Remove domain…" })).toBeNull();
  });
});
