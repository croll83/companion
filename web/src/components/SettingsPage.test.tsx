// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// IntersectionObserver is not available in jsdom — provide a no-op mock
// so the scroll-tracking logic in SettingsPage doesn't crash during tests.
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}
(globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;

interface MockStoreState {
  darkMode: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  diffBase: string;
  publicUrl: string;
  updateInfo: {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    isServiceMode: boolean;
    updateInProgress: boolean;
    lastChecked: number;
  } | null;
  toggleDarkMode: ReturnType<typeof vi.fn>;
  toggleNotificationSound: ReturnType<typeof vi.fn>;
  setNotificationDesktop: ReturnType<typeof vi.fn>;
  setDiffBase: ReturnType<typeof vi.fn>;
  setPublicUrl: ReturnType<typeof vi.fn>;
  setTimeZone: ReturnType<typeof vi.fn>;
  setUpdateInfo: ReturnType<typeof vi.fn>;
  setUpdateOverlayActive: ReturnType<typeof vi.fn>;
  setEditorTabEnabled: ReturnType<typeof vi.fn>;
  currentSessionId?: string | null;
}

let mockState: MockStoreState;

function createMockState(overrides: Partial<MockStoreState> = {}): MockStoreState {
  return {
    darkMode: false,
    notificationSound: true,
    notificationDesktop: false,
    diffBase: "last-commit",
    publicUrl: "",
    updateInfo: null,
    toggleDarkMode: vi.fn(),
    toggleNotificationSound: vi.fn(),
    setNotificationDesktop: vi.fn(),
    setDiffBase: vi.fn(),
    setPublicUrl: vi.fn(),
    setTimeZone: vi.fn(),
    setUpdateInfo: vi.fn(),
    setUpdateOverlayActive: vi.fn(),
    setEditorTabEnabled: vi.fn(),
    ...overrides,
  };
}

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  forceCheckForUpdate: vi.fn(),
  triggerUpdate: vi.fn(),
  getAuthToken: vi.fn(),
  regenerateAuthToken: vi.fn(),
  getAuthQr: vi.fn(),
  verifyAnthropicKey: vi.fn(),
};

const mockTelemetry = {
  getTelemetryPreferenceEnabled: vi.fn(),
  setTelemetryPreferenceEnabled: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    forceCheckForUpdate: (...args: unknown[]) => mockApi.forceCheckForUpdate(...args),
    triggerUpdate: (...args: unknown[]) => mockApi.triggerUpdate(...args),
    getAuthToken: (...args: unknown[]) => mockApi.getAuthToken(...args),
    regenerateAuthToken: (...args: unknown[]) => mockApi.regenerateAuthToken(...args),
    getAuthQr: (...args: unknown[]) => mockApi.getAuthQr(...args),
    verifyAnthropicKey: (...args: unknown[]) => mockApi.verifyAnthropicKey(...args),
  },
}));

