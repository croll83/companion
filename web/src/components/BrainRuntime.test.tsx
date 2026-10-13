// @vitest-environment jsdom
/**
 * The process section of an embedded brain. Validates the state in words,
 * the cause and action of a failure (what the user can act on, not just a
 * log tail), the buttons offered in each state (Start when stopped or
 * failed, Stop when running, no Restart when stopped), the troubleshooting
 * details with the child's own port, and the log shown on demand or at once
 * after a failure.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainRuntime } from "./BrainRuntime.js";
import { embeddedBrain } from "../test-fixtures/brains.js";
import type { BrainRuntimeInfo } from "../api.js";

function setup(runtime: BrainRuntimeInfo | undefined, logs: string[] | null = ["line a", "line b"]) {
  const onAction = vi.fn(async () => true);
  const loadLogs = vi.fn(async () => logs);
  render(<BrainRuntime brain={embeddedBrain({ runtime })} busy={false} onAction={onAction} loadLogs={loadLogs} />);
  return { onAction, loadLogs };
}

describe("BrainRuntime", () => {
  it("renders a running brain with Stop and Restart", () => {
    const { onAction, loadLogs } = setup({ state: "running", pid: 4242, port: 45999, crashes: 0 });
    expect(screen.getByRole("region", { name: "Brain process" })).toHaveTextContent("Running");
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAction).toHaveBeenCalledWith("stop");
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onAction).toHaveBeenCalledWith("restart");
    expect(screen.getByText("pid 4242")).toBeInTheDocument();
    expect(screen.getByText("45999 (sessions use Companion's port instead)")).toBeInTheDocument();
    expect(loadLogs).not.toHaveBeenCalled();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <BrainRuntime brain={embeddedBrain({ runtime: { state: "backoff", crashes: 2, cause: "The brain keeps stopping: boom", action: "Look at the log." } })} busy={false} onAction={vi.fn(async () => true)} loadLogs={vi.fn(async () => [])} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a stopped brain offers Start only", () => {
    const { onAction } = setup(undefined);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenCalledWith("start");
    expect(screen.getAllByText("none")).toHaveLength(2);
  });

  it("a failed brain shows the cause, the action and its log at once", async () => {
    const { loadLogs } = setup({ state: "failed", crashes: 5, cause: "The wiki folder /w is missing.", action: "Restore the folder.", lastExitCode: 2 });
    expect(screen.getByRole("alert")).toHaveTextContent("The wiki folder /w is missing.Restore the folder.");
    expect(screen.getByText(/5 crashes in 10 minutes/)).toBeInTheDocument();
    expect(screen.getByText("none · last exit code 2")).toBeInTheDocument();
    expect(await screen.findByLabelText("Brain log")).toHaveTextContent("line a line b");
    expect(loadLogs).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload log" }));
    await waitFor(() => expect(loadLogs).toHaveBeenCalledTimes(2));
  });

  it("shows an empty log, and nothing when it could not be read", async () => {
    setup({ state: "starting", crashes: 1 }, []);
    expect(screen.getByText("Starting… · 1 crash in 10 minutes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show log" }));
    expect(await screen.findByText("The log is empty.")).toBeInTheDocument();
  });

  it("names the unhealthy state", async () => {
    setup({ state: "unhealthy", crashes: 0 }, null);
    expect(screen.getByText("Not answering its health checks")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show log" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show log" })).toBeEnabled());
    expect(screen.queryByLabelText("Brain log")).toBeNull();
  });
});
