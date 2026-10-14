// @vitest-environment jsdom
/**
 * One brain: URLs and auth (never a token), health and "Test connection",
 * the domains using it (links to each), the collision banner with "Adopt
 * plugin as brain", the skill, editing and removal with confirmation.
 * Embedded brains: the Overview / Pages / Inbox / Consolidation tabs (the
 * inbox count from health) and the wiki check; OAuth brains: the per-CLI
 * sign-in chips; remote brains: the consolidation agent link in the overview.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
// The Consolidation section (tab for embedded brains, overview for remote ones) loads its view: an empty one here.
const consolidationView = { config: { enabled: false, schedule: "0 5 * * *", mode: "local", backend: "claude", threshold: 10 }, agent: null, resolvedModel: "claude-sonnet-5-5", running: false, nextRunAt: null, runs: [], domain: "global" };
const mockApi = vi.hoisted(() => ({
  brainPages: vi.fn(), brainPage: vi.fn(), brainInbox: vi.fn(), brainLint: vi.fn(), fixBrainLint: vi.fn(),
  brainConsolidation: vi.fn(), listAgents: vi.fn(async () => []),
}));
mockApi.brainConsolidation.mockImplementation(async () => consolidationView);
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainDetail, type BrainActions } from "./BrainDetail.js";
import { embeddedBrain, jarvisBrain, oauthBrain, teamBrain } from "../test-fixtures/brains.js";
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
    onRefreshSkill: vi.fn(async () => true),
    onProcess: vi.fn(async () => true),
    onLoadLogs: vi.fn(async () => ["2026-10-13T10:00:00Z [supervisor] started pid 4242"]),
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

  // OAuth: the auth line names the client, a section explains the per-CLI
  // sign-in from a session's MCP panel and links to a domain using the brain,
  // and a 401 challenge is "sign-in required", not a failure.
  it("explains the OAuth sign-in and shows a sign-in-required test as reachable", async () => {
    const signIn: BrainTestResult = { health: { reachable: true, checkedAt: 0 }, mcp: { ok: false, status: 401, signInRequired: true } };
    const a = setup(oauthBrain(), { a: actions({ onTest: vi.fn(async () => signIn) }) });
    expect(screen.getByText("OAuth · client 11111111-2222-3333-4444-555555555555 · callback port 8765")).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Sign-in" });
    expect(section).toHaveTextContent("Sign in once per CLI");
    expect(section).toHaveTextContent("hercle-brain");
    expect(within(section).getByRole("link", { name: "Work" })).toHaveAttribute("href", "#/domains/work");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const status = await screen.findByText(/reachable, sign-in required/);
    expect(status).toHaveClass("text-cc-success");
    fireEvent.click(screen.getByRole("button", { name: "Refresh skill" }));
    expect(a.onRefreshSkill).toHaveBeenCalledWith("hercle");
  });

  it("asks to choose an OAuth brain in a domain before signing in", () => {
    setup(oauthBrain({ domains: [], remote: { baseUrl: "https://b", auth: { mode: "oauth", clientId: "app" } } }));
    expect(screen.getByText("OAuth · client app")).toBeInTheDocument();
    expect(screen.getByText(/Choose this brain in a domain first/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan for an OAuth brain", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainDetail brain={oauthBrain()} health={{ reachable: true, checkedAt: 0 }} desktop busy={false} actions={actions()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // An embedded brain: its folder instead of a health URL, the per-session
  // token as auth, the process section, its own edit form, and a removal
  // text that says the inbox goes and the wiki stays.
  it("shows an embedded brain with its process, edit form and removal text", async () => {
    const a = setup(embeddedBrain());
    // In the header and in the troubleshooting details.
    expect(screen.getAllByText("/home/me/wiki", { selector: "dd" })).toHaveLength(2);
    expect(screen.getByText("A token per session, minted by Companion")).toBeInTheDocument();
    expect(screen.queryByText("http://127.0.0.1:45999/healthz")).toBeNull();
    const proc = screen.getByRole("region", { name: "Brain process" });
    expect(proc).toHaveTextContent("Running");
    fireEvent.click(within(proc).getByRole("button", { name: "Restart" }));
    expect(a.onProcess).toHaveBeenCalledWith("work", "restart");
    fireEvent.click(within(proc).getByRole("button", { name: "Show log" }));
    expect(await within(proc).findByLabelText("Brain log")).toHaveTextContent("started pid 4242");
    expect(a.onLoadLogs).toHaveBeenCalledWith("work");

    fireEvent.click(screen.getByRole("button", { name: "Edit brain" }));
    expect(screen.getByRole("form", { name: "Edit brain Work" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Start with Companion"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(a.onUpdate).toHaveBeenCalledWith("work", { name: "Work", about: "Team wiki", language: "auto", redactSecrets: true, autostart: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit brain" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Remove brain…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("deletes its settings, inbox and log; the wiki folder is not touched");
  });

  it("passes axe accessibility scan for an embedded brain", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainDetail brain={embeddedBrain({ runtime: { state: "failed", crashes: 5, cause: "The wiki folder is missing.", action: "Restore it." } })} health={{ reachable: false, checkedAt: 0 }} desktop busy={false} actions={actions()} />);
    await screen.findByLabelText("Brain log");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches an embedded brain between Overview, Pages and Inbox", async () => {
    mockApi.brainPages.mockResolvedValue({ pages: [{ slug: "a", path: "concepts/a.md", title: "Alpha", type: "concept", tags: [], updated: null }] });
    mockApi.brainInbox.mockResolvedValue({ counts: { pending: 2 }, notes: [] });
    const a = actions();
    render(<BrainDetail brain={embeddedBrain()} health={{ reachable: true, pages: 1, inbox: { pending: 2 }, checkedAt: 0 }} desktop busy={false} actions={a} />);
    const tabs = screen.getByRole("tablist", { name: "Brain views" });
    expect(within(tabs).getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Wiki check" })).toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Pages" }));
    expect(await screen.findByRole("button", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Brain process" })).toBeNull();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Inbox (2)" }));
    expect(await screen.findByText("No notes waiting.")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "brain-tab-inbox");
    fireEvent.click(within(tabs).getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("region", { name: "Brain process" })).toBeInTheDocument();
    // A fix of the wiki check rechecks the brain's health (pages, inbox).
    mockApi.brainLint.mockResolvedValueOnce({ ok: false, errors: 1, warnings: 0, pages: 1, advice: [{ id: "log-missing", level: "warn", sentence: "There is no log.md.", paths: ["log.md"], count: 1, fix: { id: "create-log", label: "Create log.md" } }] });
    mockApi.fixBrainLint.mockResolvedValueOnce({ done: "log.md created", lint: { ok: true, errors: 0, warnings: 0, pages: 1, advice: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Check the wiki" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create log.md" }));
    await waitFor(() => expect(a.onCheckHealth).toHaveBeenCalledWith("work"));
  });

  it("passes axe accessibility scan for an embedded brain's tabs", async () => {
    mockApi.brainPages.mockResolvedValue({ pages: [] });
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainDetail brain={embeddedBrain()} health={{ reachable: true, checkedAt: 0 }} desktop busy={false} actions={actions()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Pages" }));
    await screen.findByText(/No pages yet/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no tabs for a remote brain, and shows the sign-in chips of an OAuth brain", () => {
    setup(oauthBrain());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("list", { name: "Sign-in state" })).toHaveTextContent("Claude Code: unknown");
    expect(screen.queryByRole("region", { name: "Wiki check" })).toBeNull();
  });

  // The Consolidation tab of an embedded brain gets the waiting count from health,
  // and a change there rechecks the brain (card and inbox counts).
  it("opens the Consolidation tab of an embedded brain", async () => {
    const a = actions();
    render(<BrainDetail brain={embeddedBrain()} health={{ reachable: true, pages: 1, inbox: { pending: 4 }, checkedAt: 0 }} desktop busy={false} actions={a} />);
    fireEvent.click(screen.getByRole("tab", { name: "Consolidation" }));
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "brain-tab-consolidation");
    expect(await screen.findByText(/4 notes waiting · never consolidated/)).toBeInTheDocument();
    expect(mockApi.brainConsolidation).toHaveBeenCalledWith("work");
  });

  // A remote brain is consolidated on its own server: linking an agent is for
  // the brain's owners only, so it sits in a closed "Advanced" section that
  // explains what such an agent needs (Marco, 2026-10-14).
  it("keeps the consolidation agent link of a remote brain under a closed Advanced section", async () => {
    setup(jarvisBrain({ collisions: [] }));
    const section = screen.getByRole("group", { name: "Consolidation agent" });
    expect(section).not.toHaveAttribute("open");
    expect(within(section).getByText(/brain owners only/)).toBeInTheDocument();
    expect(within(section).getByText(/right to\s+commit and push/)).toBeInTheDocument();
    fireEvent.click(within(section).getByText(/brain owners only/));
    expect(await within(section).findByRole("form", { name: "Link the consolidation agent" })).toBeInTheDocument();
  });
});
