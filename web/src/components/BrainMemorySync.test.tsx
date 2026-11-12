// @vitest-environment jsdom
/**
 * The Domain memory section of a brain's page: shows the domains whose memory
 * goes and the last run per domain (sent, waiting, skipped, replaced keys,
 * failures), turns the nightly send on and off, saves the schedule, limit and
 * (remote brains) ingest URL and token without ever showing a saved token,
 * removes the token, runs "Sync now" and shows the server's errors. The API
 * is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainInfo, BrainMemorySyncView } from "../api.js";

const base: BrainMemorySyncView = { config: { enabled: false, schedule: "0 3 * * *", maxFiles: 40 }, tokenConfigured: false, domains: ["jarvis", "global"], running: false };
const mockApi = vi.hoisted(() => ({
  brainMemorySync: vi.fn(),
  updateBrainMemorySync: vi.fn(),
  runBrainMemorySync: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainMemorySync, domainSummary } from "./BrainMemorySync.js";

const remote = { slug: "jarvis", kind: "remote" } as BrainInfo;
const embedded = { slug: "tac", kind: "embedded" } as BrainInfo;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainMemorySync.mockResolvedValue(base);
  mockApi.updateBrainMemorySync.mockImplementation(async (_slug: string, patch: Record<string, unknown>) => ({
    ...base,
    config: { ...base.config, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(typeof patch.ingestUrl === "string" ? { ingestUrl: patch.ingestUrl } : {}) },
    tokenConfigured: typeof patch.token === "string",
  }));
});

describe("BrainMemorySync", () => {
  it("renders the domains and says a remote brain needs its ingest URL", async () => {
    render(<BrainMemorySync brain={remote} />);
    expect(await screen.findByText("Domains: jarvis, GLOBAL")).toBeInTheDocument();
    expect(screen.getByText(/needs the ingest API URL/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByText("No run yet.")).toBeInTheDocument();
  });

  it("turns the nightly send on", async () => {
    render(<BrainMemorySync brain={embedded} />);
    fireEvent.click(await screen.findByLabelText(/Send the domains' memory/));
    await waitFor(() => expect(mockApi.updateBrainMemorySync).toHaveBeenCalledWith("tac", { enabled: true }));
    expect(await screen.findByText("Memory sync is on.")).toBeInTheDocument();
    // An embedded brain has no ingest URL or token fields.
    expect(screen.queryByLabelText(/Ingest API URL/)).toBeNull();
  });

  it("saves schedule, limit, URL and a new token, and removes a saved token", async () => {
    render(<BrainMemorySync brain={remote} />);
    fireEvent.change(await screen.findByLabelText("Schedule (cron)"), { target: { value: " 30 2 * * * " } });
    fireEvent.change(screen.getByLabelText("Files per domain and run"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Ingest API URL/), { target: { value: "http://brain:7422" } });
    fireEvent.change(screen.getByLabelText(/Token with the curator scope/), { target: { value: "brk_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory sync settings" }));
    await waitFor(() => expect(mockApi.updateBrainMemorySync).toHaveBeenCalledWith("jarvis", { schedule: "30 2 * * *", maxFiles: 10, ingestUrl: "http://brain:7422", token: "brk_1" }));
    expect(await screen.findByLabelText(/saved, leave empty to keep it/)).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
    await waitFor(() => expect(mockApi.updateBrainMemorySync).toHaveBeenLastCalledWith("jarvis", { token: null }));
  });

  it("runs Sync now and shows the last run per domain", async () => {
    mockApi.brainMemorySync.mockResolvedValue({ ...base, config: { ...base.config, enabled: true, ingestUrl: "http://brain:7422" } });
    const run = {
      at: Date.UTC(2026, 10, 12, 2),
      trigger: "manual" as const,
      ok: false,
      domains: [{
        domain: "jarvis", sent: ["a.md", "b.md"], deleted: ["c.md"], unchanged: 60, deferred: ["d.md"],
        skipped: [{ file: "s.md", reason: "brain: no" }], redacted: [{ file: "a.md", count: 2 }], failed: [{ file: "e.md", error: "HTTP 413: too big" }],
      }],
    };
    mockApi.runBrainMemorySync.mockResolvedValue({ run, memorySync: { ...base, config: { ...base.config, enabled: true, ingestUrl: "http://brain:7422" }, lastRun: run } });
    render(<BrainMemorySync brain={remote} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("3 files sent.")).toBeInTheDocument();
    expect(screen.getByText(/2 files sent, 1 deleted, 60 unchanged, 1 waiting for the next run, 1 skipped, 1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/replaced in: a.md \(2\)/)).toBeInTheDocument();
    expect(screen.getByText("e.md: HTTP 413: too big")).toBeInTheDocument();
    expect(screen.getByText("With errors")).toBeInTheDocument();
  });

  it("shows the server's errors", async () => {
    mockApi.updateBrainMemorySync.mockRejectedValueOnce(new Error("A remote brain needs the URL of its ingest API"));
    render(<BrainMemorySync brain={remote} />);
    fireEvent.click(await screen.findByLabelText(/Send the domains' memory/));
    expect(await screen.findByRole("alert")).toHaveTextContent("needs the URL of its ingest API");
  });

  it("shows a load error", async () => {
    mockApi.brainMemorySync.mockRejectedValueOnce(new Error("boom"));
    render(<BrainMemorySync brain={remote} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("summarizes a domain with nothing to send", () => {
    expect(domainSummary({ domain: "x", sent: [], deleted: [], unchanged: 3, deferred: [], skipped: [], redacted: [], failed: [] })).toBe("0 files sent, 3 unchanged");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainMemorySync brain={remote} />);
    await screen.findByText("Domains: jarvis, GLOBAL");
    expect(await axe(container)).toHaveNoViolations();
  });
});
