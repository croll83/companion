// @vitest-environment jsdom
/**
 * The MCP view of a domain: servers grouped by source (this domain, GLOBAL,
 * the Claude account, plugins read-only), each switched on/off for the
 * domain or reset to GLOBAL's choice; details show the live status of the
 * domain's open sessions, sign-in, removal (domain's own servers, with
 * confirmation) and the same switch for the other domains; servers can be
 * added to the domain or to GLOBAL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../ws.js", () => ({ sendMcpAuthenticate: vi.fn(), sendMcpOAuthCallback: vi.fn() }));

import { DomainMcpServers } from "./DomainMcpServers.js";
import { useStore } from "../store.js";
import { globalDomain, herdDomain, plugins } from "../test-fixtures/domains.js";
import type { DomainSummary } from "../api.js";

function setup(over: Partial<Parameters<typeof DomainMcpServers>[0]> = {}) {
  const props = {
    domain: herdDomain(),
    domains: [globalDomain(), herdDomain()],
    plugins,
    accountMcp: { at: Date.now() - 2 * 60_000, stale: false },
    refreshingAccount: false,
    onRefreshAccount: vi.fn(),
    busy: false,
    onSetMcp: vi.fn(),
    onAdd: vi.fn(async () => true),
    onRemove: vi.fn(async () => true),
    ...over,
  };
  render(<DomainMcpServers {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useStore.getState().setSdkSessions([]);
    useStore.getState().setMcpServers("s1", []);
  });
});

describe("DomainMcpServers", () => {
  it("groups servers by source with their state, and lists plugin servers read-only", () => {
    setup();
    const domainSec = screen.getByRole("region", { name: "This domain" });
    expect(within(domainSec).getByText("ping")).toBeInTheDocument();
    const global = screen.getByRole("region", { name: "From GLOBAL" });
    expect(within(global).getByText("Off in GLOBAL")).toBeInTheDocument();
    const account = screen.getByRole("region", { name: "Your Claude config and claude.ai" });
    expect(within(account).getByText(/Claude only/)).toBeInTheDocument();
    expect(within(account).getByText("Off here")).toBeInTheDocument();
    expect(within(account).getByText(/List read 2 min ago/)).toBeInTheDocument();
    expect(screen.getByText(/comes with the plugin hercle-brain/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan with a row open and the add form", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DomainMcpServers domain={herdDomain()} domains={[globalDomain(), herdDomain()]} plugins={plugins} refreshingAccount={false}
        onRefreshAccount={vi.fn()} busy={false} onSetMcp={vi.fn()} onAdd={vi.fn(async () => true)} onRemove={vi.fn(async () => true)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Details of ping" }));
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches a server for the domain and resets a choice to GLOBAL's", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("switch", { name: "MCP server noisy" }));
    expect(p.onSetMcp).toHaveBeenCalledWith("herd", "noisy", true);
    fireEvent.click(screen.getByRole("button", { name: "Reset github to GLOBAL's choice" }));
    expect(p.onSetMcp).toHaveBeenCalledWith("herd", "github", null);
  });

  it("shows GLOBAL's own labels (defaults for every domain)", () => {
    const own = globalDomain({ mcpServers: [
      { name: "a", source: "global", enabled: false, own: true, type: "stdio", target: "a" },
      { name: "b", source: "global", enabled: true, own: true, type: "stdio", target: "b" },
      { name: "c", source: "global", enabled: true, own: false, type: "stdio", target: "c" },
    ] });
    setup({ domain: own, domains: [own] });
    expect(screen.getByRole("region", { name: "GLOBAL's mcp.json" })).toBeInTheDocument();
    expect(screen.getByText("Off by default in every domain")).toBeInTheDocument();
    expect(screen.getByText("On by default")).toBeInTheDocument();
    expect(screen.getByText("On (default)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset a to the default" })).toBeInTheDocument();
  });

  it("opens the details: target, live status, other domains, and removal with confirmation", async () => {
    act(() => {
      useStore.getState().setSdkSessions([{ sessionId: "s1", state: "connected", cwd: "/w", createdAt: 1, domain: "herd" } as never]);
      useStore.getState().setMcpServers("s1", [
        { name: "ping", status: "connected", config: { type: "http" }, scope: "user" },
        { name: "plugin:hercle-brain:hercle-brain", status: "connected", config: { type: "http" }, scope: "user" },
      ]);
    });
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Details of ping" }));
    expect(screen.getByText("http://ping/mcp")).toBeInTheDocument();
    expect(screen.getByText(/Now: connected in 1 open session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove MCP server ping" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(p.onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove MCP server ping" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(p.onRemove).toHaveBeenCalledWith("herd", "ping"));

    // A GLOBAL server: the same switch for the other domains, no removal from here.
    fireEvent.click(screen.getByRole("button", { name: "Details of github" }));
    fireEvent.click(screen.getByRole("switch", { name: "github in GLOBAL" }));
    expect(p.onSetMcp).toHaveBeenCalledWith("global", "github", false);
    expect(screen.queryByRole("button", { name: "Remove MCP server github" })).toBeNull();
    expect(screen.getByText(/Not running in an open session/)).toBeInTheDocument();
  });

  it("offers sign-in through a connected session of the domain that waits for it, and links claude.ai connectors", () => {
    act(() => {
      useStore.getState().setSdkSessions([
        { sessionId: "s1", state: "connected", cwd: "/w", createdAt: 1, domain: "herd" } as never,
        { sessionId: "s2", state: "connected", cwd: "/w", createdAt: 1, domain: "other" } as never,
        { sessionId: "s3", state: "connected", cwd: "/w", createdAt: 1, domain: "herd", archived: true } as never,
      ]);
      useStore.getState().setMcpServers("s1", [{ name: "claude.ai Gmail", status: "needs-auth", config: { type: "http" }, scope: "user" }]);
      useStore.getState().setCliConnected("s1", true);
    });
    setup();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText(/One sign-in serves every session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details of claude.ai Gmail" }));
    expect(screen.getByRole("link", { name: "Manage this connector on claude.ai" })).toHaveAttribute("target", "_blank");
  });

  it("filters a long list, shows a broken mcp.json and refreshes the account list", () => {
    const many: DomainSummary = herdDomain({
      mcpError: "Invalid JSON in mcp.json",
      mcpServers: Array.from({ length: 9 }, (_, i) => ({ name: `srv-${i}`, source: "account" as const, enabled: true, own: false, type: "http", target: `https://s${i}` })),
    });
    const p = setup({ domain: many, accountMcp: { at: 0, stale: true, error: "claude mcp list failed: timed out" } });
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText("Invalid JSON in mcp.json")).toBeInTheDocument();
    expect(screen.getByText("claude mcp list failed: timed out")).toBeInTheDocument();
    expect(screen.getByText(/not read yet/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter MCP servers"), { target: { value: "srv-3" } });
    expect(screen.getByText("srv-3")).toBeInTheDocument();
    expect(screen.queryByText("srv-4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(p.onRefreshAccount).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  });

  it("shows a list being read", () => {
    setup({ refreshingAccount: true, accountMcp: { at: Date.now(), stale: false } });
    expect(screen.getByText(/being read/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("adds an HTTP server to the domain or to GLOBAL, closing the form only when saved", async () => {
    const onAdd = vi.fn(async () => false);
    setup({ onAdd });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " brain " } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: " http://h/mcp " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("herd", "brain", { url: "http://h/mcp" }));
    expect(screen.getByRole("form", { name: "Add MCP server" })).toBeInTheDocument();
    onAdd.mockResolvedValue(true);
    fireEvent.change(screen.getByLabelText("Add to"), { target: { value: "global" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdd).toHaveBeenLastCalledWith("global", "brain", { url: "http://h/mcp" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add MCP server" })).toBeNull());
  });

  it("adds a stdio server with arguments, ignores an incomplete form, and cancels", () => {
    const p = setup({ domain: globalDomain(), domains: [globalDomain()] });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(screen.queryByLabelText("Add to")).toBeNull();
    fireEvent.submit(screen.getByRole("form", { name: "Add MCP server" }));
    expect(p.onAdd).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "command" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "tool" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("Arguments (space separated)"), { target: { value: " -y  srv " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAdd).toHaveBeenCalledWith("global", "tool", { command: "npx", args: ["-y", "srv"] });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
});
