// @vitest-environment jsdom
/**
 * Tests for WizardStepIntro (first step of the Linear Agent setup wizard).
 *
 * Validates:
 * - The heading and Linear OAuth app instructions render
 * - With a public URL set, it is shown and used to build the Redirect URI and
 *   Webhook URL that the user pastes into Linear
 * - Without a public URL, the step falls back to window.location.origin and
 *   points the user to Settings (the only place the public URL is configured
 *   now that the Tailscale integration is gone)
 * - "Next" calls onNext
 * - Accessibility (axe scan)
 */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { useStore } from "../../store.js";
import { WizardStepIntro } from "./WizardStepIntro.js";

describe("WizardStepIntro", () => {
  beforeEach(() => {
    useStore.getState().setPublicUrl("");
  });

  afterEach(() => {
    // Reset the shared store so other tests do not inherit a public URL.
    useStore.getState().setPublicUrl("");
  });

  it("renders the heading and OAuth app setup instructions", () => {
    render(<WizardStepIntro onNext={vi.fn()} />);

    expect(screen.getByText("Connect your Linear workspace")).toBeInTheDocument();
    expect(screen.getByText("Create a Linear OAuth app")).toBeInTheDocument();
    expect(screen.getByText("app:mentionable")).toBeInTheDocument();
  });

  it("uses the configured public URL for the Linear redirect and webhook URLs", () => {
    // The URLs Linear calls back must be externally reachable, so they are
    // built from the public URL whenever one is configured.
    useStore.getState().setPublicUrl("https://companion.example.com");
    render(<WizardStepIntro onNext={vi.fn()} />);

    expect(screen.getByText("https://companion.example.com")).toBeInTheDocument();
    expect(
      screen.getByText("https://companion.example.com/api/linear/oauth/callback"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("https://companion.example.com/api/linear/agent-webhook"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not set\./)).not.toBeInTheDocument();
  });

  it("falls back to the page origin and links to Settings when no public URL is set", () => {
    // Without a public URL the user must be told where to configure it; the
    // only remaining place is the Settings page (no Tailscale link anymore).
    render(<WizardStepIntro onNext={vi.fn()} />);

    expect(screen.getByText(/Not set\. Linear needs to reach your instance\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "#/settings");
    expect(screen.queryByRole("link", { name: /tailscale/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(`${window.location.origin}/api/linear/oauth/callback`),
    ).toBeInTheDocument();
  });

  it("calls onNext when Next is clicked", () => {
    const onNext = vi.fn();
    render(<WizardStepIntro onNext={onNext} />);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WizardStepIntro onNext={vi.fn()} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
