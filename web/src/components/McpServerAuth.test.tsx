// @vitest-environment jsdom
/**
 * McpServerAuth is the sign-in of one OAuth MCP server in the session's MCP
 * panel (Claude Code and Codex): "Sign in" asks the CLI for the sign-in URL,
 * then a link to it and a field to paste the address the sign-in page ended
 * on (browser on another device). Errors offer "Try again".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockWs = vi.hoisted(() => ({ sendMcpAuthenticate: vi.fn(), sendMcpOAuthCallback: vi.fn() }));
vi.mock("../ws.js", () => mockWs);

import { McpServerAuth } from "./McpServerAuth.js";
import { useStore } from "../store.js";

const setAuth = (state: Parameters<ReturnType<typeof useStore.getState>["setMcpAuth"]>[2]) =>
  act(() => useStore.getState().setMcpAuth("s1", "brain", state));

beforeEach(() => {
  vi.clearAllMocks();
  useStore.getState().setMcpAuth("s1", "brain", null);
});

describe("McpServerAuth", () => {
  it("renders a Sign in button that starts the login", () => {
    render(<McpServerAuth sessionId="s1" serverName="brain" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mockWs.sendMcpAuthenticate).toHaveBeenCalledWith("s1", "brain");
  });

  it("passes axe accessibility scan with the sign-in link and paste field", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<McpServerAuth sessionId="s1" serverName="brain" />);
    setAuth({ authUrl: "https://login/authorize" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows progress while the CLI prepares the sign-in", () => {
    render(<McpServerAuth sessionId="s1" serverName="brain" />);
    setAuth({ pending: true });
    expect(screen.getByText("Starting the sign-in...")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("links to the sign-in page and sends a pasted address once", () => {
    render(<McpServerAuth sessionId="s1" serverName="brain" />);
    setAuth({ authUrl: "https://login/authorize" });
    const link = screen.getByRole("link", { name: "Open the sign-in page" });
    expect(link).toHaveAttribute("href", "https://login/authorize");
    expect(link).toHaveAttribute("target", "_blank");
    const finish = screen.getByRole("button", { name: "Finish" });
    expect(finish).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Address the sign-in page ended on"), { target: { value: " http://localhost:7498/callback?code=c " } });
    fireEvent.click(finish);
    expect(mockWs.sendMcpOAuthCallback).toHaveBeenCalledWith("s1", "brain", "http://localhost:7498/callback?code=c");
    // Sent: no double submission until the address changes.
    expect(screen.getByRole("button", { name: "Sent" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Address the sign-in page ended on"), { target: { value: "http://localhost:7498/callback?code=d" } });
    expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
  });

  it("does not send an empty address", () => {
    render(<McpServerAuth sessionId="s1" serverName="brain" />);
    setAuth({ authUrl: "https://login" });
    fireEvent.submit(screen.getByLabelText("Address the sign-in page ended on").closest("form")!);
    expect(mockWs.sendMcpOAuthCallback).not.toHaveBeenCalled();
  });

  it("shows an error and lets the user try again", () => {
    render(<McpServerAuth sessionId="s1" serverName="brain" />);
    setAuth({ error: "Paste the full address the sign-in page redirected to" });
    expect(screen.getByRole("alert")).toHaveTextContent("Paste the full address");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(useStore.getState().mcpAuth.get("s1")?.brain).toBeUndefined();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
