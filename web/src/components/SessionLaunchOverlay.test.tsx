// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { CreationProgressEvent } from "../api.js";
import { SessionLaunchOverlay } from "./SessionLaunchOverlay.js";

const inProgressSteps: CreationProgressEvent[] = [
  { step: "resolving_env", label: "Environment resolved", status: "done" },
  { step: "pulling_git", label: "Pulling latest changes...", status: "in_progress" },
];

describe("SessionLaunchOverlay", () => {
  it("renders every step label and uses the in-progress step as the subtitle", () => {
    // The overlay is the only progress UI during creation: each server step
    // must be listed, and the active one drives the headline text.
    render(<SessionLaunchOverlay steps={inProgressSteps} backend="claude" />);

    expect(screen.getByText("Environment resolved")).toBeInTheDocument();
    expect(screen.getAllByText("Pulling latest changes...")).toHaveLength(2);
    expect(screen.getByAltText("Launching")).toHaveAttribute("src", "/logo.svg");
  });

  it("shows the Codex logo for Codex sessions", () => {
    // Backend parity: the launch screen must reflect which CLI is starting.
    render(<SessionLaunchOverlay steps={inProgressSteps} backend="codex" />);
    expect(screen.getByAltText("Launching")).toHaveAttribute("src", "/logo-codex.svg");
  });

  it("calls onCancel from the Cancel button while a step is in progress", () => {
    // Users must be able to abort a slow creation (e.g. a long git pull).
    const onCancel = vi.fn();
    render(<SessionLaunchOverlay steps={inProgressSteps} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the error text and a Dismiss button when creation fails", () => {
    // Errors must be visible and dismissible so the user can return to Home.
    const onCancel = vi.fn();
    render(
      <SessionLaunchOverlay
        steps={[{ step: "launching_cli", label: "Launching Claude Code...", status: "error" }]}
        error="CLI exited with code 1"
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("CLI exited with code 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the launching subtitle and no button once every step is done", () => {
    // Nothing is left to cancel after the last step completes.
    render(
      <SessionLaunchOverlay
        steps={[{ step: "launching_cli", label: "Session started", status: "done" }]}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText("Launching session...")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("falls back to a preparing subtitle before any step arrives", () => {
    render(<SessionLaunchOverlay steps={[]} />);
    expect(screen.getByText("Preparing...")).toBeInTheDocument();
  });

  it("passes axe accessibility checks while in progress", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SessionLaunchOverlay steps={inProgressSteps} backend="claude" onCancel={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("passes axe accessibility checks in the error state", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <SessionLaunchOverlay
        steps={[{ step: "launching_cli", label: "Launching Claude Code...", status: "error" }]}
        error="CLI exited with code 1"
        onCancel={() => {}}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
