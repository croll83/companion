// @vitest-environment jsdom
/**
 * The Domains page container: on phones the list of domains, then one
 * domain (#/domains/<slug>); on desktop both side by side (GLOBAL when none
 * is chosen). Every change goes to the API as a partial update and the page
 * reloads every domain (states depend on GLOBAL). Errors are shown; a stale
 * list of account MCP servers is refreshed once when the page opens.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listDomains: vi.fn(),
  createDomain: vi.fn(),
  updateDomain: vi.fn(),
  deleteDomain: vi.fn(),
  readDomainFile: vi.fn(),
  writeDomainFile: vi.fn(),
  listChromeBrowsers: vi.fn(),
  setDomainMcpServer: vi.fn(),
  removeDomainMcpServer: vi.fn(),
  refreshAccountMcp: vi.fn(),
  createDomainSkill: vi.fn(),
  removeDomainSkill: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));
vi.mock("../ws.js", () => ({ sendMcpAuthenticate: vi.fn(), sendMcpOAuthCallback: vi.fn() }));

import { DomainsPage } from "./DomainsPage.js";
import { domainsResponse, herdDomain } from "../test-fixtures/domains.js";

const originalMatchMedia = window.matchMedia;
function desktop(on: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: on, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  desktop(false);
  window.location.hash = "";
  mockApi.listDomains.mockResolvedValue(domainsResponse());
  for (const fn of ["createDomain", "updateDomain", "setDomainMcpServer", "removeDomainMcpServer", "createDomainSkill", "removeDomainSkill"] as const) {
    mockApi[fn].mockResolvedValue({});
  }
  mockApi.deleteDomain.mockResolvedValue({ ok: true });
  mockApi.readDomainFile.mockResolvedValue({ path: "/home/u/companion_domain_herd/CLAUDE.md", content: "# Herd", format: "markdown", readOnly: false });
  mockApi.refreshAccountMcp.mockResolvedValue({ at: Date.now(), servers: 3 });
  mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [] });
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("DomainsPage", () => {
  it("on phones shows the list of domains first", async () => {
    render(<DomainsPage />);
    expect(await screen.findByRole("navigation", { name: "Domains" })).toBeInTheDocument();
    expect(screen.getByText(/Domain folders live in/)).toHaveTextContent("/home/u");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("passes axe accessibility scan on the list and on a domain", async () => {
    const { axe } = await import("vitest-axe");
    const { container, unmount } = render(<DomainsPage />);
    await screen.findByRole("navigation", { name: "Domains" });
    expect(await axe(container)).toHaveNoViolations();
    unmount();
    const second = render(<DomainsPage slug="herd" />);
    await screen.findByRole("article", { name: "Domain Herd" });
    expect(await axe(second.container)).toHaveNoViolations();
  });

  it("on phones shows one domain when chosen, and says so when it does not exist", async () => {
    const { unmount } = render(<DomainsPage slug="herd" />);
    expect(await screen.findByRole("article", { name: "Domain Herd" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Domains" })).toBeNull();
    unmount();
    render(<DomainsPage slug="nope" />);
    expect(await screen.findByText('No domain "nope".')).toBeInTheDocument();
  });

  it("on desktop shows the list next to the chosen domain, GLOBAL when none is chosen", async () => {
    desktop(true);
    render(<DomainsPage />);
    expect(await screen.findByRole("article", { name: "Domain GLOBAL" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Domains" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /MCP servers/ })).toBeInTheDocument();
  });

  it("sends a switch as a partial update and reloads every domain", async () => {
    desktop(true);
    render(<DomainsPage slug="herd" tab="mcp" />);
    fireEvent.click(await screen.findByRole("switch", { name: "MCP server ping" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { mcp: { ping: false } }));
    await waitFor(() => expect(mockApi.listDomains).toHaveBeenCalledTimes(2));
  });

  it("adds and removes servers and skills, creates a domain", async () => {
    desktop(true);
    const { unmount } = render(<DomainsPage slug="herd" tab="mcp" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "brain" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://h/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mockApi.setDomainMcpServer).toHaveBeenCalledWith("herd", "brain", { url: "http://h/mcp" }));
    fireEvent.click(screen.getByRole("button", { name: "Details of ping" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove MCP server ping" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockApi.removeDomainMcpServer).toHaveBeenCalledWith("herd", "ping"));
    unmount();

    render(<DomainsPage slug="herd" tab="skills" />);
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    fireEvent.change(screen.getByLabelText(/Name \(lowercase/), { target: { value: "deploy-check" } });
    fireEvent.change(screen.getByLabelText("When the model should use it"), { target: { value: "Before merging" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockApi.createDomainSkill).toHaveBeenCalledWith("herd", "deploy-check", "Before merging"));
    fireEvent.click(screen.getByRole("button", { name: "Remove skill herd-hello" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockApi.removeDomainSkill).toHaveBeenCalledWith("herd", "herd-hello"));

    fireEvent.click(screen.getByRole("button", { name: "New domain" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Satoshi" } });
    fireEvent.click(screen.getByRole("button", { name: "Create domain" }));
    await waitFor(() => expect(mockApi.createDomain).toHaveBeenCalledWith("Satoshi", undefined));
  });

  it("removes an unused domain and goes back to the list", async () => {
    mockApi.listDomains.mockResolvedValue(domainsResponse({ domains: [herdDomain({ totalSessions: 0 })] }));
    render(<DomainsPage slug="herd" />);
    fireEvent.click(await screen.findByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove domain…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    await waitFor(() => expect(mockApi.deleteDomain).toHaveBeenCalledWith("herd"));
    await waitFor(() => expect(window.location.hash).toBe("#/domains"));
  });

  it("edits a domain's CLAUDE.md through the domain file routes", async () => {
    render(<DomainsPage slug="herd" />);
    fireEvent.click(await screen.findByRole("button", { name: "Domain actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit CLAUDE.md" }));
    await waitFor(() => expect(mockApi.readDomainFile).toHaveBeenCalledWith("herd", "CLAUDE.md"));
    expect(await screen.findByText("Herd: CLAUDE.md")).toBeInTheDocument();
  });

  it("shows a failed load and a failed change", async () => {
    mockApi.listDomains.mockRejectedValueOnce(new Error("server down"));
    const { unmount } = render(<DomainsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("server down");
    unmount();
    desktop(true);
    mockApi.updateDomain.mockRejectedValue(new Error("mcp \"a\" must be true, false or null"));
    render(<DomainsPage slug="herd" tab="mcp" />);
    fireEvent.click(await screen.findByRole("switch", { name: "MCP server ping" }));
    expect(await screen.findByText(/must be true, false or null/)).toBeInTheDocument();
    mockApi.deleteDomain.mockRejectedValue(new Error("in use"));
  });

  it("refreshes a stale account list once when the page opens, and on request", async () => {
    desktop(true);
    mockApi.listDomains.mockResolvedValue(domainsResponse({ accountMcp: { at: 0, stale: true } }));
    let finish!: (v: unknown) => void;
    mockApi.refreshAccountMcp.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<DomainsPage slug="herd" tab="mcp" />);
    expect(await screen.findByText(/being read/)).toBeInTheDocument();
    await act(async () => { finish({ at: 1, servers: 0 }); });
    // Still stale after the reload: not asked again (no loop).
    await waitFor(() => expect(mockApi.listDomains).toHaveBeenCalledTimes(2));
    expect(mockApi.refreshAccountMcp).toHaveBeenCalledTimes(1);
    mockApi.refreshAccountMcp.mockResolvedValue({ at: 2, servers: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockApi.refreshAccountMcp).toHaveBeenCalledTimes(2));
  });
});
