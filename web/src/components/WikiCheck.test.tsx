// @vitest-environment jsdom
/**
 * The wiki check of an embedded brain: the lint as sentences with fix
 * buttons. Validates that it runs on demand (or at once after an adoption),
 * shows problems and suggestions with their files, applies a fix through the
 * API and shows the new state and what was done, says so when nothing is
 * wrong, and reports API errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainLintView } from "../api.js";

const mockApi = vi.hoisted(() => ({ brainLint: vi.fn(), fixBrainLint: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { WikiCheck } from "./WikiCheck.js";

const messy: BrainLintView = {
  ok: false,
  errors: 3,
  warnings: 1,
  pages: 12,
  advice: [
    { id: "taxonomy-missing", level: "error", sentence: "SCHEMA.md has no tag taxonomy, so the tags of the pages cannot be checked.", paths: ["SCHEMA.md"], count: 1, fix: { id: "add-taxonomy", label: "Add the tag taxonomy section" } },
    { id: "links-broken", level: "error", sentence: "2 pages have broken [[links]].", paths: ["concepts/a.md", "concepts/b.md"], count: 2 },
    { id: "stubs", level: "warn", sentence: "One page is very short (under 80 words).", paths: ["concepts/c.md"], count: 1 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainLint.mockResolvedValue(messy);
  mockApi.fixBrainLint.mockResolvedValue({ done: "Tag taxonomy added to SCHEMA.md (4 tags)", lint: { ...messy, errors: 2, advice: messy.advice.slice(1) } });
});

describe("WikiCheck", () => {
  it("renders the check button and runs the lint on demand", async () => {
    render(<WikiCheck slug="work" />);
    expect(screen.getByRole("region", { name: "Wiki check" })).toBeInTheDocument();
    expect(mockApi.brainLint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check the wiki" }));
    expect(await screen.findByText("12 pages · 3 problems · 1 suggestion")).toBeInTheDocument();
    expect(screen.getByText(/2 pages have broken/)).toBeInTheDocument();
    expect(screen.getByText("Files (2)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<WikiCheck slug="work" autoRun />);
    await screen.findByText(/no tag taxonomy/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("applies a fix and shows what was done and the new state", async () => {
    const onFixed = vi.fn();
    render(<WikiCheck slug="work" autoRun onFixed={onFixed} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add the tag taxonomy section" }));
    await waitFor(() => expect(mockApi.fixBrainLint).toHaveBeenCalledWith("work", "add-taxonomy"));
    expect(await screen.findByRole("status")).toHaveTextContent("Tag taxonomy added to SCHEMA.md (4 tags).");
    expect(screen.queryByText(/no tag taxonomy/)).toBeNull();
    expect(onFixed).toHaveBeenCalled();
  });

  it("says when the wiki is clean", async () => {
    mockApi.brainLint.mockResolvedValueOnce({ ok: true, errors: 0, warnings: 0, pages: 5, advice: [] });
    render(<WikiCheck slug="work" autoRun />);
    expect(await screen.findByText("The wiki follows its rules: nothing to fix (5 pages).")).toBeInTheDocument();
  });

  it("shows API errors, for the check and for a fix", async () => {
    mockApi.brainLint.mockRejectedValueOnce(new Error("The brain is not running: start it first"));
    render(<WikiCheck slug="work" autoRun />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not running");
    mockApi.fixBrainLint.mockRejectedValueOnce(new Error("Unknown fix"));
    fireEvent.click(screen.getByRole("button", { name: "Check the wiki" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add the tag taxonomy section" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown fix");
  });
});
