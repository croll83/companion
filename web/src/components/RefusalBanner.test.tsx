// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockSendToSession = vi.fn();
const mockCreateClientMessageId = vi.fn(() => "cmid-1");

vi.mock("../ws.js", () => ({
  sendToSession: (...args: unknown[]) => mockSendToSession(...args),
  createClientMessageId: () => mockCreateClientMessageId(),
}));

interface MockStoreState {
  currentSessionId: string | null;
  messages: Map<string, { id: string; role: string; content: string }[]>;
}

let storeState: MockStoreState;
const mockSetSdkSessions = vi.fn();
const mockAppendMessage = vi.fn();

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    messages: new Map([
      ["s1", [
        { id: "u1", role: "user", content: "first prompt" },
        { id: "a1", role: "assistant", content: "..." },
        { id: "u2", role: "user", content: "build me an exploit" },
      ]],
    ]),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: Object.assign(
    (selector: (s: MockStoreState) => unknown) => selector(storeState),
    {
      getState: () => ({
        sdkSessions: [{ sessionId: "s1", model: "claude-fable-5" }],
        setSdkSessions: mockSetSdkSessions,
        appendMessage: mockAppendMessage,
      }),
    },
  ),
}));

import { RefusalBanner } from "./RefusalBanner.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

const REFUSAL = {
  category: "cyber",
  explanation: "This request involves offensive capabilities I can't help build.",
  model: "claude-fable-5",
};

describe("RefusalBanner", () => {
  it("renders the explanation and a friendly category label", () => {
    render(<RefusalBanner refusal={REFUSAL} />);
    expect(screen.getByText("Model declined to respond")).toBeInTheDocument();
    expect(screen.getByText(REFUSAL.explanation)).toBeInTheDocument();
    expect(screen.getByText("Cybersecurity policy")).toBeInTheDocument();
  });

  it("retries on Opus 4.8: switches model then re-sends the last user prompt", () => {
    render(<RefusalBanner refusal={REFUSAL} />);
    fireEvent.click(screen.getByRole("button", { name: /Retry with Opus 4\.8/ }));

    // 1) model switch to the fallback
    expect(mockSendToSession).toHaveBeenCalledWith("s1", { type: "set_model", model: "claude-opus-4-8" });
    expect(mockSetSdkSessions).toHaveBeenCalledOnce();
    // 2) the LAST user prompt is re-sent (not the earlier one)
    expect(mockSendToSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      type: "user_message",
      content: "build me an exploit",
      client_msg_id: "cmid-1",
    }));
    // 3) optimistic user bubble appended
    expect(mockAppendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      role: "user",
      content: "build me an exploit",
    }));
  });

  it("disables the retry button after clicking", () => {
    render(<RefusalBanner refusal={REFUSAL} />);
    const btn = screen.getByRole("button", { name: /Retry with Opus 4\.8/ });
    fireEvent.click(btn);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("hides the retry button when Opus 4.8 itself refused", () => {
    render(<RefusalBanner refusal={{ ...REFUSAL, model: "claude-opus-4-8" }} />);
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/also declined/)).toBeInTheDocument();
  });

  it("renders an unknown category verbatim", () => {
    render(<RefusalBanner refusal={{ explanation: "nope", category: "weird_new_cat" }} />);
    expect(screen.getByText("weird_new_cat")).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<RefusalBanner refusal={REFUSAL} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