vi.mock("../analytics.js", () => ({
  getTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.getTelemetryPreferenceEnabled(...args),
  setTelemetryPreferenceEnabled: (...args: unknown[]) => mockTelemetry.setTelemetryPreferenceEnabled(...args),
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { SettingsPage } from "./SettingsPage.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createMockState();
  window.location.hash = "#/settings";
  mockApi.getSettings.mockResolvedValue({
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: false,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    updateChannel: "stable",
    publicUrl: "",
  });
  mockApi.updateSettings.mockResolvedValue({
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    linearApiKeyConfigured: false,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    updateChannel: "stable",
    publicUrl: "",
  });
  mockApi.forceCheckForUpdate.mockResolvedValue({
    currentVersion: "0.22.1",
    latestVersion: null,
    updateAvailable: false,
    isServiceMode: false,
    updateInProgress: false,
    lastChecked: Date.now(),
    channel: "stable",
  });
  mockApi.triggerUpdate.mockResolvedValue({
    ok: true,
    message: "Update started. Server will restart shortly.",
  });
  mockApi.getAuthToken.mockResolvedValue({ token: "abc123testtoken" });
  mockApi.regenerateAuthToken.mockResolvedValue({ token: "newtoken456" });
  mockApi.getAuthQr.mockResolvedValue({
    qrCodes: [
      { label: "LAN", url: "http://192.168.1.10:3456", qrDataUrl: "data:image/png;base64,LAN_QR" },
      { label: "Tailscale", url: "http://100.118.112.23:3456", qrDataUrl: "data:image/png;base64,TS_QR" },
    ],
  });
  mockTelemetry.getTelemetryPreferenceEnabled.mockReturnValue(true);
});

describe("SettingsPage", () => {
  it("loads settings on mount and shows configured status", async () => {
    render(<SettingsPage />);

    expect(mockApi.getSettings).toHaveBeenCalledTimes(1);
    await screen.findByText("Anthropic key configured");
    expect(screen.getByDisplayValue("claude-sonnet-4-6")).toBeInTheDocument();
  });

  // When a key is already configured, the input shows masked dots (••••) to
  // visually indicate a key is present. The dots clear on focus so the user
  // can type a replacement key.
  it("shows masked dots in API key field when key is configured", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const input = screen.getByLabelText("Anthropic API Key") as HTMLInputElement;
    expect(input.value).toBe("••••••••••••••••");

    // On focus the dots clear to allow entering a new key
    fireEvent.focus(input);
    expect(input.value).toBe("");
  });

  it("shows not configured status", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: false,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
    });

    render(<SettingsPage />);

    await screen.findByText("Anthropic key not configured");
  });

  it("shows the auto-renaming helper copy under the API key input", async () => {
    render(<SettingsPage />);

    expect(await screen.findByText("Auto-renaming is disabled until this key is configured.")).toBeInTheDocument();
  });

  it("saves settings with trimmed values", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "  or-key  " },
    });
    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "  openai/gpt-4o-mini  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicApiKey: "or-key",
        anthropicModel: "openai/gpt-4o-mini",
      });
    });

    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });

  it("falls back model to claude-sonnet-4-6 when blank", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "   " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicModel: "claude-sonnet-4-6",
      });
    });
  });

  it("does not send key when left empty", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic Model"), {
      target: { value: "openai/gpt-4o-mini" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        anthropicModel: "openai/gpt-4o-mini",
      });
    });
  });

  it("shows error if initial load fails", async () => {
    mockApi.getSettings.mockRejectedValueOnce(new Error("load failed"));

    render(<SettingsPage />);

    expect(await screen.findByText("load failed")).toBeInTheDocument();
  });

  it("shows error if save fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("save failed"));

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("save failed")).toBeInTheDocument();
  });

  it("navigates back when Back button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("");
  });

  it("hides Back button in embedded mode", async () => {
    render(<SettingsPage embedded />);
    await screen.findByText("Anthropic key configured");
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("shows saving state while request is in flight", async () => {
    let resolveSave: ((value: {
      anthropicApiKeyConfigured: boolean;
      anthropicModel: string;
      linearApiKeyConfigured: boolean;
      linearAutoTransition: boolean;
      linearAutoTransitionStateName: string;
    }) => void) | undefined;
    mockApi.updateSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve as typeof resolveSave;
      }),
    );

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "or-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Both the Anthropic "Save" and Webhooks "Save Public URL" buttons share the
    // `saving` state, so both show "Saving..." while the request is in flight.
    // We check that the submit-type button (Anthropic form) is disabled.
    const savingButtons = screen.getAllByRole("button", { name: "Saving..." });
    expect(savingButtons.length).toBeGreaterThanOrEqual(1);
    const submitSavingBtn = savingButtons.find((b) => b.getAttribute("type") === "submit");
    expect(submitSavingBtn).toBeDefined();
    expect(submitSavingBtn).toBeDisabled();

    resolveSave?.({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
    });

    await screen.findByText("Settings saved.");
  });

  it("toggles sound notifications from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Sound/i }));
    expect(mockState.toggleNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("toggles theme from settings", async () => {
    mockState = createMockState({ darkMode: true });
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Theme/i }));
    expect(mockState.toggleDarkMode).toHaveBeenCalledTimes(1);
  });

  it("toggles telemetry preference from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /Usage analytics and errors/i }));
    expect(mockTelemetry.setTelemetryPreferenceEnabled).toHaveBeenCalledWith(false);
  });

  it("navigates to environments page from settings", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Open Environments Page" }));
    expect(window.location.hash).toBe("#/environments");
  });

  it("requests desktop permission before enabling desktop alerts", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.click(screen.getByRole("button", { name: /Desktop Alerts/i }));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(true);
    });
    vi.unstubAllGlobals();
  });

  it("checks for updates from settings and stores update info", async () => {
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.22.1",
      latestVersion: "0.23.0",
      updateAvailable: true,
      isServiceMode: true,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalledTimes(1);
      expect(mockState.setUpdateInfo).toHaveBeenCalledWith(expect.objectContaining({
        latestVersion: "0.23.0",
        updateAvailable: true,
      }));
    });
    expect(await screen.findByText("Update v0.23.0 is available.")).toBeInTheDocument();
  });

  it("triggers app update from settings when service mode is enabled", async () => {
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.22.1",
        latestVersion: "0.23.0",
        updateAvailable: true,
        isServiceMode: true,
        updateInProgress: false,
        lastChecked: Date.now(),
      },
    });
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));

    await waitFor(() => {
      expect(mockApi.triggerUpdate).toHaveBeenCalledTimes(1);
    });
    expect(mockState.setUpdateOverlayActive).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Update started. Server will restart shortly.")).toBeInTheDocument();
  });

  // Verify left sidebar nav renders category labels for quick navigation
  it("renders category navigation with all section labels", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Each category appears in both desktop sidebar and mobile nav (jsdom renders both)
    const generalButtons = screen.getAllByRole("button", { name: "General" });
    expect(generalButtons.length).toBeGreaterThanOrEqual(1);

    const notifButtons = screen.getAllByRole("button", { name: "Notifications" });
    expect(notifButtons.length).toBeGreaterThanOrEqual(1);
  });

  // Verify section headings have correct IDs for anchor-based scrolling
  it("renders section headings with anchor IDs", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(document.getElementById("general")).toBeInTheDocument();
    expect(document.getElementById("webhooks")).toBeInTheDocument();
    expect(document.getElementById("authentication")).toBeInTheDocument();
    expect(document.getElementById("notifications")).toBeInTheDocument();
    expect(document.getElementById("anthropic")).toBeInTheDocument();
    expect(document.getElementById("updates")).toBeInTheDocument();
    expect(document.getElementById("telemetry")).toBeInTheDocument();
    expect(document.getElementById("environments")).toBeInTheDocument();
  });

  // ─── Authentication section tests ──────────────────────────────────

  // The auth section fetches the token on mount and displays it masked.
  it("fetches and displays the auth token masked by default", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Token should be fetched
    expect(mockApi.getAuthToken).toHaveBeenCalledTimes(1);

    // Token is masked by default — shows dots, not the actual value
    await waitFor(() => {
      expect(screen.getByText("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")).toBeInTheDocument();
    });
    expect(screen.queryByText("abc123testtoken")).not.toBeInTheDocument();
  });

  // Clicking "Show" reveals the actual token value.
  it("reveals the token when Show is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    await waitFor(() => {
      expect(screen.getByText("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle("Show token"));
    expect(screen.getByText("abc123testtoken")).toBeInTheDocument();
  });

  // Clicking "Show QR Code" loads and displays QR with address tabs.
  it("shows QR code with address tabs when button is clicked", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Show QR Code" }));

    await waitFor(() => {
      expect(mockApi.getAuthQr).toHaveBeenCalledTimes(1);
    });

    // First address (LAN) QR should be shown by default
    const img = await screen.findByAltText("QR code for LAN login");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/png;base64,LAN_QR");

    // Address tabs should be visible (LAN and Tailscale)
    expect(screen.getByRole("button", { name: "LAN" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tailscale" })).toBeInTheDocument();

    // Clicking Tailscale tab switches the QR code
    fireEvent.click(screen.getByRole("button", { name: "Tailscale" }));
    const tsImg = screen.getByAltText("QR code for Tailscale login");
    expect(tsImg).toHaveAttribute("src", "data:image/png;base64,TS_QR");
    expect(screen.getByText("http://100.118.112.23:3456")).toBeInTheDocument();
  });

  // Regenerating the token calls the API and reveals the new token.
  it("regenerates the token after user confirms", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));

    await waitFor(() => {
      expect(mockApi.regenerateAuthToken).toHaveBeenCalledTimes(1);
    });

    // New token is revealed automatically after regeneration
    expect(await screen.findByText("newtoken456")).toBeInTheDocument();

    (window.confirm as ReturnType<typeof vi.spyOn>).mockRestore();
  });

  // Cancelling the confirmation dialog skips regeneration entirely.
  it("does not regenerate when user cancels confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));

    expect(mockApi.regenerateAuthToken).not.toHaveBeenCalled();

    (window.confirm as ReturnType<typeof vi.spyOn>).mockRestore();
  });

  // The Authentication navigation item appears in the sidebar.
  it("includes Authentication in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const authButtons = screen.getAllByRole("button", { name: "Authentication" });
    expect(authButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Verify button tests ──────────────────────────────────

  // The Verify button is disabled when the API key input is empty.
  it("disables Verify button when anthropic key input is empty", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    expect(verifyBtn).toBeDisabled();
  });

  // The Verify button is enabled when the user types a new key.
  it("enables Verify button when user types a key", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    expect(verifyBtn).toBeEnabled();
  });

  // Clicking Verify calls verifyAnthropicKey and shows success state.
  it("shows success message when verify succeeds", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    expect(mockApi.verifyAnthropicKey).toHaveBeenCalledWith("sk-ant-test-key");
    await screen.findByText("API key is valid.");
  });

  // Clicking Verify shows error state when verification fails.
  it("shows error message when verify fails", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: false, error: "API returned 401" });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-bad-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    expect(mockApi.verifyAnthropicKey).toHaveBeenCalledWith("sk-ant-bad-key");
    await screen.findByText("Invalid API key: API returned 401");
  });

  // Verify result auto-dismisses after 5 seconds.
  it("auto-dismisses verify result after 5 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    await screen.findByText("API key is valid.");

    // Advance past the 5s auto-dismiss
    act(() => {
      vi.advanceTimersByTime(5100);
    });

    await waitFor(() => {
      expect(screen.queryByText("API key is valid.")).not.toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  // Verify result clears when the key input changes.
  it("clears verify result when key input changes", async () => {
    mockApi.verifyAnthropicKey.mockResolvedValueOnce({ valid: true });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const keyInput = screen.getByLabelText("Anthropic API Key");
    fireEvent.focus(keyInput);
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key" } });

    const verifyBtn = screen.getByRole("button", { name: "Verify" });
    fireEvent.click(verifyBtn);

    await screen.findByText("API key is valid.");

    // Changing the key should clear the verify result
    fireEvent.change(keyInput, { target: { value: "sk-ant-test-key-changed" } });

    await waitFor(() => {
      expect(screen.queryByText("API key is valid.")).not.toBeInTheDocument();
    });
  });

  // ─── AI Validation section tests ──────────────────────────────────

  // The AI Validation section renders with its heading and the toggle button
  // when an Anthropic key is configured (configured === true).
  it("renders AI Validation section with toggle when Anthropic key is configured", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Section heading should be present inside the #ai-validation section
    const section = document.getElementById("ai-validation");
    expect(section).toBeInTheDocument();

    // The main toggle button should be enabled (not disabled) when key is configured
    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).not.toBeDisabled();

    // It should show "Off" by default since aiValidationEnabled defaults to false
    expect(toggleBtn).toHaveTextContent("Off");
  });

  // When no Anthropic API key is configured, the AI Validation toggle should
  // be disabled and a warning message should appear.
  it("disables AI Validation toggle when Anthropic key is NOT configured", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: false,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key not configured");

    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    expect(toggleBtn).toBeDisabled();

    // Warning message should be shown
    expect(
      screen.getByText("Configure an Anthropic API key above to enable AI validation."),
    ).toBeInTheDocument();
  });

  // Clicking the AI Validation Mode toggle should call updateSettings with
  // aiValidationEnabled set to the opposite of its current value.
  it("calls updateSettings with aiValidationEnabled when toggle is clicked", async () => {
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByRole("button", { name: /AI Validation Mode/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationEnabled: true });
    });
  });

  // When AI Validation is enabled (and Anthropic key is configured), the
  // auto-approve and auto-deny sub-toggles should appear.
  it("shows auto-approve and auto-deny sub-toggles when AI Validation is enabled", async () => {
    // Return settings with aiValidationEnabled: true so sub-toggles render
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Sub-toggles should be visible
    expect(screen.getByRole("button", { name: /Auto-approve safe tools/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Auto-deny dangerous tools/i })).toBeInTheDocument();
  });

  // Sub-toggles should NOT appear when AI Validation is disabled.
  it("hides auto-approve and auto-deny sub-toggles when AI Validation is disabled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: false,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.queryByRole("button", { name: /Auto-approve safe tools/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Auto-deny dangerous tools/i })).not.toBeInTheDocument();
  });

  // Clicking the auto-approve toggle should call updateSettings with the
  // aiValidationAutoApprove field toggled to the opposite value.
  it("calls updateSettings with aiValidationAutoApprove when auto-approve is toggled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: false,
      aiValidationAutoDeny: true,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Auto-approve is currently "On" (true), clicking should toggle to false
    fireEvent.click(screen.getByRole("button", { name: /Auto-approve safe tools/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoApprove: false });
    });
  });

  // Clicking the auto-deny toggle should call updateSettings with the
  // aiValidationAutoDeny field toggled to the opposite value.
  it("calls updateSettings with aiValidationAutoDeny when auto-deny is toggled", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: true,
      updateChannel: "stable",
    });
    mockApi.updateSettings.mockResolvedValue({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      aiValidationEnabled: true,
      aiValidationAutoApprove: true,
      aiValidationAutoDeny: false,
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Auto-deny is currently "On" (true), clicking should toggle to false
    fireEvent.click(screen.getByRole("button", { name: /Auto-deny dangerous tools/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoDeny: false });
    });
  });

  // When the API call in toggleAiValidation fails, the UI should revert
  // the optimistic update back to the original value.
  it("reverts AI Validation toggle on API failure", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("network error"));

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const toggleBtn = screen.getByRole("button", { name: /AI Validation Mode/i });
    // Initially off
    expect(toggleBtn).toHaveTextContent("Off");

    // Click to enable — optimistic update sets it to "On"
    fireEvent.click(toggleBtn);

    // After the API rejects, the toggle should revert back to "Off"
    await waitFor(() => {
      expect(toggleBtn).toHaveTextContent("Off");
    });
  });

  // The AI Validation section includes its anchor ID for sidebar navigation.
  it("renders AI Validation section with anchor ID for navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(document.getElementById("ai-validation")).toBeInTheDocument();
  });

  // The AI Validation category appears in the sidebar navigation.
  it("includes AI Validation in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const aiValButtons = screen.getAllByRole("button", { name: "AI Validation" });
    expect(aiValButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Update Channel section tests ──────────────────────────────────

  // The update channel selector renders with Stable selected by default.
  it("renders update channel selector with Stable selected by default", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("Stable")).toBeInTheDocument();
    expect(screen.getByText("Prerelease")).toBeInTheDocument();
    expect(screen.getByText(/Tracking stable channel/)).toBeInTheDocument();
  });

  // When settings load with prerelease channel, it shows the prerelease description.
  it("shows prerelease description when channel is prerelease", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "prerelease",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText(/Tracking prerelease channel/)).toBeInTheDocument();
  });

  // Clicking Prerelease calls updateSettings and re-checks for updates.
  it("switches to prerelease channel and re-checks updates", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "prerelease",
    });
    mockApi.forceCheckForUpdate.mockResolvedValueOnce({
      currentVersion: "0.66.0",
      latestVersion: "0.67.0-preview.1",
      updateAvailable: true,
      isServiceMode: false,
      updateInProgress: false,
      lastChecked: Date.now(),
      channel: "prerelease",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByText("Prerelease"));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ updateChannel: "prerelease" });
    });
    await waitFor(() => {
      expect(mockApi.forceCheckForUpdate).toHaveBeenCalled();
    });
  });

  // Clicking Stable when already on stable is a no-op (doesn't call updateSettings).
  it("does not call updateSettings when clicking already-selected channel", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    fireEvent.click(screen.getByText("Stable"));

    // Should not have called updateSettings since stable is already selected
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  // ─── Webhooks section tests ──────────────────────────────────

  // The Webhooks category should appear in the sidebar navigation so users
  // can quickly jump to the webhook configuration section.
  it("includes Webhooks in category navigation", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // Each category appears in both desktop sidebar and mobile nav (jsdom renders both)
    const webhookButtons = screen.getAllByRole("button", { name: "Webhooks" });
    expect(webhookButtons.length).toBeGreaterThanOrEqual(1);
  });

  // The Public URL input should render inside the Webhooks section with the
  // correct type ("url") and an accessible label. When no publicUrl is set,
  // the fallback text should show the current window origin.
  it("renders Public URL input in Webhooks section with fallback text", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    // The section heading should be present
    expect(document.getElementById("webhooks")).toBeInTheDocument();

    // The input should be accessible via its aria-label
    const urlInput = screen.getByLabelText("Public URL") as HTMLInputElement;
    expect(urlInput).toBeInTheDocument();
    expect(urlInput.type).toBe("url");
    expect(urlInput.id).toBe("public-url");

    // When publicUrl is empty, the fallback text should show window.location.origin
    expect(screen.getByText(`Fallback: ${window.location.origin}`)).toBeInTheDocument();

    // The "Save Public URL" button should be present
    expect(screen.getByRole("button", { name: "Save Public URL" })).toBeInTheDocument();
  });

  // The Tailscale integration was removed, so the Webhooks tip must explain how
  // to get a public URL without linking to the deleted #/integrations/tailscale page.
  it("explains the Public URL without pointing to a Tailscale integration", async () => {
    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const webhooksSection = document.getElementById("webhooks")!;
    expect(webhooksSection).toHaveTextContent(/HTTPS reverse proxy or tunnel/);
    expect(webhooksSection).toHaveTextContent(/Linear OAuth callbacks and webhooks/);
    expect(webhooksSection).not.toHaveTextContent(/tailscale/i);
    expect(webhooksSection.querySelector('a[href="#/integrations/tailscale"]')).toBeNull();
  });

  // When a publicUrl is set (returned from getSettings), the status text should
  // show "Using: {url}" instead of the fallback origin.
  it("shows 'Using: {url}' status when publicUrl is set", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "https://my-companion.example.com",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    expect(screen.getByText("Using: https://my-companion.example.com")).toBeInTheDocument();
  });

  // Entering a URL and clicking "Save Public URL" should call api.updateSettings
  // with the trimmed publicUrl value and update the store via setPublicUrl.
  it("saves public URL via api.updateSettings when Save Public URL is clicked", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      linearApiKeyConfigured: false,
      linearAutoTransition: false,
      linearAutoTransitionStateName: "",
      updateChannel: "stable",
      publicUrl: "https://my-companion.example.com",
    });

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const urlInput = screen.getByLabelText("Public URL");
    fireEvent.change(urlInput, { target: { value: "  https://my-companion.example.com  " } });

    fireEvent.click(screen.getByRole("button", { name: "Save Public URL" }));

    // Should call updateSettings with trimmed publicUrl
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        publicUrl: "https://my-companion.example.com",
      });
    });

    // After save, the store's setPublicUrl should be called with the returned value
    await waitFor(() => {
      expect(mockState.setPublicUrl).toHaveBeenCalledWith("https://my-companion.example.com");
    });
  });

  // Axe accessibility scan for the Webhooks section to ensure it meets
  // WCAG standards (labels, roles, contrast, etc.).
  it("passes axe accessibility checks for the Webhooks section", async () => {
    const { axe } = await import("vitest-axe");

    render(<SettingsPage />);
    await screen.findByText("Anthropic key configured");

    const webhooksSection = document.getElementById("webhooks");
    expect(webhooksSection).toBeInTheDocument();

    const results = await axe(webhooksSection!);
    expect(results).toHaveNoViolations();
  });

  // --- Providers section tests ---

  // Verifies the Providers section renders and shows the correct configuration
  // status for Claude Code token and OpenAI API key based on server settings.
  it("renders Providers section with configured status from server", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token configured");
    expect(screen.getByText("OpenAI key not configured")).toBeInTheDocument();
  });

  // Verifies that the Claude Code token input shows masked dots when configured,
  // and clears on focus to allow entering a replacement token.
  it("shows masked dots in Claude Code token field when configured", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token configured");

    const input = screen.getByLabelText("Claude Code OAuth Token") as HTMLInputElement;
    expect(input.value).toBe("••••••••••••••••");

    fireEvent.focus(input);
    expect(input.value).toBe("");
  });

  // Verifies that provider settings are saved correctly via updateSettings API
  // and that the inputs are cleared after successful save.
  it("saves provider settings and clears inputs on success", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });
    mockApi.updateSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: true,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    // Wait for initial load to complete
    await screen.findByText("Claude Code token not configured");

    const claudeInput = screen.getByLabelText("Claude Code OAuth Token") as HTMLInputElement;
    const openaiInput = screen.getByLabelText("OpenAI API Key (Codex)") as HTMLInputElement;

    fireEvent.change(claudeInput, { target: { value: "test-oauth-token" } });
    fireEvent.change(openaiInput, { target: { value: "sk-test-key" } });

    const saveBtn = screen.getByRole("button", { name: "Save Provider Settings" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        claudeCodeOAuthToken: "test-oauth-token",
        openaiApiKey: "sk-test-key",
      });
    });

    // Inputs should be cleared after save – button is disabled again,
    // and masked-dot placeholders are restored since both tokens are now configured.
    await waitFor(() => {
      expect(screen.getByText("Provider settings saved.")).toBeInTheDocument();
      expect(saveBtn).toBeDisabled();
      expect(claudeInput.value).toBe("••••••••••••••••");
      expect(openaiInput.value).toBe("••••••••••••••••");
    });
  });

  // Verifies that the save button is disabled when both provider inputs are empty
  it("disables Save Provider Settings button when no inputs have values", async () => {
    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token not configured");

    const saveBtn = screen.getByRole("button", { name: "Save Provider Settings" });
    expect(saveBtn).toBeDisabled();
  });

  // Verifies that the Providers section passes accessibility checks
  it("passes axe accessibility checks for the Providers section", async () => {
    const { axe } = await import("vitest-axe");

    mockApi.getSettings.mockResolvedValueOnce({
      anthropicApiKeyConfigured: true,
      anthropicModel: "claude-sonnet-4-6",
      claudeCodeOAuthTokenConfigured: false,
      openaiApiKeyConfigured: false,
      updateChannel: "stable",
      publicUrl: "",
    });

    render(<SettingsPage />);
    await screen.findByText("Claude Code token not configured");

    const providersSection = document.getElementById("providers");
    expect(providersSection).toBeInTheDocument();

    const results = await axe(providersSection!);
    expect(results).toHaveNoViolations();
  });
});

