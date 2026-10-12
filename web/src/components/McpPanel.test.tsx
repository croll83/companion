// @vitest-environment jsdom
/**
 * Tests for the McpSection component (McpPanel.tsx): the MCP servers of one
 * session as its CLI sees them right now.
 *
 * A one-line summary ("3 connected · 1 need sign-in") that opens by itself
 * when a server failed or waits for a sign-in; rows with live status,
 * reconnect, details (config, error, tools), sign-in, and "turn off for this
 * session (until reload)". What every session of the domain gets is managed
 * on the Domains page ("Manage in domain"); the per-session "add server" form
 * was removed on purpose (Marco, 2026-10-13). It auto-fetches the status
 * when the CLI is connected.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { McpServerDetail } from "../types.js";

// ---- Mock WS functions ----
const mockSendMcpGetStatus = vi.fn();
const mockSendMcpToggle = vi.fn();
const mockSendMcpReconnect = vi.fn();
const mockSendMcpAuthenticate = vi.fn();

vi.mock("../ws.js", () => ({
  sendMcpGetStatus: (...args: unknown[]) => mockSendMcpGetStatus(...args),
  sendMcpToggle: (...args: unknown[]) => mockSendMcpToggle(...args),
  sendMcpReconnect: (...args: unknown[]) => mockSendMcpReconnect(...args),
  sendMcpAuthenticate: (...args: unknown[]) => mockSendMcpAuthenticate(...args),
  sendMcpOAuthCallback: vi.fn(),
}));

// ---- Mock Store ----
interface MockStoreState {
  mcpServers: Map<string, McpServerDetail[]>;
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { mcp_servers?: { name: string; status: string }[] }>;
  sdkSessions: { sessionId: string; domain?: string; legacyMemory?: boolean }[];
  mcpAuth: Map<string, Record<string, { pending?: boolean; authUrl?: string; error?: string }>>;
  setMcpAuth?: (...args: unknown[]) => void;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    mcpServers: new Map(),
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { mcp_servers: [] }]]),
    sdkSessions: [{ sessionId: "s1", domain: "herd" }],
    mcpAuth: new Map(),
    setMcpAuth: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(mockState),
    { getState: () => mockState },
  ),
}));

import { McpSection } from "./McpPanel.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

function makeServer(overrides: Partial<McpServerDetail> = {}): McpServerDetail {
  return {
    name: "test-server",
    status: "connected",
    config: { type: "stdio", command: "npx", args: ["-y", "mcp-server"] },
    scope: "project",
    tools: [],
    ...overrides,
  };
}

function withServers(servers: McpServerDetail[], extra: Partial<MockStoreState> = {}) {
  resetStore({ mcpServers: new Map([["s1", servers]]), ...extra });
}

/** Open the server list (closed by default while everything is fine). */
const expand = () => fireEvent.click(screen.getByRole("button", { name: /MCP Servers/ }));

