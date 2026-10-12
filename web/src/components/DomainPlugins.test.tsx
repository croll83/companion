// @vitest-environment jsdom
/**
 * The plugins view of a domain: each installed plugin switched on/off for
 * the domain (or reset to GLOBAL's choice / the user's Claude settings),
 * what it brings, and the same switch for every other domain.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainPlugins } from "./DomainPlugins.js";
import { globalDomain, herdDomain, plugins } from "../test-fixtures/domains.js";

function setup(over: Partial<Parameters<typeof DomainPlugins>[0]> = {}) {
  const props = { domain: herdDomain(), domains: [globalDomain(), herdDomain()], plugins, busy: false, onSetPlugin: vi.fn(), ...over };
  render(<DomainPlugins {...props} />);
  return props;
}

describe("DomainPlugins", () => {
  it("renders each plugin with what it brings and the domain's own choice", () => {
    setup();
    expect(screen.getByRole("switch", { name: "Plugin hercle-brain" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/hercle-lab · v0\.1\.4 · 1 skill · 1 MCP/)).toBeInTheDocument();
    expect(screen.getByText("On here")).toBeInTheDocument();
    expect(screen.getByText(/commands, agents and hooks require Claude Code/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan with the details open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainPlugins domain={herdDomain()} domains={[globalDomain(), herdDomain()]} plugins={plugins} busy={false} onSetPlugin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Details of hercle-brain" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches, resets, and switches it for another domain from the details", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Plugin hercle-brain" }));
    expect(p.onSetPlugin).toHaveBeenCalledWith("herd", "hercle-brain@hercle-lab", false);
    fireEvent.click(screen.getByRole("button", { name: "Reset hercle-brain to GLOBAL's choice" }));
    expect(p.onSetPlugin).toHaveBeenCalledWith("herd", "hercle-brain@hercle-lab", null);
    fireEvent.click(screen.getByRole("button", { name: "Details of hercle-brain" }));
    expect(screen.getByText("Hercle AI Brain")).toBeInTheDocument();
    expect(screen.getByText(/hercle-brain \(http\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "hercle-brain in GLOBAL" }));
    expect(p.onSetPlugin).toHaveBeenCalledWith("global", "hercle-brain@hercle-lab", true);
  });

  it("shows inherited states: as in GLOBAL, and for GLOBAL as in the Claude settings", () => {
    setup({ domain: herdDomain({ pluginStates: {} }) });
    expect(screen.getByText("As in GLOBAL")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Plugin hercle-brain" })).toHaveAttribute("aria-checked", "false");
  });

  it("for GLOBAL, follows the user's Claude settings, and explains how to install when there is none", () => {
    const { unmount } = render(<DomainPlugins domain={globalDomain()} domains={[globalDomain()]} plugins={plugins} busy={false} onSetPlugin={vi.fn()} />);
    expect(screen.getByText("As in your Claude settings")).toBeInTheDocument();
    unmount();
    render(<DomainPlugins domain={globalDomain()} domains={[]} plugins={[]} busy={false} onSetPlugin={vi.fn()} />);
    expect(screen.getByText(/No plugins installed/)).toBeInTheDocument();
  });
});