// ─── Additional coverage: navigation, bridge mode, tokens, error paths ────────
describe("SettingsPage – extended behaviour", () => {
  const baseSettings = {
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    claudeCodeOAuthTokenConfigured: false,
    openaiApiKeyConfigured: false,
    telegramBotTokenConfigured: false,
    updateChannel: "stable",
    publicUrl: "",
  };

  async function renderLoaded(overrides: Record<string, unknown> = {}) {
    mockApi.getSettings.mockResolvedValueOnce({ ...baseSettings, ...overrides });
    const utils = render(<SettingsPage />);
    await screen.findByText(/Anthropic key (not )?configured/);
    return utils;
  }

  // The Back button returns to the active session when there is one, not home.
  it("navigates back to the current session when one is active", async () => {
    mockState = createMockState({ currentSessionId: "sess-42" });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.hash).toBe("#/session/sess-42");
  });

  // "Companion MCP tools for sessions" reflects the saved setting (on when
  // the server does not report it, as older servers do not).
  it("shows the Companion MCP tools switch with the saved value", async () => {
    await renderLoaded({ companionMcpEnabled: false });
    expect(screen.getByRole("switch", { name: /Companion MCP tools for sessions/ })).toHaveAttribute("aria-checked", "false");
  });

  it("shows the Companion MCP tools switch on by default", async () => {
    await renderLoaded();
    expect(screen.getByRole("switch", { name: /Companion MCP tools for sessions/ })).toHaveAttribute("aria-checked", "true");
  });

  // Clicking a category scrolls its section into view and highlights the nav item.
  it("scrolls to a section and marks it active when a nav item is clicked", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await renderLoaded();
    const navs = screen.getAllByRole("navigation", { name: "Settings categories" });
    // Both the mobile and the desktop nav drive the same handler.
    for (const nav of navs) {
      const btn = Array.from(nav.querySelectorAll("button")).find((b) => b.textContent === "Telemetry")!;
      fireEvent.click(btn);
      expect(btn.className).toContain("text-cc-primary");
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  // The IntersectionObserver callback picks the topmost intersecting section
  // and ignores non-intersecting entries.
  it("highlights the topmost visible section reported by the IntersectionObserver", async () => {
    let captured: IntersectionObserverCallback | null = null;
    const Original = (globalThis as Record<string, unknown>).IntersectionObserver;
    class CapturingObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(cb: IntersectionObserverCallback) { captured = cb; }
    }
    (globalThis as Record<string, unknown>).IntersectionObserver = CapturingObserver;
    try {
      await renderLoaded();
      expect(captured).not.toBeNull();
      const entry = (id: string, top: number, isIntersecting = true) =>
        ({ isIntersecting, target: document.getElementById(id), boundingClientRect: { top } }) as unknown as IntersectionObserverEntry;
      act(() => {
        captured!([
          entry("updates", 300),
          entry("providers", 50),
          entry("general", -500, false),
        ], {} as IntersectionObserver);
      });
      const desktopNav = screen.getAllByRole("navigation", { name: "Settings categories" })[1];
      const providersBtn = Array.from(desktopNav.querySelectorAll("button")).find((b) => b.textContent === "Providers")!;
      const generalBtn = Array.from(desktopNav.querySelectorAll("button")).find((b) => b.textContent === "General")!;
      expect(providersBtn.className).toContain("text-cc-primary");
      expect(generalBtn.className).not.toContain("text-cc-primary");

      // No intersecting entries → active section unchanged.
      act(() => { captured!([entry("updates", 0, false)], {} as IntersectionObserver); });
      expect(providersBtn.className).toContain("text-cc-primary");
    } finally {
      (globalThis as Record<string, unknown>).IntersectionObserver = Original;
    }
  });

  it("toggles the diff base between last commit and default branch", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /Diff compare against/ }));
    expect(mockState.setDiffBase).toHaveBeenCalledWith("default-branch");
  });

  it("toggles the diff base back to last commit from default branch", async () => {
    mockState = createMockState({ diffBase: "default-branch" });
    await renderLoaded();
    expect(screen.getByText("Default branch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Diff compare against/ }));
    expect(mockState.setDiffBase).toHaveBeenCalledWith("last-commit");
  });

  // ─── CLI bridge mode ───────────────────────────────────────────────

  // A server-provided bridge mode is reflected in the select on load.
  it("loads the CLI bridge mode from settings", async () => {
    await renderLoaded({ cliBridgeMode: "tlsLoopback" });
    expect((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).value).toBe("tlsLoopback");
  });

  it.each(["stdio", "jsonHandoff", "tlsLoopback", "loopback"] as const)(
    "persists bridge mode %s when selected",
    async (mode) => {
      await renderLoaded({ cliBridgeMode: mode === "loopback" ? "stdio" : "loopback" });
      fireEvent.change(screen.getByLabelText("CLI bridge mode"), { target: { value: mode } });
      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ cliBridgeMode: mode }));
      expect((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).value).toBe(mode);
    },
  );

  // A failed save rolls the select back to the previous mode.
  it("reverts the bridge mode when saving fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("nope"));
    await renderLoaded({ cliBridgeMode: "jsonHandoff" });
    const select = screen.getByLabelText("CLI bridge mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "stdio" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(select.value).toBe("jsonHandoff"));
  });

  // Regression: the load path only accepted loopback/jsonHandoff/tlsLoopback,
  // so a server that had "stdio" saved rendered the select as "loopback" —
  // reopening Settings looked like the choice had reverted.
  it("loads a saved stdio bridge mode into the select", async () => {
    await renderLoaded({ cliBridgeMode: "stdio" });
    expect((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).value).toBe("stdio");
  });

  // End-to-end from the UI's perspective: choosing "Stdio (recommended)" sends
  // exactly {cliBridgeMode:"stdio"} as the saved payload, the server's echo is
  // applied, and a fresh mount (reopening Settings) shows stdio again.
  it("saves stdio as the payload and still shows it after reopening Settings", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, cliBridgeMode: "stdio" });
    const { unmount } = await renderLoaded({ cliBridgeMode: "loopback" });
    fireEvent.change(screen.getByLabelText("CLI bridge mode"), { target: { value: "stdio" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledTimes(1));
    expect(mockApi.updateSettings.mock.calls[0][0]).toEqual({ cliBridgeMode: "stdio" });
    expect((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).value).toBe("stdio");
    unmount();

    await renderLoaded({ cliBridgeMode: "stdio" });
    expect((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).value).toBe("stdio");
  });

  // If the server stores something other than what was picked, the select
  // follows the server's echo instead of keeping the optimistic value.
  it("follows the bridge mode echoed back by the server", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, cliBridgeMode: "tlsLoopback" });
    await renderLoaded({ cliBridgeMode: "loopback" });
    const select = screen.getByLabelText("CLI bridge mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "stdio" } });
    await waitFor(() => expect(select.value).toBe("tlsLoopback"));
  });

  // A rejected save (e.g. the old 400 "cliBridgeMode must be ...") rolls the
  // select back AND surfaces the server message in an alert, so the revert is
  // no longer silent. The alert is cleared on the next successful change.
  it("shows the server error when the bridge mode is rejected, then clears it", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("cliBridgeMode must be one of: 'loopback'"));
    await renderLoaded({ cliBridgeMode: "loopback" });
    const select = screen.getByLabelText("CLI bridge mode") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "stdio" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("cliBridgeMode must be one of: 'loopback'");
    expect(select.value).toBe("loopback");

    fireEvent.change(select, { target: { value: "jsonHandoff" } });
    await waitFor(() => expect(screen.queryByText(/cliBridgeMode must be one of/)).not.toBeInTheDocument());
    expect(select.value).toBe("jsonHandoff");
  });

  // Non-Error rejections are stringified rather than dropped.
  it("stringifies a non-Error bridge mode rejection", async () => {
    mockApi.updateSettings.mockRejectedValueOnce("offline");
    await renderLoaded({ cliBridgeMode: "loopback" });
    fireEvent.change(screen.getByLabelText("CLI bridge mode"), { target: { value: "stdio" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });

  // Race guard: two quick changes whose responses arrive out of order. The
  // older save (stdio) resolving AFTER the newer one (jsonHandoff) must not
  // overwrite the select — the last choice/write wins.
  it("ignores a stale bridge mode response that resolves after a newer one", async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    mockApi.updateSettings
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
    await renderLoaded({ cliBridgeMode: "loopback" });
    const select = screen.getByLabelText("CLI bridge mode") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "stdio" } });
    fireEvent.change(select, { target: { value: "jsonHandoff" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledTimes(2));

    await act(async () => { resolveB({ ...baseSettings, cliBridgeMode: "jsonHandoff" }); });
    await act(async () => { resolveA({ ...baseSettings, cliBridgeMode: "stdio" }); });
    expect(select.value).toBe("jsonHandoff");
  });

  // Same race on the failure path: a stale save that rejects after a newer
  // one succeeded must neither roll the select back nor show an error.
  it("ignores a stale bridge mode rejection that arrives after a newer save", async () => {
    let rejectA!: (e: unknown) => void;
    let resolveB!: (v: unknown) => void;
    mockApi.updateSettings
      .mockImplementationOnce(() => new Promise((_r, j) => { rejectA = j; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
    await renderLoaded({ cliBridgeMode: "loopback" });
    const select = screen.getByLabelText("CLI bridge mode") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "stdio" } });
    fireEvent.change(select, { target: { value: "jsonHandoff" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledTimes(2));

    await act(async () => { resolveB({ ...baseSettings, cliBridgeMode: "jsonHandoff" }); });
    await act(async () => { rejectA(new Error("stale failure")); });
    expect(select.value).toBe("jsonHandoff");
    expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
  });

  // The select offers exactly one option per mode, stdio (recommended) first.
  it("renders one option per bridge mode with stdio first", async () => {
    await renderLoaded();
    const options = Array.from((screen.getByLabelText("CLI bridge mode") as HTMLSelectElement).options);
    expect(options.map((o) => o.value)).toEqual(["stdio", "tlsLoopback", "loopback", "jsonHandoff"]);
    expect(options[0].textContent).toMatch(/recommended/);
  });

  // Accessibility: the bridge-mode block (select + error alert) has no axe
  // violations. Scoped to that block rather than the whole General section,
  // whose ~400-option time zone list makes axe slow (covered separately).
  it("has no accessibility violations with a bridge mode error shown", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("nope"));
    await renderLoaded({ cliBridgeMode: "loopback" });
    fireEvent.change(screen.getByLabelText("CLI bridge mode"), { target: { value: "stdio" } });
    const alert = await screen.findByRole("alert");
    const { axe } = await import("vitest-axe");
    expect(await axe(alert.parentElement!)).toHaveNoViolations();
  });

  // ─── Webhooks / public URL ─────────────────────────────────────────

  it("shows the server error when saving the public URL fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("bad url"));
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Public URL"), { target: { value: "https://x.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Public URL" }));
    expect(await screen.findByText("bad url")).toBeInTheDocument();
    expect(mockState.setPublicUrl).not.toHaveBeenCalledWith("https://x.example");
  });

  // The "Saved!" confirmation on the public URL button clears itself.
  it("clears the public URL saved confirmation after a delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, publicUrl: "https://x.example" });
      await renderLoaded();
      fireEvent.change(screen.getByLabelText("Public URL"), { target: { value: "https://x.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Public URL" }));
      expect(await screen.findByRole("button", { name: "Saved!" })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1900); });
      expect(screen.getByRole("button", { name: "Save Public URL" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Authentication ────────────────────────────────────────────────

  it("copies the auth token to the clipboard and shows a transient confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderLoaded();
      const copyBtn = screen.getByTitle("Copy token to clipboard");
      await waitFor(() => expect(copyBtn).not.toBeDisabled());
      fireEvent.click(copyBtn);
      expect(writeText).toHaveBeenCalledWith("abc123testtoken");
      expect(await screen.findByText("Copied")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1600); });
      expect(screen.getByTitle("Copy token to clipboard").textContent).toBe("Copy");
    } finally {
      vi.useRealTimers();
    }
  });

  // The QR picker switches the displayed QR/URL when another address tab is chosen.
  it("switches between QR address tabs", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Show QR Code" }));
    await screen.findByAltText("QR code for LAN login");
    fireEvent.click(screen.getByRole("button", { name: "Tailscale" }));
    expect(screen.getByAltText("QR code for Tailscale login")).toHaveAttribute("src", "data:image/png;base64,TS_QR");
    expect(screen.getByText("http://100.118.112.23:3456")).toBeInTheDocument();
  });

  it("explains when no remote addresses are available for a QR code", async () => {
    mockApi.getAuthQr.mockResolvedValueOnce({ qrCodes: [] });
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Show QR Code" }));
    expect(await screen.findByText(/No remote addresses detected/)).toBeInTheDocument();
  });

  // A failing QR request leaves the button available so the user can retry.
  it("keeps the Show QR Code button after a QR generation failure", async () => {
    mockApi.getAuthQr.mockRejectedValueOnce(new Error("qr fail"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Show QR Code" }));
    await waitFor(() => expect(mockApi.getAuthQr).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Show QR Code" })).not.toBeDisabled();
  });

  it("keeps the old token when regeneration fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockApi.regenerateAuthToken.mockRejectedValueOnce(new Error("regen fail"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate Token" }));
    await waitFor(() => expect(mockApi.regenerateAuthToken).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Regenerate Token" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("abc123testtoken")).toBeInTheDocument();
  });

  // ─── Notifications ─────────────────────────────────────────────────

  // Denied permission must not flip desktop alerts on.
  it("does not enable desktop alerts when permission is denied", async () => {
    const requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    try {
      await renderLoaded();
      fireEvent.click(screen.getByRole("button", { name: /Desktop Alerts/i }));
      await waitFor(() => expect(requestPermission).toHaveBeenCalled());
      expect(mockState.setNotificationDesktop).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("disables desktop alerts without prompting when they are on", async () => {
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", { permission: "granted", requestPermission });
    mockState = createMockState({ notificationDesktop: true });
    try {
      await renderLoaded();
      fireEvent.click(screen.getByRole("button", { name: /Desktop Alerts/i }));
      await waitFor(() => expect(mockState.setNotificationDesktop).toHaveBeenCalledWith(false));
      expect(requestPermission).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ─── Providers ─────────────────────────────────────────────────────

  // Masked dots return on blur when nothing was typed, for every secret field.
  it("restores masked placeholders on blur for configured secrets", async () => {
    await renderLoaded({
      claudeCodeOAuthTokenConfigured: true,
      openaiApiKeyConfigured: true,
      telegramBotTokenConfigured: true,
    });
    for (const label of ["Claude Code OAuth Token", "OpenAI API Key (Codex)", "Telegram Bot Token", "Anthropic API Key"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.value).toBe("••••••••••••••••");
      fireEvent.focus(input);
      expect(input.value).toBe("");
      fireEvent.blur(input);
      expect(input.value).toBe("••••••••••••••••");
    }
  });

  it("saves only the OpenAI key when just that field is filled", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, openaiApiKeyConfigured: true });
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("OpenAI API Key (Codex)"), { target: { value: " sk-x " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider Settings" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ openaiApiKey: "sk-x" }));
    expect(await screen.findByText("OpenAI key configured")).toBeInTheDocument();
  });

  it("shows provider save errors and clears the success banner after a delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi.updateSettings
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce({ ...baseSettings, claudeCodeOAuthTokenConfigured: true });
      await renderLoaded();
      fireEvent.change(screen.getByLabelText("Claude Code OAuth Token"), { target: { value: "tok" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Provider Settings" }));
      expect(await screen.findByText("provider down")).toBeInTheDocument();

      // Retry succeeds: the error disappears and the banner auto-dismisses.
      fireEvent.click(screen.getByRole("button", { name: "Save Provider Settings" }));
      expect(await screen.findByText("Provider settings saved.")).toBeInTheDocument();
      expect(screen.queryByText("provider down")).not.toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1900); });
      expect(screen.queryByText("Provider settings saved.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Telegram bot token ────────────────────────────────────────────

  it("saves a trimmed Telegram bot token and confirms briefly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, telegramBotTokenConfigured: true });
      await renderLoaded();
      const saveBtn = screen.getByRole("button", { name: "Save Telegram token" });
      expect(saveBtn).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Telegram Bot Token"), { target: { value: "  123:ABC  " } });
      expect(saveBtn).not.toBeDisabled();
      fireEvent.click(saveBtn);
      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ telegramBotToken: "123:ABC" }));
      expect(await screen.findByText("Telegram bot token saved.")).toBeInTheDocument();
      expect(screen.getByText("Bot token configured")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1900); });
      expect(screen.queryByText("Telegram bot token saved.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an error when saving the Telegram token fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("invalid bot token"));
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Telegram Bot Token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Telegram token" }));
    expect(await screen.findByText("invalid bot token")).toBeInTheDocument();
    expect(screen.getByText("Bot token not configured")).toBeInTheDocument();
  });

  // Remove sends an empty token, which the server treats as "unset".
  it("removes a configured Telegram token", async () => {
    mockApi.updateSettings.mockResolvedValueOnce({ ...baseSettings, telegramBotTokenConfigured: false });
    await renderLoaded({ telegramBotTokenConfigured: true });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ telegramBotToken: "" }));
    expect(await screen.findByText("Bot token not configured")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("keeps the Telegram token configured and shows the error when removal fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce("server exploded");
    await renderLoaded({ telegramBotTokenConfigured: true });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("server exploded")).toBeInTheDocument();
    expect(screen.getByText("Bot token configured")).toBeInTheDocument();
  });

  // ─── Anthropic verify ──────────────────────────────────────────────

  // A thrown verify request (network error) is reported as an invalid key.
  it("reports a verify request failure as an invalid key", async () => {
    mockApi.verifyAnthropicKey.mockRejectedValueOnce(new Error("network down"));
    await renderLoaded();
    fireEvent.change(screen.getByLabelText("Anthropic API Key"), { target: { value: "sk-ant-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Invalid API key: network down")).toBeInTheDocument();
  });

  // ─── AI validation reverts ─────────────────────────────────────────

  it("reverts auto-approve and auto-deny toggles when saving fails", async () => {
    await renderLoaded({ aiValidationEnabled: true, aiValidationAutoApprove: true, aiValidationAutoDeny: false });
    mockApi.updateSettings.mockRejectedValue(new Error("fail"));

    const approve = screen.getByRole("button", { name: /Auto-approve safe tools/ });
    fireEvent.click(approve);
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoApprove: false }));
    await waitFor(() => expect(approve).toHaveTextContent(/On$/));

    const deny = screen.getByRole("button", { name: /Auto-deny dangerous tools/ });
    fireEvent.click(deny);
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ aiValidationAutoDeny: true }));
    await waitFor(() => expect(deny).toHaveTextContent(/Off$/));
  });

  // ─── Updates ───────────────────────────────────────────────────────

  it("reports up-to-date when no newer version is available", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You are up to date.")).toBeInTheDocument();
  });

  it("shows the error when checking for updates fails", async () => {
    mockApi.forceCheckForUpdate.mockRejectedValueOnce(new Error("github unreachable"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("github unreachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
  });

  // A failed update must show the error and re-enable the button.
  it("shows the error and re-enables the button when the update fails", async () => {
    mockState = createMockState({
      updateInfo: {
        currentVersion: "0.22.1",
        latestVersion: "0.23.0",
        updateAvailable: true,
        isServiceMode: true,
        updateInProgress: false,
        lastChecked: Date.now(),
      },
    });
    mockApi.triggerUpdate.mockRejectedValueOnce(new Error("update failed"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Update & Restart" }));
    expect(await screen.findByText("update failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update & Restart" })).not.toBeDisabled();
    expect(mockState.setUpdateOverlayActive).not.toHaveBeenCalled();
  });

  it("switches back to the stable channel and refreshes update info", async () => {
    await renderLoaded({ updateChannel: "prerelease" });
    fireEvent.click(screen.getByRole("radio", { name: "Stable" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ updateChannel: "stable" }));
    await waitFor(() => expect(mockState.setUpdateInfo).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "Stable" })).toHaveAttribute("aria-checked", "true");
  });

  // Saving the channel succeeded but the follow-up check failed: keep the new channel.
  it("keeps the stable channel when only the follow-up update check fails", async () => {
    mockApi.forceCheckForUpdate.mockRejectedValueOnce(new Error("check failed"));
    await renderLoaded({ updateChannel: "prerelease" });
    fireEvent.click(screen.getByRole("radio", { name: "Stable" }));
    await waitFor(() => expect(mockApi.forceCheckForUpdate).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "Stable" })).toHaveAttribute("aria-checked", "true");
    expect(mockState.setUpdateInfo).not.toHaveBeenCalled();
  });

  it("reverts to prerelease when saving the stable channel fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("fail"));
    await renderLoaded({ updateChannel: "prerelease" });
    fireEvent.click(screen.getByRole("radio", { name: "Stable" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("radio", { name: "Prerelease" })).toHaveAttribute("aria-checked", "true"));
    expect(mockApi.forceCheckForUpdate).not.toHaveBeenCalled();
  });

  it("reverts to stable when saving the prerelease channel fails", async () => {
    mockApi.updateSettings.mockRejectedValueOnce(new Error("fail"));
    await renderLoaded();
    fireEvent.click(screen.getByRole("radio", { name: "Prerelease" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("radio", { name: "Stable" })).toHaveAttribute("aria-checked", "true"));
    expect(mockApi.forceCheckForUpdate).not.toHaveBeenCalled();
  });

  it("ignores clicks on the already-selected prerelease channel", async () => {
    await renderLoaded({ updateChannel: "prerelease" });
    fireEvent.click(screen.getByRole("radio", { name: "Prerelease" }));
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });
});

