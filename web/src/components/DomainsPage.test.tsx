// @vitest-environment jsdom
/**
 * The Domains page lists domains with their folder, sessions, memory, skills,
 * MCP servers and skill groups (on/off per domain), Claude in Chrome
 * (Claude Code only), edits CLAUDE.md / mcp.json, creates domains, and
 * removes one only when no session uses it (files stay on disk).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
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
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainsPage } from "./DomainsPage.js";

const base = { createdAt: 0, mcpDisabled: [], chrome: false, chromeBrowser: "local", memoryNotes: 0, skills: [], mcpServers: [], skillGroupStates: {} };
const groups = [
  { id: "user", label: "Your skills", description: "In ~/.claude/skills", skills: ["foundry-poc"], codex: "linked" },
  { id: "claude-ai", label: "claude.ai skills", description: "Synced", skills: ["pdf", "docs"], codex: "unsupported" },
];
const plugins = [{
  id: "hercle-brain@hercle-lab", name: "hercle-brain", marketplace: "hercle-lab", version: "0.1.4", skills: ["hercle-brain"],
  mcpServers: [{ name: "hercle-brain", type: "http", target: "http://127.0.0.1:7420/mcp" }], enabledByUser: false,
}];
const response = () => ({
  root: "/home/u",
  skillGroups: groups,
  plugins,
  domains: [
    { ...base, slug: "global", name: "GLOBAL", path: "/home/u/companion_domain_global", sessionCount: 4, totalSessions: 5,
      skillGroupStates: { user: { on: true, own: false }, "claude-ai": { on: true, own: false } } },
    { ...base, slug: "herd", name: "Herd", description: "The herd project", path: "/home/u/companion_domain_herd", sessionCount: 0, totalSessions: 0,
      memoryNotes: 3, skills: ["herd-hello"], mcpDisabled: ["gh"],
      mcpServers: [
        { name: "gh", source: "global", enabled: false, type: "stdio" },
        { name: "noisy", source: "global", enabled: false, disabledGlobally: true, type: "stdio" },
        { name: "ping", source: "domain", enabled: true, type: "http" },
      ],
      skillGroupStates: { user: { on: false, own: true }, "claude-ai": { on: true, own: false } } },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listDomains.mockResolvedValue(response());
  mockApi.updateDomain.mockResolvedValue({});
  mockApi.createDomain.mockResolvedValue({});
  mockApi.deleteDomain.mockResolvedValue({ ok: true });
  mockApi.readDomainFile.mockResolvedValue({ path: "/home/u/companion_domain_herd/CLAUDE.md", content: "# Herd", format: "markdown", readOnly: false });
  mockApi.writeDomainFile.mockResolvedValue({ ok: true });
  mockApi.setDomainMcpServer.mockResolvedValue({});
  mockApi.removeDomainMcpServer.mockResolvedValue({});
  mockApi.refreshAccountMcp.mockResolvedValue({ at: Date.now(), servers: 3 });
  mockApi.listChromeBrowsers.mockResolvedValue({
    browsers: [
      { deviceId: "dev-linux", name: "Chrome", osPlatform: "Linux", isLocal: true, inUse: true },
      { deviceId: "dev-mac", name: "Safari-Chrome", osPlatform: "macOS", isLocal: false, inUse: false },
    ],
  });
});

/** A clone of the response where Herd has Claude in Chrome on. */
function chromeOnResponse(chromeBrowser = "local") {
  const data = response();
  data.domains[1] = { ...data.domains[1], chrome: true, chromeBrowser };
  return data;
}

const herdCard = () => screen.getByRole("article", { name: "Domain Herd" });

