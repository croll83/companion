// @vitest-environment jsdom
/**
 * The Brain section of a domain: which brain its sessions use (own choice
 * or "as in GLOBAL"), and the select that replaces it (one brain per
 * domain), turns it off or goes back to GLOBAL's. GLOBAL's brain is the
 * default for every domain and has no "inherit".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DomainBrain } from "./DomainBrain.js";
import { globalDomain, herdDomain } from "../test-fixtures/domains.js";

const brains = [{ slug: "jarvis", name: "Jarvis" }, { slug: "team", name: "Team" }];

describe("DomainBrain", () => {
  it("shows a brain inherited from GLOBAL", () => {
    render(<DomainBrain domain={herdDomain({ effectiveBrain: { slug: "jarvis", name: "Jarvis", own: false } })} brains={brains} globalBrain="Jarvis" busy={false} onChange={vi.fn()} />);
    expect(screen.getByText(/\(as in GLOBAL\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Jarvis" })).toHaveAttribute("href", "#/brains/jarvis");
    expect(screen.getByLabelText("Brain for this domain")).toHaveValue("__inherit__");
    expect(screen.getByRole("option", { name: "As in GLOBAL (Jarvis)" })).toBeInTheDocument();
    expect(screen.getByText(/choosing one replaces the current one/)).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainBrain domain={herdDomain({ brain: "team", effectiveBrain: { slug: "team", name: "Team", own: true } })} brains={brains} busy={false} onChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // Each option maps to the PATCH value: a slug, null, or "inherit".
  it("replaces, turns off and inherits the brain", () => {
    const onChange = vi.fn();
    render(<DomainBrain domain={herdDomain({ brain: "jarvis", effectiveBrain: { slug: "jarvis", name: "Jarvis", own: true } })} brains={brains} busy={false} onChange={onChange} />);
    const select = screen.getByLabelText("Brain for this domain");
    expect(select).toHaveValue("jarvis");
    expect(screen.getByRole("option", { name: "As in GLOBAL (no brain)" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "team" } });
    fireEvent.change(select, { target: { value: "__none__" } });
    fireEvent.change(select, { target: { value: "__inherit__" } });
    expect(onChange.mock.calls).toEqual([["team"], [null], ["inherit"]]);
  });

  it("for GLOBAL: default brain, no inherit", () => {
    render(<DomainBrain domain={globalDomain()} brains={brains} busy={false} onChange={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Brain" })).toHaveTextContent("No brain · default for every domain");
    expect(screen.getByLabelText("Default brain")).toHaveValue("__none__");
    expect(screen.queryByRole("option", { name: /As in GLOBAL/ })).toBeNull();
  });

  // A choice naming a brain that is gone shows as "No brain"; with no brain
  // at all, the section points to the Brains page instead of a select.
  it("handles a vanished brain and no brains", () => {
    const { unmount } = render(<DomainBrain domain={herdDomain({ brain: null })} brains={brains} busy={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Brain for this domain")).toHaveValue("__none__");
    unmount();
    render(<DomainBrain domain={herdDomain({ brain: "gone" })} brains={[]} busy={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("link", { name: "Connect one in Brains" })).toHaveAttribute("href", "#/brains");
  });
});