// ─── Time zone (chat message times and day separators) ───────────────────────
// A global setting: "" = Automatic (each device's own zone) or an IANA zone.
// Saving pushes the value into the store so open chats re-render immediately.
describe("SettingsPage – time zone", () => {
  const loaded = {
    anthropicApiKeyConfigured: true,
    anthropicModel: "claude-sonnet-4-6",
    updateChannel: "stable",
    publicUrl: "",
  };

  async function renderWithZone(timeZone: string) {
    mockApi.getSettings.mockResolvedValueOnce({ ...loaded, timeZone });
    const utils = render(<SettingsPage />);
    await screen.findByText(/Anthropic key (not )?configured/);
    return utils;
  }

  function zoneSelect() {
    return screen.getByLabelText("Time zone") as HTMLSelectElement;
  }

  // Render: Automatic first (naming the resolved device zone), then the IANA list.
  it("renders Automatic (with the device zone) followed by IANA zones", async () => {
    await renderWithZone("");
    const select = zoneSelect();
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(select.options[0].value).toBe("");
    expect(select.options[0].textContent).toBe(`Automatic (device: ${device})`);
    expect(Array.from(select.options).map((o) => o.value)).toContain("Europe/Rome");
    expect(select.value).toBe("");
  });

  // The saved zone is selected and loaded into the store on open.
  it("reflects the saved zone and loads it into the store", async () => {
    await renderWithZone("Asia/Tokyo");
    expect(zoneSelect().value).toBe("Asia/Tokyo");
    expect(mockState.setTimeZone).toHaveBeenCalledWith("Asia/Tokyo");
  });

  // Interaction: picking a zone saves it and updates the store with the
  // server's answer, so open chats re-render in the new zone.
  it("saves a picked zone and pushes it into the store", async () => {
    await renderWithZone("");
    mockApi.updateSettings.mockResolvedValueOnce({ ...loaded, timeZone: "Europe/Rome" });
    fireEvent.change(zoneSelect(), { target: { value: "Europe/Rome" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ timeZone: "Europe/Rome" }));
    await waitFor(() => expect(mockState.setTimeZone).toHaveBeenLastCalledWith("Europe/Rome"));
    expect(zoneSelect().value).toBe("Europe/Rome");
  });

  // Going back to Automatic saves "" (not the device zone).
  it("saves an empty value when Automatic is picked", async () => {
    await renderWithZone("Europe/Rome");
    mockApi.updateSettings.mockResolvedValueOnce({ ...loaded, timeZone: "" });
    fireEvent.change(zoneSelect(), { target: { value: "" } });
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ timeZone: "" }));
    await waitFor(() => expect(mockState.setTimeZone).toHaveBeenLastCalledWith(""));
  });

  // Older servers may not echo timeZone back: keep the picked value.
  it("keeps the picked zone when the response omits it", async () => {
    await renderWithZone("");
    mockApi.updateSettings.mockResolvedValueOnce({ ...loaded });
    fireEvent.change(zoneSelect(), { target: { value: "UTC" } });
    await waitFor(() => expect(mockState.setTimeZone).toHaveBeenLastCalledWith("UTC"));
  });

  // A rejected save (e.g. 400 for an unknown zone) rolls the select back,
  // shows the error, and leaves the store alone.
  it("reverts and shows the error when saving fails", async () => {
    await renderWithZone("Europe/Rome");
    mockState.setTimeZone.mockClear();
    mockApi.updateSettings.mockRejectedValueOnce(new Error("timeZone must be empty (automatic) or a valid IANA time zone"));
    fireEvent.change(zoneSelect(), { target: { value: "Asia/Tokyo" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("valid IANA time zone");
    expect(zoneSelect().value).toBe("Europe/Rome");
    expect(mockState.setTimeZone).not.toHaveBeenCalled();
  });

  // A saved zone missing from this browser's list stays selectable instead
  // of silently showing another option.
  it("keeps a saved zone that the browser list does not contain", async () => {
    const original = (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
    try {
      await renderWithZone("Asia/Calcutta");
      const values = Array.from(zoneSelect().options).map((o) => o.value);
      expect(values).toEqual(["", "UTC", "Asia/Calcutta"]);
      expect(zoneSelect().value).toBe("Asia/Calcutta");
    } finally {
      (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = original;
    }
  });

  it("passes axe accessibility checks for the General section", async () => {
    const { axe } = await import("vitest-axe");
    // axe walks every <option>; with the full ~400-zone IANA list that takes
    // seconds under coverage instrumentation. A short list has the same markup.
    const original = (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
    (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = () => ["Europe/Rome", "Asia/Tokyo"];
    try {
      await renderWithZone("");
      const general = document.getElementById("general");
      expect(general).toBeInTheDocument();
      expect(await axe(general!)).toHaveNoViolations();
    } finally {
      (Intl as { supportedValuesOf?: unknown }).supportedValuesOf = original;
    }
  });
});
