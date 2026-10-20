// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EffortSelect } from "./EffortSelect.js";

/**
 * The effort picker of the Agents page and the Consolidation tab. Validates:
 * only the model's levels are offered, with "Default (<level>)" first when
 * asked; a level the model no longer takes stays visible as "(not supported)"
 * (and can be put back to the default); without levels the select is disabled
 * with its note (the Codex/Claude parity rule); notes are tied to the select.
 */
const LEVELS = ["low", "medium", "high"] as const;

function options() {
  return screen.getAllByRole("option").map((o) => o.textContent);
}

describe("EffortSelect", () => {
  it("renders the model's levels with the default first", () => {
    render(<EffortSelect label="Reasoning effort" levels={[...LEVELS]} value="" onChange={() => {}} defaultEffort="high" unavailableNote="none" />);
    const select = screen.getByLabelText("Reasoning effort");
    expect(select).toBeEnabled();
    expect(select).toHaveValue("");
    expect(options()).toEqual(["Default (High)", "Low", "Medium", "High"]);
  });

  it("offers no default option when none is asked, and an unknown default as plain Default", () => {
    const { rerender } = render(<EffortSelect label="E" levels={[...LEVELS]} value="high" onChange={() => {}} unavailableNote="none" />);
    expect(options()).toEqual(["Low", "Medium", "High"]);
    rerender(<EffortSelect label="E" levels={[...LEVELS]} value="" onChange={() => {}} defaultEffort={null} unavailableNote="none" />);
    expect(options()[0]).toBe("Default");
  });

  it("reports the chosen level", () => {
    const onChange = vi.fn();
    render(<EffortSelect label="E" levels={[...LEVELS]} value="" onChange={onChange} defaultEffort="high" unavailableNote="none" />);
    fireEvent.change(screen.getByLabelText("E"), { target: { value: "low" } });
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("keeps a level the model does not take visible, and lets it go back to the default", () => {
    const onChange = vi.fn();
    render(<EffortSelect label="E" levels={[...LEVELS]} value="ultra" onChange={onChange} defaultEffort="high" unavailableNote="none" />);
    expect(screen.getByLabelText("E")).toHaveValue("ultra");
    expect(options()).toContain("Ultra (not supported)");
    fireEvent.change(screen.getByLabelText("E"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("is disabled with its note when the model has no levels", () => {
    render(<EffortSelect label="E" levels={[]} value="" onChange={() => {}} defaultEffort={null} unavailableNote="This model has no effort setting." />);
    const select = screen.getByLabelText("E");
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription("This model has no effort setting.");
  });

  it("stays usable without levels when a stale level can be cleared, and disabled when it cannot", () => {
    const { rerender } = render(<EffortSelect label="E" levels={[]} value="high" onChange={() => {}} defaultEffort={null} unavailableNote="n" />);
    expect(screen.getByLabelText("E")).toBeEnabled();
    rerender(<EffortSelect label="E" levels={[]} value="high" onChange={() => {}} unavailableNote="n" />);
    expect(screen.getByLabelText("E")).toBeDisabled();
    expect(screen.getByLabelText("E")).toHaveValue("high");
  });

  it("shows an extra note", () => {
    render(<EffortSelect label="E" levels={[...LEVELS]} value="low" onChange={() => {}} unavailableNote="n" note="Runs use its default." />);
    expect(screen.getByLabelText("E")).toHaveAccessibleDescription("Runs use its default.");
  });

  it("passes axe accessibility checks, enabled and disabled", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(
      <div>
        <EffortSelect label="Agent effort" levels={[...LEVELS]} value="ultra" onChange={() => {}} defaultEffort="high" unavailableNote="n" note="A note." />
        <EffortSelect label="Codex effort" levels={[]} value="" onChange={() => {}} defaultEffort={null} unavailableNote="Effort levels unknown." />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

// An agent on a local provider: the levels are shown by the model level's name.
describe("EffortSelect with labels", () => {
  it("shows the given names", () => {
    render(<EffortSelect label="Reasoning effort" levels={["low", "high"]} value="" onChange={() => {}} defaultEffort="high" labels={{ low: "off", high: "medium" }} unavailableNote="none" />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Default (Medium)", "Off", "Medium"]);
  });
});
