// @vitest-environment jsdom
/**
 * One brain: URLs and auth (never a token), health and "Test connection",
 * the domains using it (links to each), the collision banner with "Adopt
 * plugin as brain", the skill, editing and removal with confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainDetail, type BrainActions } from "./BrainDetail.js";
import { jarvisBrain, teamBrain } from "../test-fixtures/brains.js";
import type { BrainInfo, BrainTestResult } from "../api.js";

const okTest: BrainTestResult = {
  health: { reachable: true, pages: 80, version: "0.3.0", checkedAt: 0 },
  mcp: { ok: true, status: 200, serverName: "jarvis-brain", serverVersion: "0.3.0", protocolVersion: "2025-06-18", transport: "sse", hasInstructions: true, sessionClosed: false },
};

function actions(over: Partial<BrainActions> = {}): BrainActions {
  return {
    onUpdate: vi.fn(async () => true),
    onDelete: vi.fn(async () => true),
    onAdopt: vi.fn(async () => true),
    onTest: vi.fn(async () => okTest),
    onCheckHealth: vi.fn(),
    ...over,
  };
}

function setup(brain: BrainInfo = jarvisBrain(), opts: { desktop?: boolean; a?: BrainActions } = {}) {
  const a = opts.a ?? actions();
  render(<BrainDetail brain={brain} health={{ reachable: true, pages: 80, checkedAt: 0 }} desktop={opts.desktop ?? false} busy={false} actions={a} />);
  return a;
}

describe("BrainDetail", () => {
  it("renders the brain, its URLs and the domains using it (phone)", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Jarvis" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "‹ Brains" })).toHaveAttribute("href", "#/brains");
    expect(screen.getByText("http://100.116.99.9:7421/mcp")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Reachable · 80 pages")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GLOBAL · default for every domain" })).toHaveAttribute("href", "#/domains/global");
    expect(screen.getByRole("link", { name: "Herd (as in GLOBAL)" })).toHaveAttribute("href", "#/domains/herd");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <BrainDetail brain={jarvisBrain()} health="checking" desktop busy={false} actions={actions()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("tests the connection and shows the MCP answer", async () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("MCP: connected to jarvis-brain 0.3.0 (SSE, protocol 2025-06-18)");
    expect(screen.getByRole("status")).toHaveTextContent("The test session could not be closed.");
    expect(a.onTest).toHaveBeenCalledWith("jarvis");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(a.onCheckHealth).toHaveBeenCalledWith("jarvis");
  });

  it("shows a failed MCP test", async () => {
    const failing: BrainTestResult = { health: { reachable: false, error: "HTTP 503", checkedAt: 0 }, mcp: { ok: false, error: "HTTP 401: the brain refused the credentials" } };
    setup(teamBrain(), { a: actions({ onTest: vi.fn(async () => failing) }) });
    expect(screen.getByText("Bearer token (set)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent("MCP: HTTP 401: the brain refused the credentials");
    expect(screen.getByRole("status")).toHaveTextContent("Health: Unreachable: HTTP 503");
  });

  it("hides the result when the test request failed", async () => {
    setup(jarvisBrain({ collisions: [] }), { a: actions({ onTest: vi.fn(async () => null) }) });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  // jarvis-brain's plugin is on in Herd: the banner offers to adopt it.
  it("adopts a colliding plugin as the brain", () => {
    const a = setup();
    expect(screen.getByRole("alert")).toHaveTextContent("The plugin jarvis-brain serves the same MCP server and is on in herd");
    fireEvent.click(screen.getByRole("button", { name: "Adopt plugin as brain" }));
    expect(a.onAdopt).toHaveBeenCalledWith("jarvis", "jarvis-brain@jarvis-lab");
  });

  it("says a brain on no domain is off by default", () => {
    setup(teamBrain({ domains: [] }), { desktop: true });
    expect(screen.queryByRole("link", { name: "‹ Brains" })).toBeNull();
    expect(screen.getByText(/On no domain\. Brains are off by default/)).toBeInTheDocument();
  });

  it("edits the brain and saves its skill", async () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit brain" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Jarvis 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(a.onUpdate).toHaveBeenCalledWith("jarvis", expect.objectContaining({ name: "Jarvis 2" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit brain" })).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("Custom text"));
    fireEvent.change(screen.getByLabelText(/SKILL.md body/), { target: { value: "Body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect(a.onUpdate).toHaveBeenCalledWith("jarvis", { skill: { source: "custom", custom: "Body" } });
  });

  it("cancels an edit", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit brain" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Edit brain" })).toBeInTheDocument();
  });

  it("removes the brain after confirmation", () => {
    const a = setup(jarvisBrain({ collisions: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brain…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("2 domain(s) stop using it");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove brain…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brain" }));
    expect(a.onDelete).toHaveBeenCalledWith("jarvis");
  });
});
