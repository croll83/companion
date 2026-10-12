// @vitest-environment jsdom
/**
 * DomainMcpServers is the MCP section of a domain's card: each server with
 * its on/off switch and what it connects to, "Remove" for the domain's own
 * servers, and a form to add one (a URL, or a command with arguments). The
 * form closes only when the server was saved.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainMcpServers } from "./DomainMcpServers.js";

const servers = [
  { name: "gh", source: "global" as const, enabled: false, type: "stdio", target: "gh-mcp" },
  { name: "noisy", source: "global" as const, enabled: false, disabledGlobally: true, type: "stdio", target: "n" },
  { name: "brain", source: "domain" as const, enabled: true, type: "http", target: "http://100.1.2.3:7421/mcp" },
];

function setup(over: Partial<Parameters<typeof DomainMcpServers>[0]> = {}) {
  const props = {
    servers,
    isGlobal: false,
    busy: false,
    onToggle: vi.fn(),
    onAdd: vi.fn(async () => true),
    onRemove: vi.fn(),
    ...over,
  };
  render(<DomainMcpServers {...props} />);
  return props;
}

describe("DomainMcpServers", () => {
  it("renders every server with its target, source and state", () => {
    setup();
    expect(screen.getByText(/http · http:\/\/100\.1\.2\.3:7421\/mcp/)).toBeInTheDocument();
    expect(screen.getByText(/stdio · gh-mcp · from GLOBAL/)).toBeInTheDocument();
    expect(screen.getByText("off in GLOBAL")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "MCP server noisy" })).toBeDisabled();
    // Only the domain's own servers can be removed from here.
    expect(screen.getByRole("button", { name: "Remove MCP server brain" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove MCP server gh" })).toBeNull();
  });

  it("passes axe accessibility scan with the add form open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DomainMcpServers servers={servers} isGlobal={false} busy={false} onToggle={vi.fn()} onAdd={vi.fn(async () => true)} onRemove={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("toggles and removes servers", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("switch", { name: "MCP server gh" }));
    expect(p.onToggle).toHaveBeenCalledWith("gh", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove MCP server brain" }));
    expect(p.onRemove).toHaveBeenCalledWith("brain");
  });

  it("adds an HTTP server and closes the form once saved", async () => {
    const p = setup({ servers: [] });
    expect(screen.getByText("None yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " jarvis-brain " } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: " http://100.116.99.9:7421/mcp " } });
    fireEvent.click(add);
    expect(p.onAdd).toHaveBeenCalledWith("jarvis-brain", { url: "http://100.116.99.9:7421/mcp" });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add MCP server" })).toBeNull());
  });

  it("adds a stdio server with its arguments", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "command" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "tool" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("Arguments (space separated)"), { target: { value: " -y  some-server " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(p.onAdd).toHaveBeenCalledWith("tool", { command: "npx", args: ["-y", "some-server"] });
  });

  // A refused server (bad name, bad URL) keeps what was typed so it can be fixed.
  it("keeps the form open when saving fails, and can be cancelled", async () => {
    const p = setup({ onAdd: vi.fn(async () => false) });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bad.name" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "http://x" } });
    fireEvent.submit(screen.getByRole("form", { name: "Add MCP server" }));
    await waitFor(() => expect(p.onAdd).toHaveBeenCalled());
    expect(screen.getByLabelText("Name")).toHaveValue("bad.name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add MCP server" })).toBeNull();
  });

  it("does not submit an incomplete form, and cannot add while mcp.json is broken", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.submit(screen.getByRole("form", { name: "Add MCP server" }));
    expect(p.onAdd).not.toHaveBeenCalled();
  });

  // Servers every Claude session loads by itself (user config, claude.ai
  // connectors): toggled per domain, marked Claude-only, never removable here.
  it("lists account servers as Claude-only, with their health when not connected, and no Remove", () => {
    const p = setup({ servers: [
      { name: "claude.ai Gmail", source: "account", enabled: true, type: "claude.ai", target: "https://gmail/mcp", health: "connected" },
      { name: "claude.ai Blockscout", source: "account", enabled: false, type: "claude.ai", target: "https://bs/mcp", health: "needs-auth" },
    ] });
    expect(screen.getByText(/claude\.ai · https:\/\/gmail\/mcp · Claude only$/)).toBeInTheDocument();
    expect(screen.getByText(/Claude only · needs-auth/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove MCP server/ })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "MCP server claude.ai Gmail" }));
    expect(p.onToggle).toHaveBeenCalledWith("claude.ai Gmail", false);
  });

  it("shows a broken mcp.json and disables adding", () => {
    setup({ error: "Invalid JSON in mcp.json" });
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid JSON");
    expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  });
});