describe("DomainsPage", () => {
  it("renders every domain with its stats", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    expect(screen.getByText(/Domain folders live in/)).toHaveTextContent("/home/u");
    const herd = within(herdCard());
    expect(herd.getByText("The herd project")).toBeInTheDocument();
    expect(herd.getByText("herd-hello")).toBeInTheDocument();
    expect(herd.getByText("3")).toBeInTheDocument();
    expect(herd.getByText("off in GLOBAL")).toBeInTheDocument();
    expect(herd.getByText(/Requires Claude Code \(Codex sessions are not affected\)/)).toBeInTheDocument();
    // GLOBAL cannot be removed: no Remove button in its card.
    expect(within(screen.getByRole("article", { name: "Domain GLOBAL" })).queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("toggles MCP servers, skill groups and Chrome per domain", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    fireEvent.click(herd.getByRole("switch", { name: "MCP server gh" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { mcpDisabled: [] }));
    fireEvent.click(herd.getByRole("switch", { name: "MCP server ping" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { mcpDisabled: ["gh", "ping"] }));
    // A server switched off in GLOBAL cannot be switched on per domain.
    expect(herd.getByRole("switch", { name: "MCP server noisy" })).toBeDisabled();
    fireEvent.click(herd.getByRole("switch", { name: "Skill group Your skills" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { skillGroups: { user: true } }));
    fireEvent.click(herd.getByRole("switch", { name: "Claude in Chrome" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { chrome: true }));
    expect(mockApi.listDomains.mock.calls.length).toBeGreaterThan(1);
  });

  it("creates a domain", async () => {
    render(<DomainsPage />);
    const form = await screen.findByRole("form", { name: "New domain" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Design" } });
    fireEvent.change(within(form).getByLabelText(/What it is about/), { target: { value: "UI work" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create domain" }));
    await waitFor(() => expect(mockApi.createDomain).toHaveBeenCalledWith("Design", "UI work"));
  });

  // Removing never deletes files, and a domain in use cannot be removed.
  it("removes an unused domain after confirmation, keeping its files", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    fireEvent.click(within(herdCard()).getByRole("button", { name: "Remove" }));
    expect(within(herdCard()).getByText(/folder and files stay on disk/)).toBeInTheDocument();
    fireEvent.click(within(herdCard()).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(herdCard()).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(herdCard()).getByRole("button", { name: "Remove domain" }));
    await waitFor(() => expect(mockApi.deleteDomain).toHaveBeenCalledWith("herd"));
  });

  it("does not offer to remove a domain in use", async () => {
    const data = response();
    data.domains[1].totalSessions = 2;
    mockApi.listDomains.mockResolvedValue(data);
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    expect(within(herdCard()).getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(within(herdCard()).getByText(/Used by 2 sessions/)).toBeInTheDocument();
  });

  it("edits a domain's CLAUDE.md through the domain file routes", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    fireEvent.click(within(herdCard()).getByRole("button", { name: "Edit CLAUDE.md" }));
    const editor = await screen.findByRole("dialog");
    expect(mockApi.readDomainFile).toHaveBeenCalledWith("herd", "CLAUDE.md");
    const textarea = await within(editor).findByLabelText(/Contents of/);
    fireEvent.change(textarea, { target: { value: "# Herd rules" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.writeDomainFile).toHaveBeenCalledWith("herd", "CLAUDE.md", "# Herd rules"));
    fireEvent.click(within(editor).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows API errors", async () => {
    mockApi.listDomains.mockRejectedValueOnce(new Error("offline"));
    render(<DomainsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  it("shows a failed update", async () => {
    mockApi.updateDomain.mockRejectedValue(new Error("bad toggle"));
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    fireEvent.click(within(herdCard()).getByRole("switch", { name: "Claude in Chrome" }));
    expect(await screen.findByText("bad toggle")).toBeInTheDocument();
  });

  // With Chrome on, a per-domain browser selector lists the connected browsers
  // (local/remote) and defaults to "Prefer local browser".
  it("shows the per-domain browser selector when Chrome is on and selects a browser", async () => {
    mockApi.listDomains.mockResolvedValue(chromeOnResponse());
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    const select = await herd.findByLabelText("Browser to drive");
    expect(select).toHaveValue("local");
    // Each connected browser is labelled name + platform + local/remote.
    expect(await herd.findByRole("option", { name: "Chrome (Linux) · local" })).toBeInTheDocument();
    expect(herd.getByRole("option", { name: "Safari-Chrome (macOS) · remote" })).toBeInTheDocument();
    await waitFor(() => expect(mockApi.listChromeBrowsers).toHaveBeenCalled());
    // Picking the Mac saves its deviceId (the VPS case: drive the remote Mac).
    fireEvent.change(select, { target: { value: "dev-mac" } });
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { chromeBrowser: "dev-mac" }));
  });

  it("keeps the selector usable when the browser list cannot be fetched", async () => {
    mockApi.listDomains.mockResolvedValue(chromeOnResponse());
    mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [], error: "Chrome is off" });
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    expect(await herd.findByRole("status")).toHaveTextContent("Chrome is off");
    // Prefer-local still available, plus a manual deviceId field.
    const select = herd.getByLabelText("Browser to drive");
    expect(select).toHaveValue("local");
    fireEvent.change(select, { target: { value: "__manual__" } });
    const manual = herd.getByLabelText("Browser deviceId");
    fireEvent.change(manual, { target: { value: "  typed-device  " } });
    fireEvent.keyDown(manual, { key: "Enter" });
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { chromeBrowser: "typed-device" }));
  });

  // A saved deviceId that is not in the fetched list shows up as an editable
  // manual value so the choice is never silently lost.
  it("surfaces a saved deviceId that is not in the list as a manual value", async () => {
    mockApi.listDomains.mockResolvedValue(chromeOnResponse("offline-device"));
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    expect(await herd.findByLabelText("Browser deviceId")).toHaveValue("offline-device");
  });

  // Plugins: one switch per installed plugin, saved as that domain's choice.
  it("turns a plugin on for one domain", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    fireEvent.click(within(herdCard()).getByRole("switch", { name: "Plugin hercle-brain" }));
    await waitFor(() => expect(mockApi.updateDomain).toHaveBeenCalledWith("herd", { plugins: { "hercle-brain@hercle-lab": true } }));
  });

  it("adds and removes MCP servers of a domain from its card", async () => {
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    fireEvent.click(herd.getByRole("button", { name: "Add server" }));
    fireEvent.change(herd.getByLabelText("Name"), { target: { value: "jarvis-brain" } });
    fireEvent.change(herd.getByLabelText("URL"), { target: { value: "http://100.116.99.9:7421/mcp" } });
    fireEvent.click(herd.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mockApi.setDomainMcpServer).toHaveBeenCalledWith("herd", "jarvis-brain", { url: "http://100.116.99.9:7421/mcp" }));
    fireEvent.click(herd.getByRole("button", { name: "Remove MCP server ping" }));
    await waitFor(() => expect(mockApi.removeDomainMcpServer).toHaveBeenCalledWith("herd", "ping"));
  });

  // The server's refusal is shown and the form keeps what was typed.
  it("shows why a server was refused and keeps the form open", async () => {
    mockApi.setDomainMcpServer.mockRejectedValue(new Error("The URL must start with http:// or https://"));
    render(<DomainsPage />);
    await screen.findByRole("article", { name: "Domain Herd" });
    const herd = within(herdCard());
    fireEvent.click(herd.getByRole("button", { name: "Add server" }));
    fireEvent.change(herd.getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(herd.getByLabelText("URL"), { target: { value: "ftp://x" } });
    fireEvent.click(herd.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("The URL must start with http:// or https://")).toBeInTheDocument();
    expect(herd.getByLabelText("URL")).toHaveValue("ftp://x");
  });

  // The account's MCP servers come from a cached `claude mcp list`: its age
  // is shown with a Refresh button, and a stale list is refreshed on open.
  it("shows when the account's servers were read and refreshes them on request", async () => {
    mockApi.listDomains.mockResolvedValue({ ...response(), accountMcp: { at: Date.now() - 5 * 60_000, stale: false } });
    render(<DomainsPage />);
    expect(await screen.findByText(/claude\.ai account: read 5 min ago/)).toBeInTheDocument();
    expect(mockApi.refreshAccountMcp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockApi.refreshAccountMcp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockApi.listDomains).toHaveBeenCalledTimes(2));
  });

  it("refreshes a stale list once when the page opens, and shows a read error", async () => {
    mockApi.listDomains.mockResolvedValue({ ...response(), accountMcp: { at: 0, stale: true, error: "claude mcp list failed: timed out" } });
    let finish!: (v: unknown) => void;
    mockApi.refreshAccountMcp.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<DomainsPage />);
    expect(await screen.findByText(/claude\.ai account: reading\.\.\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await act(async () => { finish({ at: 1, servers: 0 }); });
    await waitFor(() => expect(screen.getByText("claude mcp list failed: timed out")).toBeInTheDocument());
    expect(screen.getByText(/not read yet/)).toBeInTheDocument();
    // Still stale after the reload: not asked again (no loop).
    expect(mockApi.refreshAccountMcp).toHaveBeenCalledTimes(1);
  });
});
