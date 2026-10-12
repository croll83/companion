// @vitest-environment jsdom
/**
 * DomainPlugins lists the user's installed Claude Code plugins in a domain's
 * card, each with an on/off switch for that domain, what it brings (skills,
 * MCP servers) and whether the state is the domain's own choice or inherited
 * (from GLOBAL, or for GLOBAL from the user's Claude settings).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainPlugins } from "./DomainPlugins.js";

const brain = {
  id: "hercle-brain@hercle-lab", name: "hercle-brain", marketplace: "hercle-lab", version: "0.1.4",
  description: "Hercle AI Brain", skills: ["hercle-brain"],
  mcpServers: [{ name: "hercle-brain", type: "http", target: "http://127.0.0.1:7420/mcp" }], enabledByUser: false,
};
const bare = { id: "bare", name: "bare", marketplace: "", skills: ["a", "b"], mcpServers: [], enabledByUser: true };

describe("DomainPlugins", () => {
  it("renders each plugin with what it brings and its state", () => {
    render(
      <DomainPlugins
        plugins={[brain, bare]}
        states={{ [brain.id]: { on: true, own: true } }}
        isGlobal={false}
        busy={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: "Plugin hercle-brain" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/hercle-lab · v0\.1\.4 · 1 skill · MCP: hercle-brain/)).toBeInTheDocument();
    expect(screen.getByText("Hercle AI Brain")).toBeInTheDocument();
    // No state from the server: the user's settings decide, shown as inherited.
    expect(screen.getByRole("switch", { name: "Plugin bare" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/2 skills · as in GLOBAL/)).toBeInTheDocument();
    expect(screen.getByText(/Codex sessions get each plugin's MCP servers and skills/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DomainPlugins plugins={[brain]} states={{}} isGlobal busy={false} onToggle={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
    // For GLOBAL, the inherited state comes from the user's Claude settings.
    expect(screen.getByText(/as in your Claude settings/)).toBeInTheDocument();
  });

  it("turns a plugin on or off for the domain", () => {
    const onToggle = vi.fn();
    render(<DomainPlugins plugins={[brain]} states={{ [brain.id]: { on: false, own: false } }} isGlobal={false} busy={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("switch", { name: "Plugin hercle-brain" }));
    expect(onToggle).toHaveBeenCalledWith("hercle-brain@hercle-lab", true);
  });

  it("disables the switches while a change is saving", () => {
    render(<DomainPlugins plugins={[brain]} states={{}} isGlobal={false} busy onToggle={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Plugin hercle-brain" })).toBeDisabled();
  });

  it("explains how to install a plugin when there is none", () => {
    render(<DomainPlugins plugins={[]} states={{}} isGlobal={false} busy={false} onToggle={vi.fn()} />);
    expect(screen.getByText(/No plugins installed/)).toBeInTheDocument();
    expect(screen.queryByText(/Codex sessions get/)).toBeNull();
  });
});
