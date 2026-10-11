// @vitest-environment jsdom
/**
 * The Domains page lists domains with their folder, sessions, memory, skills,
 * MCP servers and skill groups (on/off per domain), Claude in Chrome
 * (Claude Code only), edits CLAUDE.md / mcp.json, creates domains, and
 * removes one only when no session uses it (files stay on disk).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listDomains: vi.fn(),
  createDomain: vi.fn(),
  updateDomain: vi.fn(),
  deleteDomain: vi.fn(),
  readDomainFile: vi.fn(),
  writeDomainFile: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainsPage } from "./DomainsPage.js";

const base = { createdAt: 0, mcpDisabled: [], chrome: false, memoryNotes: 0, skills: [], mcpServers: [], skillGroupStates: {} };
const groups = [
  { id: "user", label: "Your skills", description: "In ~/.claude/skills", skills: ["foundry-poc"], codex: "linked" },
  { id: "claude-ai", label: "claude.ai skills", description: "Synced", skills: ["pdf", "docs"], codex: "unsupported" },
];
const response = () => ({
  root: "/home/u",
  skillGroups: groups,
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
});

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
});
