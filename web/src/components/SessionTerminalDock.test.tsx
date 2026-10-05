// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("./TerminalView.js", () => ({
  TerminalView: ({ title, cwd }: { title?: string; cwd: string }) => (
    <div data-testid="terminal-view">{title || cwd}</div>
  ),
}));

interface MockStoreState {
  currentSessionId: string | null;
  quickTerminalOpen: boolean;
  quickTerminalTabs: { id: string; label: string; cwd: string }[];
  activeQuickTerminalTabId: string | null;
  quickTerminalPlacement: "top" | "right" | "bottom" | "left";
  setQuickTerminalOpen: ReturnType<typeof vi.fn>;
  openQuickTerminal: ReturnType<typeof vi.fn>;
  closeQuickTerminalTab: ReturnType<typeof vi.fn>;
  setActiveQuickTerminalTabId: ReturnType<typeof vi.fn>;
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    quickTerminalOpen: true,
    quickTerminalTabs: [{ id: "t1", label: "Terminal", cwd: "/repo" }],
    activeQuickTerminalTabId: "t1",
    quickTerminalPlacement: "left",
    setQuickTerminalOpen: vi.fn(),
    openQuickTerminal: vi.fn(),
    closeQuickTerminalTab: vi.fn(),
    setActiveQuickTerminalTabId: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { SessionTerminalDock } from "./SessionTerminalDock.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("SessionTerminalDock", () => {
  it("renders only session content when terminal dock is closed", () => {
    // Ensures chat/diff layout remains untouched when no terminal tab is active.
    resetStore({ quickTerminalOpen: false, quickTerminalTabs: [] });

    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-view")).not.toBeInTheDocument();
  });

  it("renders docked terminal panel inside the session layout", () => {
    // Verifies terminal is embedded in the same session container and can be closed via toolbar.
    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view")).toHaveTextContent("/repo");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(storeState.setQuickTerminalOpen).toHaveBeenCalledWith(false);
  });

  it("keeps terminal mounted when panel is suppressed", () => {
    // Ensures tab switches can hide the panel without unmounting TerminalView (which would kill PTY).
    render(
      <SessionTerminalDock sessionId="s1" suppressPanel>
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.getByText("Session content")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
  });

  it("opens a host terminal in the session cwd from + Terminal", () => {
    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    fireEvent.click(screen.getByRole("button", { name: "+ Terminal" }));
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({ cwd: "/repo" });
  });


  it("opens a terminal from the terminal-only empty state", () => {
    // In terminal-only view with no tab yet, the CTA opens one in the session cwd.
    resetStore({ quickTerminalOpen: false, quickTerminalTabs: [], activeQuickTerminalTabId: null });
    render(
      <SessionTerminalDock sessionId="s1" terminalOnly>
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
    expect(storeState.openQuickTerminal).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("hides the open-terminal CTA when the session has no known cwd", () => {
    // Without a cwd there is nowhere to spawn the shell, so no button is offered.
    resetStore({
      quickTerminalOpen: false,
      quickTerminalTabs: [],
      activeQuickTerminalTabId: null,
      sessions: new Map(),
      sdkSessions: [],
    });
    render(
      <SessionTerminalDock sessionId="s1" terminalOnly>
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    expect(screen.queryByRole("button", { name: "Open terminal" })).not.toBeInTheDocument();
  });

  it("selects and closes terminal tabs through their own buttons", () => {
    // Each tab exposes a select button and a separate close button (no nested
    // interactive controls); both must reach the store with the tab id.
    resetStore({
      quickTerminalTabs: [
        { id: "t1", label: "Terminal", cwd: "/repo" },
        { id: "t2", label: "Terminal 2", cwd: "/repo/web" },
      ],
    });
    render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );

    const second = screen.getByRole("button", { name: "Terminal 2" });
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(second);
    expect(storeState.setActiveQuickTerminalTabId).toHaveBeenCalledWith("t2");

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2 terminal tab" }));
    expect(storeState.closeQuickTerminalTab).toHaveBeenCalledWith("t2");
    expect(storeState.setActiveQuickTerminalTabId).toHaveBeenCalledTimes(1);
  });

  it("passes axe accessibility checks with a docked terminal tab", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SessionTerminalDock sessionId="s1">
        <div>Session content</div>
      </SessionTerminalDock>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
