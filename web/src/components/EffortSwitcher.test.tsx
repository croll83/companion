// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockStoreState {
  sdkSessions: { sessionId: string; model?: string; effort?: string; backendType?: string; cwd: string }[];
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { model?: string; effort?: string; backend_type?: string }>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sdkSessions: [
      { sessionId: "s1", model: "claude-fable-5", effort: "high", backendType: "claude", cwd: "/repo" },
    ],
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { model: "claude-fable-5", effort: "high" }]]),
    ...overrides,
  };
}

const mockSetSdkSessions = vi.fn();

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({ ...storeState, setSdkSessions: mockSetSdkSessions }),
    },
  ),
}));

import { EffortSwitcher } from "./EffortSwitcher.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("EffortSwitcher", () => {
  it("renders the current effort level", () => {
    render(<EffortSwitcher sessionId="s1" />);
    expect(screen.getByLabelText("Set reasoning effort")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("shows all five levels for fable-5", () => {
    render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    for (const label of ["Low", "Medium", "X-High", "Max"]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    // "High" appears both on the trigger and as an option.
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
  });

  it("omits xhigh for Opus 4.6 (CLI gating)", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", model: "claude-opus-4-6", effort: "high", backendType: "claude", cwd: "/repo" }],
      sessions: new Map([["s1", { model: "claude-opus-4-6", effort: "high" }]]),
    });
    render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    expect(screen.queryByRole("option", { name: "X-High" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Max" })).toBeInTheDocument();
  });

  it("sends set_effort and optimistically updates on selection", () => {
    render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    fireEvent.click(screen.getByRole("option", { name: "Max" }));

    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_effort", effort: "max" });
    expect(mockSetSdkSessions).toHaveBeenCalledOnce();
    expect(mockSetSdkSessions.mock.calls[0][0][0].effort).toBe("max");
  });

  it("does not send when selecting the already-active level", () => {
    render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockSetSdkSessions).not.toHaveBeenCalled();
  });

  it("defaults to high when no effort is stored", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", model: "claude-fable-5", backendType: "claude", cwd: "/repo" }],
      sessions: new Map([["s1", { model: "claude-fable-5" }]]),
    });
    render(<EffortSwitcher sessionId="s1" />);
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("is hidden for models that don't support effort", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", model: "claude-sonnet-4-6", backendType: "claude", cwd: "/repo" }],
      sessions: new Map([["s1", { model: "claude-sonnet-4-6" }]]),
    });
    const { container } = render(<EffortSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden for Codex and when disconnected", () => {
    resetStore({ cliConnected: new Map([["s1", false]]) });
    const { container } = render(<EffortSwitcher sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("closes on Escape", () => {
    render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("passes axe accessibility checks with dropdown open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<EffortSwitcher sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Set reasoning effort"));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
