// @vitest-environment jsdom
/**
 * The skill of a brain: the generated SKILL.md shown as a preview, or a
 * custom text edited in place. Save appears only when something changed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainSkill } from "./BrainSkill.js";
import { jarvisBrain } from "../test-fixtures/brains.js";

describe("BrainSkill", () => {
  it("shows the generated skill as a preview, without a save button", () => {
    render(<BrainSkill brain={jarvisBrain()} busy={false} onSave={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Skill · jarvis-brain" })).toBeInTheDocument();
    expect(screen.getByLabelText("Generated skill")).toHaveTextContent("name: jarvis-brain");
    expect(screen.queryByRole("button", { name: "Save skill" })).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainSkill brain={jarvisBrain({ skill: { source: "custom", custom: "Body" } })} busy={false} onSave={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches to a custom text and saves it", () => {
    const onSave = vi.fn(async () => true);
    render(<BrainSkill brain={jarvisBrain()} busy={false} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Custom text"));
    const save = screen.getByRole("button", { name: "Save skill" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/SKILL.md body/), { target: { value: "Use the tools." } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ source: "custom", custom: "Use the tools." });
  });

  // From custom back to generated: the old preview is stale, so a hint replaces it.
  it("goes back to the generated skill", () => {
    const onSave = vi.fn(async () => true);
    render(<BrainSkill brain={jarvisBrain({ skill: { source: "custom", custom: "Body" } })} busy={false} onSave={onSave} />);
    expect(screen.getByLabelText(/SKILL.md body/)).toHaveValue("Body");
    fireEvent.click(screen.getByLabelText("Generated from the about text"));
    expect(screen.getByText(/Save to switch back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect(onSave).toHaveBeenCalledWith({ source: "generated" });
  });
});