describe("McpSection summary", () => {
  it("renders the heading and a summary of the servers, closed when all is fine", () => {
    withServers([makeServer({ name: "a" }), makeServer({ name: "b" }), makeServer({ name: "c", status: "disabled" })]);
    render(<McpSection sessionId="s1" />);
    const header = screen.getByRole("button", { name: /MCP Servers/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("2 connected · 1 off")).toBeInTheDocument();
    expect(screen.queryByText("a")).toBeNull();
    expand();
    expect(screen.getByText("a")).toBeInTheDocument();
  });

  it("passes axe accessibility scan, open", async () => {
    const { axe } = await import("vitest-axe");
    withServers([makeServer({ name: "a", status: "failed", error: "boom" }), makeServer({ name: "b", status: "needs-auth" })]);
    const { container } = render(<McpSection sessionId="s1" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("opens by itself when a server failed or needs a sign-in, and stays closed once closed", () => {
    withServers([makeServer({ name: "ok" }), makeServer({ name: "bad", status: "failed" }), makeServer({ name: "auth", status: "needs-auth" })]);
    const { rerender } = render(<McpSection sessionId="s1" />);
    expect(screen.getByRole("button", { name: /MCP Servers/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1 connected · 1 need sign-in · 1 failed")).toBeInTheDocument();
    expand();
    rerender(<McpSection sessionId="s1" />);
    expect(screen.getByRole("button", { name: /MCP Servers/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("links to the domain's MCP view, but not for a legacy session", () => {
    withServers([makeServer()]);
    const { unmount } = render(<McpSection sessionId="s1" />);
    expect(screen.getByRole("link", { name: "Manage in domain ›" })).toHaveAttribute("href", "#/domains/herd/mcp");
    unmount();
    withServers([makeServer()], { sdkSessions: [{ sessionId: "s1", legacyMemory: true }] });
    render(<McpSection sessionId="s1" />);
    expect(screen.queryByRole("link", { name: "Manage in domain ›" })).toBeNull();
  });

  it("links GLOBAL for a session without a domain slug", () => {
    withServers([makeServer()], { sdkSessions: [{ sessionId: "s1" }] });
    render(<McpSection sessionId="s1" />);
    expect(screen.getByRole("link", { name: "Manage in domain ›" })).toHaveAttribute("href", "#/domains/global/mcp");
  });

  it("shows an empty state, without any add form", () => {
    render(<McpSection sessionId="s1" />);
    expect(screen.getByText("No MCP servers in this session.")).toBeInTheDocument();
    expect(screen.queryByTitle("Add MCP server")).toBeNull();
  });
});

describe("McpSection status", () => {
  it("auto-fetches the status when the CLI is connected, not when it is disconnected", () => {
    const { unmount } = render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
    unmount();
    vi.clearAllMocks();
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);
    expect(mockSendMcpGetStatus).not.toHaveBeenCalled();
  });

  it("refreshes on request, and not while the CLI is disconnected", () => {
    const { unmount } = render(<McpSection sessionId="s1" />);
    mockSendMcpGetStatus.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh MCP server status" }));
    expect(mockSendMcpGetStatus).toHaveBeenCalledWith("s1");
    unmount();
    resetStore({ cliConnected: new Map([["s1", false]]) });
    render(<McpSection sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Refresh MCP server status" })).toBeDisabled();
  });

  it("falls back to the session's init list when detailed status is not available", () => {
    resetStore({ sessions: new Map([["s1", { mcp_servers: [{ name: "from-init", status: "connected" }] }]]) });
    render(<McpSection sessionId="s1" />);
    expand();
    expect(screen.getByText("from-init")).toBeInTheDocument();
  });

  it("renders the status badges", () => {
    withServers([
      makeServer({ name: "c" }),
      makeServer({ name: "f", status: "failed" }),
      makeServer({ name: "d", status: "disabled" }),
      makeServer({ name: "g", status: "connecting" }),
      makeServer({ name: "n", status: "needs-auth" }),
    ]);
    render(<McpSection sessionId="s1" />);
    for (const label of ["Connected", "Failed", "Disabled", "Connecting", "Sign-in needed"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("reconnects connected and failed servers only", () => {
    withServers([
      makeServer({ name: "c" }),
      makeServer({ name: "f", status: "failed" }),
      makeServer({ name: "d", status: "disabled" }),
      makeServer({ name: "g", status: "connecting" }),
    ]);
    render(<McpSection sessionId="s1" />);
    const reconnects = screen.getAllByTitle("Reconnect server");
    expect(reconnects).toHaveLength(2);
    fireEvent.click(reconnects[0]);
    expect(mockSendMcpReconnect).toHaveBeenCalledWith("s1", "c");
  });
});

describe("McpSection details", () => {
  it("shows config, URL, scope, error and tools when a server is opened", () => {
    withServers([
      makeServer({
        name: "web",
        status: "failed",
        config: { type: "http", url: "http://localhost:3000/mcp" },
        error: "Connection refused on port 3000",
        tools: [{ name: "read_file", annotations: { readOnly: true } }, { name: "write_file", annotations: { destructive: true } }],
      }),
      makeServer({ name: "cmd" }),
    ]);
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByText("web"));
    expect(screen.getByText("http://localhost:3000/mcp")).toBeInTheDocument();
    expect(screen.getByText("Connection refused on port 3000")).toBeInTheDocument();
    expect(screen.getByText("Tools (2)")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toHaveAttribute("title", "readOnly");
    fireEvent.click(screen.getByText("cmd"));
    expect(screen.getByText("npx -y mcp-server")).toBeInTheDocument();
  });

  it("turns a server off or on for this session only, until it reloads", () => {
    withServers([makeServer({ name: "on" }), makeServer({ name: "off", status: "disabled" })]);
    render(<McpSection sessionId="s1" />);
    expand();
    fireEvent.click(screen.getByText("on"));
    fireEvent.click(screen.getByRole("button", { name: "Turn off for this session (until reload)" }));
    expect(mockSendMcpToggle).toHaveBeenCalledWith("s1", "on", false);
    fireEvent.click(screen.getByText("off"));
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this session" }));
    expect(mockSendMcpToggle).toHaveBeenCalledWith("s1", "off", true);
  });
});

// OAuth servers waiting for a login (Claude reports "needs-auth"; Codex
// "notLoggedIn" is mapped to it) get a sign-in entry point in their row.
describe("McpSection sign-in", () => {
  it("shows the sign-in button for a server that needs a login, and starts the login", () => {
    withServers([makeServer({ name: "brain", status: "needs-auth", config: { type: "http", url: "https://b/mcp" } })]);
    render(<McpSection sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mockSendMcpAuthenticate).toHaveBeenCalledWith("s1", "brain");
  });

  it("keeps the login visible while it runs, even once the status changed", () => {
    withServers([makeServer({ name: "brain", status: "connecting" })], { mcpAuth: new Map([["s1", { brain: { authUrl: "https://login" } }]]) });
    render(<McpSection sessionId="s1" />);
    expand();
    expect(screen.getByRole("link", { name: "Open the sign-in page" })).toHaveAttribute("href", "https://login");
  });

  it("shows no sign-in for connected servers", () => {
    withServers([makeServer()]);
    render(<McpSection sessionId="s1" />);
    expand();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
