// @vitest-environment jsdom
/**
 * The Consolidation tab. Embedded brains: the status line (waiting notes,
 * last consolidation, next run), the on/off toggle (it creates the agent),
 * "Consolidate now" with the waiting count and its outcome (started, or
 * skipped with the reason), the settings form (schedule, backend, model with
 * the "Latest Sonnet (now: …)" default, threshold) sent as one patch, Retry
 * sync after a not-synced run, the runs with their verified status, and
 * errors. Remote brains: linking an existing agent. Plus an axe scan.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainConsolidationRun, BrainConsolidationView } from "../api.js";

const mockApi = vi.hoisted(() => ({
  brainConsolidation: vi.fn(),
  updateBrainConsolidation: vi.fn(),
  runBrainConsolidation: vi.fn(),
  syncBrainConsolidation: vi.fn(),
  getBackendModels: vi.fn(),
  listAgents: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainConsolidation, decidedText, durationText } from "./BrainConsolidation.js";
import { embeddedBrain, jarvisBrain } from "../test-fixtures/brains.js";
import { latestSonnet } from "../utils/backends.js";

const runs: BrainConsolidationRun[] = [
  { id: "r3", trigger: "threshold", status: "not_synced", startedAt: Date.UTC(2026, 9, 14, 9), finishedAt: Date.UTC(2026, 9, 14, 9, 2, 5), pending: 12, sessionId: "s3", model: "claude-sonnet-5-5", decided: { accepted: 3, rejected: 1, undecided: 0 }, commit: "abc1234", costUsd: 0.42, tokens: { input: 1500, output: 300 }, error: "Consolidated but not synced: git pull --ff-only failed" },
  { id: "r2", trigger: "schedule", status: "skipped", startedAt: Date.UTC(2026, 9, 13, 5), finishedAt: Date.UTC(2026, 9, 13, 5), pending: 0, error: "No note waiting" },
  { id: "r1", trigger: "catch-up", status: "success", startedAt: Date.UTC(2026, 9, 12, 5), finishedAt: Date.UTC(2026, 9, 12, 5, 0, 45), commit: "def5678", lint: { errors: 1, warnings: 0 } },
];

function view(over: Partial<BrainConsolidationView> = {}): BrainConsolidationView {
  return {
    config: { enabled: true, schedule: "0 5 * * *", mode: "local", backend: "claude", threshold: 10, agentId: "work-brain-consolidation" },
    agent: { id: "work-brain-consolidation", name: "Work brain consolidation", backendType: "claude", model: "claude-sonnet-5-5", enabled: true },
    resolvedModel: "claude-sonnet-5-5",
    running: false,
    nextRunAt: Date.UTC(2026, 9, 15, 5),
    lastSuccessAt: Date.UTC(2026, 9, 12, 5, 0, 45),
    runs,
    domain: "herd",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainConsolidation.mockResolvedValue(view());
  mockApi.updateBrainConsolidation.mockImplementation(async (_slug: string, patch: Record<string, unknown>) => view({ config: { ...view().config, ...(patch as object) } as BrainConsolidationView["config"] }));
  mockApi.getBackendModels.mockResolvedValue([{ value: "gpt-6-astra", label: "GPT-6-Astra" }, { value: "gpt-5.5", label: "GPT-5.5" }]);
  mockApi.listAgents.mockResolvedValue([{ id: "jarvis-wiki-consolidation", name: "jarvis-wiki-consolidation" }, { id: "other", name: "Other" }]);
});

describe("BrainConsolidation (embedded)", () => {
  it("renders the status, the agent and the runs with their verified outcome", async () => {
    render(<BrainConsolidation brain={embeddedBrain()} waiting={12} />);
    expect(await screen.findByText(/12 notes waiting · last consolidated/)).toHaveTextContent("next run");
    expect(screen.getByRole("link", { name: "Work brain consolidation" })).toHaveAttribute("href", "#/agents");
    expect(screen.getByText(/in the herd domain/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Consolidate this brain automatically" })).toBeChecked();
    const list = screen.getByRole("list", { name: "Consolidation runs" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Not synced · notes over the threshold");
    // Token counts use the browser's number format (1,500 or 1500 or 1.500).
    expect(items[0]).toHaveTextContent(/2 min 5 s · 12 waiting · 3 accepted, 1 rejected · commit abc1234 · claude-sonnet-5-5 · \$0\.42 · 1[,.]?500 in \/ 300 out tokens/);
    expect(items[0]).toHaveTextContent("Consolidated but not synced");
    expect(within(items[0]).getByRole("link", { name: "Open the run's session" })).toHaveAttribute("href", "#/session/s3");
    expect(items[1]).toHaveTextContent("Skipped · scheduled");
    expect(items[1]).toHaveTextContent("No note waiting");
    expect(items[2]).toHaveTextContent("Success · catch-up at startup");
    // The wiki check made after the sync.
    expect(items[2]).toHaveTextContent("wiki check: 1 errors, 0 warnings");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainConsolidation brain={embeddedBrain()} waiting={3} />);
    await screen.findByRole("list", { name: "Consolidation runs" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("consolidates now and reports a started or a skipped run", async () => {
    const onChanged = vi.fn();
    mockApi.runBrainConsolidation.mockResolvedValueOnce({ started: true, consolidation: view({ running: true, runningSessionId: "s9" }) });
    render(<BrainConsolidation brain={embeddedBrain()} waiting={3} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Consolidate now (3 waiting)" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Started");
    expect(mockApi.runBrainConsolidation).toHaveBeenCalledWith("work");
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Consolidating…" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Open the running session" })).toHaveAttribute("href", "#/session/s9");
  });

  it("shows why a run did not start", async () => {
    mockApi.runBrainConsolidation.mockResolvedValueOnce({ started: false, run: { ...runs[1] }, consolidation: view() });
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Consolidate now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No note waiting");
  });

  it("retries the sync of a not-synced run", async () => {
    mockApi.syncBrainConsolidation.mockResolvedValueOnce({ run: { id: "r4", trigger: "manual", status: "success", startedAt: 1 }, consolidation: view({ runs: [{ id: "r4", trigger: "manual", status: "success", startedAt: 1 }] }) });
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry sync" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Synced into the wiki.");
    expect(screen.queryByRole("button", { name: "Retry sync" })).toBeNull();
  });

  it("turns consolidation on and off", async () => {
    mockApi.brainConsolidation.mockResolvedValueOnce(view({ config: { ...view().config, enabled: false }, agent: null, runs: [] }));
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    expect(await screen.findByText(/Turning it on creates the consolidation agent/)).toBeInTheDocument();
    expect(screen.getByText("No run yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Consolidate now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Consolidate this brain automatically" }));
    expect(await screen.findByText("Consolidation is on.")).toBeInTheDocument();
    expect(mockApi.updateBrainConsolidation).toHaveBeenCalledWith("work", { enabled: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Consolidate this brain automatically" }));
    expect(await screen.findByText("Consolidation is off.")).toBeInTheDocument();
  });

  it("offers Latest Sonnet as the default model and saves the settings in one patch", async () => {
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    const form = await screen.findByRole("form", { name: "Consolidation settings" });
    const model = within(form).getByLabelText("Model") as HTMLSelectElement;
    expect(model.value).toBe("");
    expect(within(model).getByRole("option", { name: "Latest Sonnet (now: claude-sonnet-5-5)" })).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Schedule (cron)"), { target: { value: " 30 4 * * * " } });
    fireEvent.change(within(form).getByLabelText("Run early at (waiting notes)"), { target: { value: "4" } });
    fireEvent.change(model, { target: { value: "claude-opus-5-5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save consolidation settings" }));
    await waitFor(() => expect(mockApi.updateBrainConsolidation).toHaveBeenCalledWith("work", { schedule: "30 4 * * *", backend: "claude", model: "claude-opus-5-5", threshold: 4 }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  it("switches to Codex: its models from the server, default model reset", async () => {
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    const form = await screen.findByRole("form", { name: "Consolidation settings" });
    fireEvent.change(within(form).getByLabelText("Backend"), { target: { value: "codex" } });
    const model = within(form).getByLabelText("Model");
    expect(await within(model).findByRole("option", { name: "GPT-6-Astra" })).toBeInTheDocument();
    expect(within(model).getByRole("option", { name: "Codex's first model (now: gpt-6-astra)" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Save consolidation settings" }));
    await waitFor(() => expect(mockApi.updateBrainConsolidation).toHaveBeenCalledWith("work", { schedule: "0 5 * * *", backend: "codex", model: null, threshold: 10 }));
  });

  it("shows API errors", async () => {
    mockApi.updateBrainConsolidation.mockRejectedValueOnce(new Error("The schedule may not run more often than every 15 minutes"));
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    const form = await screen.findByRole("form", { name: "Consolidation settings" });
    fireEvent.click(within(form).getByRole("button", { name: "Save consolidation settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("more often than every 15 minutes");
  });

  it("shows a load error", async () => {
    mockApi.brainConsolidation.mockRejectedValueOnce(new Error("Consolidation is not available on this server"));
    render(<BrainConsolidation brain={embeddedBrain()} waiting={0} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not available");
  });
});

describe("BrainConsolidation (remote)", () => {
  it("links an existing agent and lists its runs", async () => {
    mockApi.brainConsolidation.mockResolvedValue(view({ config: { ...view().config, enabled: false, agentId: undefined }, agent: null, runs: [] }));
    mockApi.updateBrainConsolidation.mockResolvedValueOnce(view({ agent: { id: "jarvis-wiki-consolidation", name: "jarvis-wiki-consolidation", backendType: "claude", model: "claude-opus-5-5", enabled: true }, runs: [runs[2]] }));
    render(<BrainConsolidation brain={jarvisBrain()} waiting={0} />);
    const form = await screen.findByRole("form", { name: "Link the consolidation agent" });
    const select = within(form).getByLabelText("Consolidation agent");
    await within(select).findByRole("option", { name: "jarvis-wiki-consolidation" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(select, { target: { value: "jarvis-wiki-consolidation" } });
    fireEvent.click(within(form).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(mockApi.updateBrainConsolidation).toHaveBeenCalledWith("jarvis", { agentId: "jarvis-wiki-consolidation" }));
    expect(await screen.findByText("Linked.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Consolidation runs" })).getByRole("listitem")).toHaveTextContent("Success · catch-up at startup");
  });

  it("unlinks the agent", async () => {
    mockApi.brainConsolidation.mockResolvedValue(view({ agent: { id: "other", name: "Other", backendType: "claude", model: "m", enabled: true } }));
    mockApi.updateBrainConsolidation.mockResolvedValueOnce(view({ agent: null, runs: [] }));
    render(<BrainConsolidation brain={jarvisBrain()} waiting={0} />);
    const select = await screen.findByLabelText("Consolidation agent");
    await within(select).findByRole("option", { name: "Other" });
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(mockApi.updateBrainConsolidation).toHaveBeenCalledWith("jarvis", { agentId: null }));
  });

  it("passes axe accessibility scan for a remote brain", async () => {
    const { axe } = await import("vitest-axe");
    mockApi.listAgents.mockRejectedValueOnce(new Error("down"));
    const { container } = render(<BrainConsolidation brain={jarvisBrain()} waiting={0} />);
    await screen.findByRole("form", { name: "Link the consolidation agent" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("helpers", () => {
  it("formats durations and decisions", () => {
    expect(durationText(45_000)).toBe("45 s");
    expect(durationText(125_000)).toBe("2 min 5 s");
    expect(durationText(-5)).toBe("0 s");
    expect(decidedText(undefined)).toBe("");
    expect(decidedText({ accepted: 2, deferred: 1, undecided: 3 })).toBe("2 accepted, 1 deferred");
    expect(latestSonnet()).toMatch(/^claude-sonnet-/);
  });
});
