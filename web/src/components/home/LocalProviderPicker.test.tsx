// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LocalProviderPicker, defaultModelOf } from "./LocalProviderPicker.js";
import type { LocalProviderView } from "../../api.js";

/**
 * Home → "Local": which provider and model a new session runs on; a provider
 * that is offline, or has no model yet, is flagged before the session starts.
 */
function provider(over: Partial<LocalProviderView> = {}): LocalProviderView {
  return {
    id: "lab", name: "Lab", baseUrl: "http://proxy.example:8787", models: ["a", "b"], contextWindow: 131072,
    effortLevels: ["low", "high"], createdAt: 0, updatedAt: 0, hasToken: true, health: { status: "online" }, ...over,
  };
}

describe("LocalProviderPicker", () => {
  it("renders the provider and model selects", () => {
    render(<LocalProviderPicker providers={[provider()]} value={{ provider: "lab", model: "b" }} onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Local provider" })).toHaveValue("lab");
    expect(screen.getByRole("combobox", { name: "Local model" })).toHaveValue("b");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("switches provider (with its default model) and model", () => {
    const onChange = vi.fn();
    const other = provider({ id: "other", name: "Other", models: ["x", "y"], defaultModel: "y" });
    render(<LocalProviderPicker providers={[provider(), other]} value={{ provider: "lab", model: "a" }} onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Local provider" }), { target: { value: "other" } });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "other", model: "y" });
    fireEvent.change(screen.getByRole("combobox", { name: "Local model" }), { target: { value: "b" } });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "lab", model: "b" });
  });

  it("warns about an offline provider and one without models", () => {
    const { rerender } = render(
      <LocalProviderPicker providers={[provider({ health: { status: "offline", error: "ECONNREFUSED" } })]} value={{ provider: "lab", model: "a" }} onChange={() => {}} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Lab is offline (ECONNREFUSED)");
    expect(screen.getByRole("option", { name: "Lab (offline)" })).toBeInTheDocument();
    rerender(<LocalProviderPicker providers={[provider({ models: [] })]} value={{ provider: "lab", model: "" }} onChange={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("has no model yet");
    expect(screen.getByRole("combobox", { name: "Local model" })).toBeDisabled();
  });

  it("picks the default model, else the first", () => {
    expect(defaultModelOf(provider({ defaultModel: "b" }))).toBe("b");
    expect(defaultModelOf(provider())).toBe("a");
    expect(defaultModelOf(undefined)).toBe("");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <LocalProviderPicker providers={[provider({ health: { status: "offline" } })]} value={{ provider: "lab", model: "a" }} onChange={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
