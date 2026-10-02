// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();
vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
}));

interface MockStoreState {
  sdkSessions: { sessionId: string; model?: string; backendType?: string; ultracode?: boolean; cwd: string }[];
  cliConnected: Map<string, boolean>;
  sessions: Map<string, { model?: string; backend_type?: string; ultracode?: boolean; ultracodeConfirmedAt?: number }>;
}

let storeState: MockStoreState;
function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sdkSessions: [{ sessionId: "s1", model: "claude-opus-5-5", backendType: "claude", cwd: "/repo" }],
    cliConnected: new Map([["s1", true]]),
    sessions: new Map([["s1", { model: "claude-opus-5-5" }]]),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { UltracodeToggle } from "./UltracodeToggle.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("UltracodeToggle", () => {
  it("is offered on a Claude model that can run it", () => {
    render(<UltracodeToggle sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Ultracode" })).toHaveAttribute("aria-pressed", "false");
  });

  it("asks the CLI to turn it on", () => {
    render(<UltracodeToggle sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Ultracode" }));
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_ultracode", enabled: true });
  });

  it("does not show itself as on until the CLI confirms", () => {
    // No optimistic flip: a refused request must never look enabled.
    render(<UltracodeToggle sessionId="s1" />);
    const btn = screen.getByRole("button", { name: "Ultracode" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toBeDisabled(); // waiting for the answer
  });

  it("reflects the confirmed state", () => {
    resetStore({ sessions: new Map([["s1", { model: "claude-opus-5-5", ultracode: true }]]) });
    render(<UltracodeToggle sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Ultracode" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is hidden for Codex, which has no ultracode", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", model: "gpt-6-astra", backendType: "codex", cwd: "/repo" }],
      sessions: new Map([["s1", { model: "gpt-6-astra", backend_type: "codex" }]]),
    });
    const { container } = render(<UltracodeToggle sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden on a model without xhigh, where the CLI cannot run it", () => {
    resetStore({ sessions: new Map([["s1", { model: "claude-haiku-4-5-20251001" }]]) });
    const { container } = render(<UltracodeToggle sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("is hidden while the CLI is disconnected", () => {
    resetStore({ cliConnected: new Map([["s1", false]]) });
    const { container } = render(<UltracodeToggle sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });
});
