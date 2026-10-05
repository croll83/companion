// @vitest-environment jsdom
/**
 * Tests for IntegrationsPage component.
 *
 * Validates:
 * - Linear Tickets card renders with live connection status
 * - Linear OAuth Apps card renders with connection/agent counts
 * - Back button navigation (home vs session)
 * - Back button hidden when embedded
 * - Settings button navigation for each card
 * - Accessibility
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
}

let mockState: MockStoreState;

const mockApi = {
  getSettings: vi.fn(),
  getLinearConnection: vi.fn(),
  listAgents: vi.fn(),
  listLinearOAuthConnections: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    getLinearConnection: (...args: unknown[]) => mockApi.getLinearConnection(...args),
    listAgents: (...args: unknown[]) => mockApi.listAgents(...args),
    listLinearOAuthConnections: (...args: unknown[]) => mockApi.listLinearOAuthConnections(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

const mockNavigateHome = vi.fn();
const mockNavigateToSession = vi.fn();
vi.mock("../utils/routing.js", () => ({
  navigateHome: (...args: unknown[]) => mockNavigateHome(...args),
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));

// Mock LinearLogo to avoid SVG import issues
vi.mock("./LinearLogo.js", () => ({
  LinearLogo: ({ className }: { className?: string }) => (
    <span data-testid="linear-logo" className={className} />
  ),
}));

import { IntegrationsPage } from "./IntegrationsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null };
  mockApi.getSettings.mockResolvedValue({
    anthropicApiKeyConfigured: false,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: true,
  });
  mockApi.getLinearConnection.mockResolvedValue({
    connected: true,
    viewerName: "Ada",
    viewerEmail: "ada@example.com",
    teamName: "Engineering",
    teamKey: "ENG",
  });
  mockApi.listAgents.mockResolvedValue([]);
  mockApi.listLinearOAuthConnections.mockResolvedValue({ connections: [] });
  window.location.hash = "#/integrations";
});

describe("IntegrationsPage", () => {
  // ─── Linear Tickets card ───────────────────────────────────────────────────

  it("shows Linear Tickets card with live status", async () => {
    // Verifies the Tickets card renders with workspace info and connected indicator
    render(<IntegrationsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("Linear Tickets");
    await screen.findByLabelText("Connected");
    expect(screen.getByText("Ada \u2022 Engineering")).toBeInTheDocument();
  });

  it("opens dedicated Linear Tickets settings page from card", async () => {
    // Verifies clicking the settings gear navigates to the tickets settings page
    render(<IntegrationsPage />);

    await screen.findByRole("button", { name: "Open Linear Tickets settings" });
    fireEvent.click(screen.getByRole("button", { name: "Open Linear Tickets settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/integrations/linear");
    });
  });

  // ─── Linear OAuth Apps card ────────────────────────────────────────────────

  it("shows Linear OAuth Apps card with no connections", async () => {
    // Verifies the OAuth card renders with empty state
    render(<IntegrationsPage />);

    await screen.findByText("Linear OAuth Apps");
    expect(screen.getByText("No OAuth apps configured")).toBeInTheDocument();
  });

  it("shows OAuth connection and agent counts", async () => {
    // Verifies the OAuth card displays counts when connections/agents exist
    mockApi.listLinearOAuthConnections.mockResolvedValue({
      connections: [
        { id: "c1", name: "App 1", status: "connected" },
        { id: "c2", name: "App 2", status: "disconnected" },
      ],
    });
    mockApi.listAgents.mockResolvedValue([
      { id: "a1", name: "Agent 1", triggers: { linear: { enabled: true } } },
    ]);

    render(<IntegrationsPage />);

    await screen.findByText("Linear OAuth Apps");
    // "2 apps, 1 connected · 1 agent"
    await waitFor(() => {
      expect(screen.getByText(/2 apps, 1 connected/)).toBeInTheDocument();
    });
  });

  it("navigates to OAuth settings page from card", async () => {
    // Verifies clicking the settings gear on OAuth card navigates correctly
    render(<IntegrationsPage />);

    await screen.findByRole("button", { name: "Open Linear OAuth settings" });
    fireEvent.click(screen.getByRole("button", { name: "Open Linear OAuth settings" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/integrations/linear-oauth");
    });
  });

  it("navigates to agent setup wizard from OAuth card", async () => {
    // Verifies clicking Setup Agent navigates to the wizard entry point
    render(<IntegrationsPage />);

    await screen.findByRole("button", { name: "Set up Linear Agent" });
    fireEvent.click(screen.getByRole("button", { name: "Set up Linear Agent" }));

    await waitFor(() => {
      expect(window.location.hash).toBe("#/agents?setup=linear");
    });
  });

  // ─── Back button ──────────────────────────────────────────────────────────

  it("renders Back button when not embedded and navigates home when no session", async () => {
    // No currentSessionId in state, so clicking Back should call navigateHome
    mockState = { currentSessionId: null };
    render(<IntegrationsPage />);

    await screen.findByText("Linear Tickets");

    const backBtn = screen.getByRole("button", { name: "Back" });
    expect(backBtn).toBeInTheDocument();

    fireEvent.click(backBtn);

    expect(mockNavigateHome).toHaveBeenCalledTimes(1);
    expect(mockNavigateToSession).not.toHaveBeenCalled();
  });

  it("Back button navigates to session when currentSessionId is set", async () => {
    // Store has an active session, so Back should navigate to that session
    mockState = { currentSessionId: "session-xyz" };
    render(<IntegrationsPage />);

    await screen.findByText("Linear Tickets");

    const backBtn = screen.getByRole("button", { name: "Back" });
    fireEvent.click(backBtn);

    expect(mockNavigateToSession).toHaveBeenCalledWith("session-xyz");
    expect(mockNavigateHome).not.toHaveBeenCalled();
  });

  it("does not render Back button when embedded", async () => {
    // When embedded=true the Back button should be absent
    render(<IntegrationsPage embedded />);

    await screen.findByText("Linear Tickets");

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  // ─── Linear-only page ──────────────────────────────────────────────────────

  it("lists only the Linear integrations (Tailscale was removed)", async () => {
    // The Tailscale Funnel integration was removed; the page must not render a
    // card or settings button for it, and must not call a status endpoint.
    render(<IntegrationsPage />);

    await screen.findByText("Linear Tickets");
    expect(screen.getByText("Linear OAuth Apps")).toBeInTheDocument();
    expect(screen.queryByText(/tailscale/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /tailscale/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<IntegrationsPage />);
    await screen.findByLabelText("Connected");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
