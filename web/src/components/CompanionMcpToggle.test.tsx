// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState } from "react";

const mockApi = vi.hoisted(() => ({ updateSettings: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { CompanionMcpToggle } from "./CompanionMcpToggle.js";

/** The toggle with its value held like SettingsPage holds it. */
function Harness({ initial = true, onChange }: { initial?: boolean; onChange?: (v: boolean) => void }) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <CompanionMcpToggle
      enabled={enabled}
      onChange={(v) => {
        setEnabled(v);
        onChange?.(v);
      }}
    />
  );
}

beforeEach(() => {
  mockApi.updateSettings.mockReset();
});

describe("CompanionMcpToggle", () => {
  // Render: a labelled switch reflecting the value, with an explanation
  // and a link to the guide.
  it("renders the switch, its state and the docs link", () => {
    render(<Harness initial={true} />);
    const toggle = screen.getByRole("switch", { name: /Companion MCP tools for sessions/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent("On");
    expect(screen.getByText(/schedule wake-ups into/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "#/docs/guides/companion-mcp");
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Harness initial={false} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // Clicking saves the new value at once and keeps what the server echoes.
  it("saves the new value when clicked", async () => {
    mockApi.updateSettings.mockResolvedValue({ companionMcpEnabled: false });
    const onChange = vi.fn();
    render(<Harness initial={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(mockApi.updateSettings).toHaveBeenCalledWith({ companionMcpEnabled: false });
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeDisabled());
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch")).toHaveTextContent("Off");
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  // A refused save must not look like a silent revert: roll back and say why.
  it("rolls back and shows the error when the save fails", async () => {
    mockApi.updateSettings.mockRejectedValue(new Error("companionMcpEnabled must be a boolean"));
    render(<Harness initial={false} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("companionMcpEnabled must be a boolean");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  // While a save is in flight the switch is disabled, so saves never overlap;
  // it is usable again once the answer arrives.
  it("blocks a second save while one is in flight", async () => {
    let resolveSave: (v: unknown) => void = () => {};
    mockApi.updateSettings.mockImplementationOnce(() => new Promise((r) => { resolveSave = r; }));
    render(<Harness initial={true} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toBeDisabled();
    fireEvent.click(screen.getByRole("switch"));
    expect(mockApi.updateSettings).toHaveBeenCalledTimes(1);
    resolveSave({ companionMcpEnabled: false });
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeDisabled());
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});
