// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

/**
 * A domain's default for new sessions: the Anthropic account or a local
 * provider (and model). Hidden until a local provider exists (local LLM off
 * means the list is empty), unless the domain already has a default.
 */
const mockApi = vi.hoisted(() => ({ listLocalProviders: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainLocalDefault } from "./DomainLocalDefault.js";
import type { DomainSummary } from "../api.js";

const PROVIDER = { id: "lab", name: "Lab", baseUrl: "http://p", models: ["m1"], contextWindow: 131072, effortLevels: [], createdAt: 0, updatedAt: 0, hasToken: false, health: { status: "online" } };
const domain = (over: Partial<DomainSummary> = {}) => ({ slug: "herd", name: "Herd", ...over }) as DomainSummary;

beforeEach(() => {
  mockApi.listLocalProviders.mockReset();
});

describe("DomainLocalDefault", () => {
  it("renders nothing without local providers", async () => {
    mockApi.listLocalProviders.mockResolvedValue([]);
    const { container } = render(<DomainLocalDefault domain={domain()} busy={false} onUpdate={() => {}} />);
    await waitFor(() => expect(mockApi.listLocalProviders).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("sets a provider, a provider/model, or back to Anthropic", async () => {
    mockApi.listLocalProviders.mockResolvedValue([PROVIDER]);
    const onUpdate = vi.fn();
    render(<DomainLocalDefault domain={domain()} busy={false} onUpdate={onUpdate} />);
    const select = await screen.findByRole("combobox", { name: /Default for new sessions of Herd/ });
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: "lab\u0000" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ localDefault: { provider: "lab" } });
    fireEvent.change(select, { target: { value: "lab\u0000m1" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ localDefault: { provider: "lab", model: "m1" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ localDefault: null });
  });

  it("keeps showing a default whose provider is gone", async () => {
    mockApi.listLocalProviders.mockRejectedValue(new Error("off"));
    render(<DomainLocalDefault domain={domain({ localDefault: { provider: "gone" } })} busy={false} onUpdate={() => {}} />);
    expect(await screen.findByRole("option", { name: "Local · gone (deleted)" })).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    mockApi.listLocalProviders.mockResolvedValue([PROVIDER]);
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainLocalDefault domain={domain({ localDefault: { provider: "lab", model: "m1" } })} busy={false} onUpdate={() => {}} />);
    await screen.findByRole("combobox");
    expect(await axe(container)).toHaveNoViolations();
  });
});
