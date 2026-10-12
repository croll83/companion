// @vitest-environment jsdom
/**
 * The skills view of a domain: the domain's own skills (create, remove with
 * confirmation), and the groups of skills installed outside it, with a group
 * switch (mixed when partly on; dropping single choices asks first) and one
 * switch per skill with Reset; one of your skills can be kept for this
 * domain only.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainSkills } from "./DomainSkills.js";
import { globalDomain, herdDomain, skillGroups } from "../test-fixtures/domains.js";

function setup(over: Partial<Parameters<typeof DomainSkills>[0]> = {}) {
  const props = {
    domain: herdDomain(),
    groups: skillGroups,
    busy: false,
    onPatch: vi.fn(),
    onCreateSkill: vi.fn(async () => true),
    onRemoveSkill: vi.fn(async () => true),
    ...over,
  };
  render(<DomainSkills {...props} />);
  return props;
}

describe("DomainSkills", () => {
  it("renders the domain's skills and the groups with how many are on", () => {
    setup();
    expect(screen.getByText("herd-hello")).toBeInTheDocument();
    expect(screen.getByText("Say hello to the herd")).toBeInTheDocument();
    // Your skills: 1 of 2 on -> mixed.
    expect(screen.getByRole("switch", { name: "Skill group Your skills" })).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText(/1\/2 on · Codex too · as in GLOBAL/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Skill group claude.ai skills" })).toHaveAttribute("aria-checked", "false");
  });

  it("passes axe accessibility scan with a group open and the new-skill form", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <DomainSkills domain={herdDomain()} groups={skillGroups} busy={false} onPatch={vi.fn()} onCreateSkill={vi.fn(async () => true)} onRemoveSkill={vi.fn(async () => true)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches and resets single skills, and keeps one of your skills for this domain only", () => {
    const p = setup();
    // Groups are open: every skill has its own switch right away.
    expect(screen.getByText("Write a Foundry PoC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Skill foundry-poc" }));
    expect(p.onPatch).toHaveBeenCalledWith("herd", { skillChoices: { "user:foundry-poc": false } });
    fireEvent.click(screen.getByRole("button", { name: "Reset skill ton-audit" }));
    expect(p.onPatch).toHaveBeenCalledWith("herd", { skillChoices: { "user:ton-audit": null } });
    fireEvent.click(screen.getByRole("button", { name: "Only here" }));
    expect(screen.getByText(/off in GLOBAL \(every domain without its own choice\) and on here/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Only here" })[1]);
    expect(p.onPatch).toHaveBeenCalledWith("global", { skillChoices: { "user:foundry-poc": false } });
    expect(p.onPatch).toHaveBeenCalledWith("herd", { skillChoices: { "user:foundry-poc": true } });
  });

  // The single skills are shown from the start; a group can still be folded.
  it("shows every group open with one switch per skill, and folds a group", () => {
    setup();
    expect(screen.getByRole("switch", { name: "Skill foundry-poc" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Skill pdf" })).toBeInTheDocument();
    const header = screen.getByRole("button", { name: /Your skills/ });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Skill foundry-poc" })).toBeNull();
  });

  it("asks before a group switch drops single choices, and switches a group without any directly", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("switch", { name: "Skill group Your skills" }));
    expect(p.onPatch).not.toHaveBeenCalled();
    expect(screen.getByText(/Turn every skill on and drop 1 single choice\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("switch", { name: "Skill group Your skills" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(p.onPatch).toHaveBeenCalledWith("herd", { skillGroups: { user: true }, skillChoices: { "user:ton-audit": null } });
    fireEvent.click(screen.getByRole("switch", { name: "Skill group claude.ai skills" }));
    expect(p.onPatch).toHaveBeenCalledWith("herd", { skillGroups: { "claude-ai": true } });
  });

  it("creates a skill of the domain and removes one after confirmation", async () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    const form = screen.getByRole("form", { name: "New skill" });
    fireEvent.submit(form);
    expect(p.onCreateSkill).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(/Name/), { target: { value: " deploy-check " } });
    fireEvent.change(within(form).getByLabelText("When the model should use it"), { target: { value: " Before merging " } });
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(p.onCreateSkill).toHaveBeenCalledWith("herd", "deploy-check", "Before merging"));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New skill" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Remove skill herd-hello" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(p.onRemoveSkill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove skill herd-hello" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(p.onRemoveSkill).toHaveBeenCalledWith("herd", "herd-hello"));
  });

  it("keeps the form open when creation fails, and cancels it", async () => {
    const p = setup({ onCreateSkill: vi.fn(async () => false) });
    fireEvent.click(screen.getByRole("button", { name: "New skill" }));
    const form = screen.getByRole("form", { name: "New skill" });
    fireEvent.change(within(form).getByLabelText(/Name/), { target: { value: "x" } });
    fireEvent.change(within(form).getByLabelText("When the model should use it"), { target: { value: "y" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(p.onCreateSkill).toHaveBeenCalled());
    expect(screen.getByRole("form", { name: "New skill" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New skill" })).toBeNull();
  });

  it("for GLOBAL: its own skills section, no 'Only here', and empty groups", () => {
    setup({ domain: globalDomain({ ownSkills: [] }), groups: [...skillGroups, { id: "design", label: "Design skills", description: "d", skills: [], descriptions: {}, codex: "toggled" }] });
    expect(screen.getByText(/GLOBAL's skills/)).toBeInTheDocument();
    expect(screen.getByText(/None yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Only here" })).toBeNull();
    expect(screen.getByText("No skills in this group.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Skill group Design skills" })).toBeDisabled();
  });
});
