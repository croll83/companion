// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

/**
 * The local providers (Companion LLM proxies) of Settings: the list with its
 * health, add/edit (the token is write-only), "Test" filling models, window
 * and levels from the proxy, refresh and delete; and the form's parsing of
 * the "claude effort=model level" list.
 */
const mockApi = vi.hoisted(() => ({
  listLocalProviders: vi.fn(),
  createLocalProvider: vi.fn(),
  updateLocalProvider: vi.fn(),
  deleteLocalProvider: vi.fn(),
  testLocalProvider: vi.fn(),
  refreshLocalProvider: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { LocalProvidersSettings, inputOf, parseLevels } from "./LocalProvidersSettings.js";
import type { LocalProviderView } from "../api.js";

const PROVIDER: LocalProviderView = {
  id: "lab", name: "Lab", baseUrl: "http://proxy.example:8787", models: ["my-model"], contextWindow: 131072,
  effortLevels: ["low", "high"], effortLabels: { low: "off", high: "medium" }, defaultEffort: "high",
  createdAt: 0, updatedAt: 0, hasToken: true, health: { status: "offline", error: "ECONNREFUSED" },
};

beforeEach(() => {
  for (const f of Object.values(mockApi)) f.mockReset();
  mockApi.listLocalProviders.mockResolvedValue([PROVIDER]);
});

describe("LocalProvidersSettings", () => {
  it("lists the providers with their health, models and levels", async () => {
    render(<LocalProvidersSettings />);
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("Lab")).toBeInTheDocument();
    expect(within(item).getByText("offline")).toBeInTheDocument();
    expect(item).toHaveTextContent("my-model · 128k context · levels off/medium · token saved · ECONNREFUSED");
  });

  it("adds a provider after a Test that fills models, window and levels", async () => {
    mockApi.listLocalProviders.mockResolvedValue([]);
    mockApi.testLocalProvider.mockResolvedValue({
      ok: true, viaProxy: true, latencyMs: 12, models: ["my-model"], contextWindow: 65536,
      effort: { default: "high", levels: [{ name: "off", claude: "low" }, { name: "high", claude: "high" }] },
    });
    mockApi.createLocalProvider.mockResolvedValue(PROVIDER);
    render(<LocalProvidersSettings />);
    expect(await screen.findByText("No local provider yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add local provider" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lab" } });
    fireEvent.change(screen.getByLabelText("Proxy URL"), { target: { value: "http://proxy.example:8787" } });
    fireEvent.change(screen.getByLabelText("Proxy token"), { target: { value: "secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Online (Companion LLM proxy) · 1 model(s) in 12 ms: my-model");
    expect(mockApi.testLocalProvider).toHaveBeenCalledWith({ baseUrl: "http://proxy.example:8787", token: "secret-token", id: undefined });
    expect(screen.getByLabelText("Models")).toHaveValue("my-model");
    expect(screen.getByLabelText("Context window (tokens)")).toHaveValue(65536);
    expect(screen.getByLabelText("Reasoning levels")).toHaveValue("low=off, high");
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(mockApi.createLocalProvider).toHaveBeenCalledWith({
      name: "Lab", baseUrl: "http://proxy.example:8787", token: "secret-token", models: ["my-model"], modelsManual: false,
      defaultModel: null, contextWindow: 65536, effortLevels: ["low", "high"], effortLabels: { low: "off", high: "high" }, defaultEffort: "high",
    }));
    expect(mockApi.listLocalProviders).toHaveBeenCalledTimes(2);
  });

  it("shows a failed test and a refused save", async () => {
    mockApi.testLocalProvider.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" }).mockRejectedValueOnce(new Error("boom"));
    mockApi.updateLocalProvider.mockRejectedValue(new Error("Invalid base URL"));
    render(<LocalProvidersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Lab" }));
    // The token is never shown: an empty field that keeps the saved one.
    expect(screen.getByLabelText("Proxy token")).toHaveValue("");
    expect(screen.getByLabelText("Proxy token")).toHaveAttribute("placeholder", "Saved — type to replace");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Not reachable: ECONNREFUSED")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Not reachable: boom")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove the saved token"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid base URL");
    expect(mockApi.updateLocalProvider).toHaveBeenCalledWith("lab", expect.objectContaining({ token: "" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("refreshes from the proxy and deletes after confirmation", async () => {
    mockApi.refreshLocalProvider.mockResolvedValueOnce({ ok: true, provider: PROVIDER }).mockResolvedValueOnce({ ok: false, error: "down", provider: PROVIDER });
    mockApi.deleteLocalProvider.mockRejectedValue(new Error("2 running session(s) use this provider"));
    render(<LocalProvidersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh Lab from its proxy" }));
    expect(await screen.findByText("Lab: 1 model(s), 2 level(s)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Lab from its proxy" }));
    expect(await screen.findByText("Lab: down")).toBeInTheDocument();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete Lab" }));
    expect(mockApi.deleteLocalProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Lab" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2 running session(s)");
    confirm.mockRestore();
  });

  it("reports a list that cannot be read", async () => {
    mockApi.listLocalProviders.mockRejectedValue(new Error("unauthorized"));
    render(<LocalProvidersSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("unauthorized");
  });

  it("passes axe accessibility checks with the form open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<LocalProvidersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Lab" }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("form parsing", () => {
  it("parses claude effort=model level pairs", () => {
    expect(parseLevels("low=off, medium , xhigh=deep,")).toEqual([["low", "off"], ["medium", "medium"], ["xhigh", "deep"]]);
  });

  it("builds the request, keeping or clearing the token", () => {
    const form = {
      name: " Lab ", baseUrl: " http://p ", token: "", clearToken: false, models: "a b,c", modelsManual: true,
      defaultModel: "a", contextWindow: "65536", levels: "low=off", defaultEffort: "", 
    };
    expect(inputOf(form, true)).toEqual({
      name: "Lab", baseUrl: "http://p", models: ["a", "b", "c"], modelsManual: true, defaultModel: "a",
      contextWindow: 65536, effortLevels: ["low"], effortLabels: { low: "off" }, defaultEffort: null,
    });
    expect(inputOf({ ...form, clearToken: true }, true)).toMatchObject({ token: "" });
    expect(inputOf({ ...form, clearToken: true }, false)).not.toHaveProperty("token");
  });
});
