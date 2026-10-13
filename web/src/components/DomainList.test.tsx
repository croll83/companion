// @vitest-environment jsdom
/**
 * The list of domains: one compact row per domain linking to it (name,
 * description, sessions, MCP / skills / plugins counts, a dot when a server
 * waits for sign-in or mcp.json is broken), the selected one marked, and
 * "New domain".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainList, domainCounts } from "./DomainList.js";
import { globalDomain, herdDomain, plugins, skillGroups } from "../test-fixtures/domains.js";

function setup(onCreate = vi.fn(async () => true)) {
  render(<DomainList domains={[globalDomain(), herdDomain()]} groups={skillGroups} plugins={plugins} selected="herd" busy={false} onCreate={onCreate} />);
  return onCreate;
}

describe("DomainList", () => {
  it("renders a row per domain linking to it, with its counts", () => {
    setup();
    const herd = screen.getByRole("link", { name: /Herd/ });
    expect(herd).toHaveAttribute("href", "#/domains/herd");
    expect(herd).toHaveAttribute("aria-current", "page");
    expect(within(herd).getByText("The herd project")).toBeInTheDocument();
    expect(within(herd).getByText("2 sessions")).toBeInTheDocument();
    // 2 of 4 servers on, 1+0 group skills + 1 own skill of 4, 1 plugin.
    expect(within(herd).getByText("MCP 2/4 · Skills 2/4 · Plugins 1")).toBeInTheDocument();
    expect(within(herd).getByTitle(/Needs attention/)).toBeInTheDocument();
    const global = screen.getByRole("link", { name: /GLOBAL/ });
    expect(global).not.toHaveAttribute("aria-current");
    expect(within(global).queryByTitle(/Needs attention/)).toBeNull();
  });

  // The row says which brain the domain uses (own or GLOBAL's).
  it("shows the domain's brain in its counts", () => {
    render(<DomainList domains={[herdDomain({ effectiveBrain: { slug: "jarvis", name: "Jarvis", own: false } })]} groups={skillGroups} plugins={plugins} busy={false} onCreate={vi.fn(async () => true)} />);
    expect(screen.getByText("MCP 2/4 · Skills 2/4 · Plugins 1 · Brain Jarvis")).toBeInTheDocument();
  });

  it("passes axe accessibility scan with the new-domain form open", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainList domains={[globalDomain()]} groups={skillGroups} plugins={plugins} busy={false} onCreate={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "New domain" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("creates a domain, closing the form only when it was created", async () => {
    const onCreate = setup(vi.fn(async () => false));
    fireEvent.click(screen.getByRole("button", { name: "New domain" }));
    const form = screen.getByRole("form", { name: "New domain" });
    fireEvent.submit(form);
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " Satoshi " } });
    fireEvent.change(within(form).getByLabelText("What it is about (optional)"), { target: { value: " The boat " } });
    fireEvent.click(within(form).getByRole("button", { name: "Create domain" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Satoshi", "The boat"));
    expect(screen.getByRole("form", { name: "New domain" })).toBeInTheDocument();
    onCreate.mockResolvedValue(true);
    fireEvent.change(within(form).getByLabelText("What it is about (optional)"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create domain" }));
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith("Satoshi", undefined));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New domain" })).toBeNull());
  });

  it("cancels the new-domain form", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New domain" })).toBeNull();
  });

  it("counts a domain without per-group states as all on, and flags a broken mcp.json", () => {
    const c = domainCounts(globalDomain({ skillGroupStates: {}, mcpError: "bad", ownSkills: undefined as never }), skillGroups, plugins);
    expect(c.skillOn).toBe(3);
    expect(c.skillTotal).toBe(3);
    expect(c.attention).toBe(true);
    expect(c.pluginsOn).toEqual([]);
  });
});
