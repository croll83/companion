// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentPermissionPill } from "./AgentPermissionPill.js";

// The permissions control of both agent editors. Claude agents always run
// with bypassPermissions (unattended runs cannot answer approval prompts), so
// it is a fixed badge; for Codex the choice is the sandbox mode.

describe("AgentPermissionPill", () => {
  it("renders a fixed Full permissions badge for Claude, with no picker", () => {
    render(<AgentPermissionPill backendType="claude" permissionMode="default" onChange={vi.fn()} />);
    const badge = screen.getByTestId("claude-full-permissions");
    expect(badge).toHaveTextContent("Full permissions");
    expect(badge.getAttribute("title")).toMatch(/bypassPermissions/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the selected Codex mode and changes it from the dropdown", () => {
    const onChange = vi.fn();
    render(<AgentPermissionPill backendType="codex" permissionMode="bypassPermissions" onChange={onChange} />);
    const pill = screen.getByRole("button", { name: /Full Auto/ });
    expect(pill).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));

    expect(onChange).toHaveBeenCalledWith("default");
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("falls back to the first Codex mode for an unknown value", () => {
    render(<AgentPermissionPill backendType="codex" permissionMode="acceptEdits" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Full Auto/ })).toBeInTheDocument();
  });

  it("closes the dropdown on a click outside it", () => {
    render(
      <div>
        <span>outside</span>
        <AgentPermissionPill backendType="codex" permissionMode="default" onChange={vi.fn()} />
      </div>,
    );
    const pill = screen.getByRole("button", { name: /Supervised/ });
    fireEvent.click(pill);
    expect(screen.getAllByText("Supervised")).toHaveLength(2);

    fireEvent.mouseDown(pill.parentElement!);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("passes axe accessibility checks for both backends", async () => {
    const { axe } = await import("vitest-axe");
    const claude = render(<AgentPermissionPill backendType="claude" permissionMode="" onChange={vi.fn()} />);
    expect(await axe(claude.container)).toHaveNoViolations();
    claude.unmount();

    const codex = render(<AgentPermissionPill backendType="codex" permissionMode="default" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Supervised/ }));
    expect(await axe(codex.container)).toHaveNoViolations();
  });
});
