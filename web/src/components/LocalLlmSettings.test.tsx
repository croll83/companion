// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";

/**
 * Settings → Providers → "Enable local LLM": off by default; on, the local
 * providers appear (and with them the "Local" choice elsewhere). Saved at
 * once; a refused save rolls back with the reason. The link opens the guide.
 */
const mockApi = vi.hoisted(() => ({ updateSettings: vi.fn(), listLocalProviders: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { LocalLlmSettings, LOCAL_LLM_DOC_URL } from "./LocalLlmSettings.js";

function Harness({ initial = false }: { initial?: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  return <LocalLlmSettings enabled={enabled} onChange={setEnabled} />;
}

beforeEach(() => {
  mockApi.updateSettings.mockReset();
  mockApi.listLocalProviders.mockReset().mockResolvedValue([]);
});

describe("LocalLlmSettings", () => {
  it("renders the switch off, the guide link, and no providers", () => {
    render(<Harness />);
    expect(screen.getByRole("switch", { name: /Enable local LLM/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", LOCAL_LLM_DOC_URL);
    expect(screen.queryByRole("button", { name: "Add local provider" })).not.toBeInTheDocument();
  });

  it("turns it on: saves and shows the providers", async () => {
    mockApi.updateSettings.mockResolvedValue({ localLlmEnabled: true });
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch", { name: /Enable local LLM/ }));
    expect(mockApi.updateSettings).toHaveBeenCalledWith({ localLlmEnabled: true });
    expect(await screen.findByRole("button", { name: "Add local provider" })).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("rolls back and says why when the save fails", async () => {
    mockApi.updateSettings.mockRejectedValue(new Error("disk full"));
    render(<Harness initial />);
    fireEvent.click(screen.getByRole("switch", { name: /Enable local LLM/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    await waitFor(() => expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true"));
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Harness initial />);
    await screen.findByRole("button", { name: "Add local provider" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
