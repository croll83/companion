// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";

describe("Playground", () => {
  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Subagent playground demo should show Codex-specific metadata presentation.
    expect(screen.getByText("sender: thr_main")).toBeTruthy();
    expect(screen.getByText("thr_sub_1")).toBeTruthy();

    // Interesting event states should be represented in the playground.
    expect(screen.getByText("Interesting Events")).toBeTruthy();
    expect(screen.getByText("Context compacted (auto, pre-tokens: 182344).")).toBeTruthy();
    expect(screen.getByText("Hook success: lint (post_tool_use) (exit 0).")).toBeTruthy();
  });

  // Message times + day separators (chat timestamps feature): the dedicated
  // section seeds a MessageFeed over three days plus a legacy message with an
  // unknown time, so separators and bubble times are visible in the playground.
  it("renders the day separators demo with times and separators", async () => {
    render(<Playground />);
    expect(screen.getByText("Day Separators")).toBeTruthy();
    const demo = screen.getByTestId("playground-day-separators");
    const seps = await within(demo).findAllByRole("separator");
    // Three days with known times → three separators; the legacy message adds none.
    expect(seps.map((s) => s.getAttribute("aria-label")).slice(1)).toEqual(["Yesterday", "Today"]);
    expect(seps).toHaveLength(3);
    // Six messages with a known time show it; the legacy one does not.
    expect(demo.querySelectorAll("time")).toHaveLength(6);
  });
});
