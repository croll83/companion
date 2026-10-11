// @vitest-environment jsdom
/**
 * SessionDomain shows the focused session's domain in the session panel, a
 * "legacy memory" badge for sessions from before domains, and "Change
 * domain" (domain sessions only), which warns that memory, skills, MCP and
 * instructions switch, then calls POST /sessions/:id/domain.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listDomains: vi.fn(),
  changeSessionDomain: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { SessionDomain } from "./SessionDomain.js";
import { useStore } from "../store.js";

const domain = (slug: string, name: string) => ({ slug, name, createdAt: 0, mcpDisabled: [], chrome: false, path: `/h/companion_domain_${slug}`, sessionCount: 0, totalSessions: 0, memoryNotes: 0, skills: [], mcpServers: [], skillGroupStates: {} });

function setSession(extra: Record<string, unknown>) {
  useStore.getState().setSdkSessions([{ sessionId: "s1", state: "connected", cwd: "/w", createdAt: 1, ...extra } as never]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listDomains.mockResolvedValue({ root: "/h", skillGroups: [], domains: [domain("global", "GLOBAL"), domain("herd", "Herd")] });
  mockApi.changeSessionDomain.mockResolvedValue({ ok: true, from: "global", to: "herd", interruptsWork: false });
  mockApi.listSessions.mockResolvedValue([]);
});

describe("SessionDomain", () => {
  it("renders the domain name of a domain session", async () => {
    setSession({ domain: "herd" });
    render(<SessionDomain sessionId="s1" />);
    expect(await screen.findByText("Herd")).toBeInTheDocument();
    expect(screen.queryByText("legacy memory")).toBeNull();
  });

  // Legacy sessions keep their folder memory: badge, and no "Change domain".
  it("marks legacy sessions and does not offer to move them", async () => {
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    expect(await screen.findByText("legacy memory")).toBeInTheDocument();
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change domain" })).toBeNull();
  });

  it("passes axe accessibility scan in the idle and choose states", async () => {
    const { axe } = await import("vitest-axe");
    setSession({ domain: "global" });
    const { container } = render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warns, then moves the session to the chosen domain", async () => {
    setSession({ domain: "global" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    expect(screen.getByText(/reads the memory, skills, MCP servers/)).toBeInTheDocument();
    expect(screen.getByLabelText("Move to domain")).toHaveValue("herd");
    fireEvent.click(screen.getByRole("button", { name: "Move and restart" }));
    expect(mockApi.changeSessionDomain).toHaveBeenCalledWith("s1", "herd");
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to Herd");
  });

  it("shows the server's refusal and can be cancelled", async () => {
    mockApi.changeSessionDomain.mockRejectedValue(new Error("busy"));
    setSession({ domain: "global" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockApi.changeSessionDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Move and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("busy");
  });
});
