// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

/**
 * The context panel's usage for a local session: the proxy's numbers for
 * this session (tokens, TTFT, duration, speed, credentials seen) instead of
 * the Anthropic cost, refreshed every 5 s; what to show when the proxy has
 * no numbers or cannot be asked; the Playground's fixed preview.
 */
const mockApi = vi.hoisted(() => ({ getLocalSessionMetrics: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { LocalSessionMetrics } from "./LocalSessionMetrics.js";
import type { LocalSessionMetricsView } from "../api.js";

const VIEW: LocalSessionMetricsView = {
  provider: { id: "lab", name: "Lab", contextWindow: 131072, health: { status: "online" } },
  model: "my-model",
  effort: "high",
  effortLabel: "medium",
  metrics: {
    requests: 3, errors: 1, inputTokens: 45_000, outputTokens: 1_200, cacheReadTokens: 30_000, totalDurationMs: 9000,
    last: { at: 1, status: 200, model: "my-model", effort: "medium", inputTokens: 15_000, outputTokens: 400, ttftMs: 2300, durationMs: 950, outputTokensPerSec: 55.5 },
    authSeen: ["authorization: proxy token"],
  },
};

beforeEach(() => {
  mockApi.getLocalSessionMetrics.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("LocalSessionMetrics", () => {
  it("renders the provider, level and the proxy's numbers", async () => {
    mockApi.getLocalSessionMetrics.mockResolvedValue(VIEW);
    render(<LocalSessionMetrics sessionId="s1" />);
    expect(await screen.findByText("Lab")).toBeInTheDocument();
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText("45.0k")).toBeInTheDocument();
    expect(screen.getByText("2.3 s")).toBeInTheDocument();
    expect(screen.getByText("950 ms")).toBeInTheDocument();
    expect(screen.getByText("55.5 tok/s")).toBeInTheDocument();
    expect(screen.getByText("30.0k")).toBeInTheDocument();
    expect(screen.getByText(/Credentials the proxy received from the CLI.*proxy token/)).toBeInTheDocument();
  });

  it("refreshes every 5 seconds", async () => {
    vi.useFakeTimers();
    mockApi.getLocalSessionMetrics.mockResolvedValue(VIEW);
    render(<LocalSessionMetrics sessionId="s1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(mockApi.getLocalSessionMetrics).toHaveBeenCalledTimes(2);
  });

  it("explains missing numbers: none yet, proxy unreachable, request failed", async () => {
    mockApi.getLocalSessionMetrics.mockResolvedValueOnce({ ...VIEW, metrics: null, effort: null, provider: { id: "gone", missing: true } });
    const { unmount } = render(<LocalSessionMetrics sessionId="s1" />);
    expect(await screen.findByText(/No request yet/)).toBeInTheDocument();
    expect(screen.getByText("deleted")).toBeInTheDocument();
    unmount();
    mockApi.getLocalSessionMetrics.mockResolvedValueOnce({ ...VIEW, metrics: null, metricsError: "the proxy answered HTTP 401", provider: { id: "lab", health: { status: "offline" } } });
    const second = render(<LocalSessionMetrics sessionId="s1" />);
    expect(await screen.findByText(/numbers are unavailable: the proxy answered HTTP 401/)).toBeInTheDocument();
    second.unmount();
    mockApi.getLocalSessionMetrics.mockRejectedValueOnce(new Error("Not a local session"));
    render(<LocalSessionMetrics sessionId="s1" />);
    expect(await screen.findByText(/Local metrics unavailable: Not a local session/)).toBeInTheDocument();
  });

  it("shows a fixed preview without fetching (Playground)", () => {
    render(<LocalSessionMetrics sessionId="s1" preview={{ ...VIEW, metrics: { ...VIEW.metrics!, last: { ...VIEW.metrics!.last!, ttftMs: undefined, outputTokensPerSec: undefined }, cacheReadTokens: 0 } }} />);
    expect(screen.getByText("Lab")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(mockApi.getLocalSessionMetrics).not.toHaveBeenCalled();
  });

  it("passes axe accessibility checks", async () => {
    mockApi.getLocalSessionMetrics.mockResolvedValue(VIEW);
    const { axe } = await import("vitest-axe");
    const { container } = render(<LocalSessionMetrics sessionId="s1" />);
    await screen.findByText("Lab");
    expect(await axe(container)).toHaveNoViolations();
  });
});
