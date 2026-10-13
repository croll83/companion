// @vitest-environment jsdom
/**
 * The sign-in chips of an OAuth brain, one per CLI. Validates the state
 * derived from the MCP status of active sessions in the domains using the
 * brain (Claude's needs-auth, Codex's notLoggedIn mapped to it; a plugin's
 * prefixed server name), that archived, exited, legacy (no domain) and
 * other-domain sessions are ignored, and the hint when a state is unknown.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../store.js";
import type { McpServerDetail, SdkSessionInfo } from "../types.js";
import { oauthBrain } from "../test-fixtures/brains.js";
import { BrainLoginChips, loginState } from "./BrainLoginChips.js";

function session(id: string, over: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return { sessionId: id, state: "connected", cwd: "/w", createdAt: 0, domain: "work", backendType: "claude", ...over };
}

function server(name: string, status: McpServerDetail["status"]): McpServerDetail {
  return { name, status, config: { type: "http" }, scope: "session" };
}

afterEach(() => useStore.setState({ sdkSessions: [], mcpServers: new Map() }));

describe("loginState", () => {
  const brain = oauthBrain();

  it("is signed in, needed or unknown per CLI", () => {
    const sessions = [session("c1"), session("x1", { backendType: "codex" })];
    const mcp = new Map([
      ["c1", [server("hercle-brain", "connected")]],
      ["x1", [server("hercle-brain", "needs-auth")]],
    ]);
    expect(loginState(brain, "claude", sessions, mcp)).toBe("signed-in");
    expect(loginState(brain, "codex", sessions, mcp)).toBe("needed");
    expect(loginState(brain, "codex", [], mcp)).toBe("unknown");
  });

  it("reads plugin-prefixed names and lets a waiting sign-in win", () => {
    const sessions = [session("c1"), session("c2")];
    const mcp = new Map([
      ["c1", [server("hercle-brain", "connected")]],
      ["c2", [server("plugin:companion-brain-hercle:hercle-brain", "needs-auth")]],
    ]);
    expect(loginState(brain, "claude", sessions, mcp)).toBe("needed");
  });

  it("ignores sessions that do not use the brain now", () => {
    const mcp = new Map<string, McpServerDetail[]>(["a", "b", "c", "d", "e"].map((id) => [id, [server("hercle-brain", "needs-auth")]]));
    const sessions = [
      session("a", { archived: true }),
      session("b", { state: "exited" }),
      session("c", { domain: undefined }),
      session("d", { domain: "other" }),
      session("e", { backendType: undefined, domain: "work" }),
    ];
    expect(loginState(brain, "claude", sessions.slice(0, 4), mcp)).toBe("unknown");
    // A session without backendType is a Claude session.
    expect(loginState(brain, "claude", sessions, mcp)).toBe("needed");
    expect(loginState(brain, "claude", [session("f")], new Map([["f", [server("other-brain", "needs-auth"), server("hercle-brain", "failed")]]]))).toBe("unknown");
  });
});

describe("BrainLoginChips", () => {
  it("renders both chips from the store, with the hint", () => {
    useStore.setState({ sdkSessions: [session("c1")], mcpServers: new Map([["c1", [server("hercle-brain", "connected")]]]) });
    render(<BrainLoginChips brain={oauthBrain()} />);
    const chips = screen.getByRole("list", { name: "Sign-in state" });
    expect(chips).toHaveTextContent("Claude Code: signed in");
    expect(chips).toHaveTextContent("Codex: unknown");
    expect(screen.getByText(/Open a session in/)).toHaveTextContent("Open a session in Work and sign in from its MCP panel");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainLoginChips brain={oauthBrain()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("hides the hint when both CLIs are signed in, and asks for a domain when there is none", () => {
    useStore.setState({
      sdkSessions: [session("c1"), session("x1", { backendType: "codex" })],
      mcpServers: new Map([["c1", [server("hercle-brain", "connected")]], ["x1", [server("hercle-brain", "connected")]]]),
    });
    const { unmount } = render(<BrainLoginChips brain={oauthBrain()} />);
    expect(screen.queryByText(/sign in from its MCP panel/)).toBeNull();
    unmount();
    render(<BrainLoginChips brain={oauthBrain({ domains: [] })} />);
    expect(screen.getByText(/Choose this brain in a domain/)).toBeInTheDocument();
  });
});
