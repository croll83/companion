// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LocalBadge } from "./LocalBadge.js";

/**
 * "Local · provider/model" on a session that runs on a local provider: the
 * full badge (header) and the two-letter pill (sidebar) with the full label
 * as accessible name; a deleted provider says the session cannot start.
 */
const LOCAL = { provider: "lab", model: "my-model", providerName: "Lab", effortLevels: [] };

describe("LocalBadge", () => {
  it("renders the full label", () => {
    render(<LocalBadge local={LOCAL} />);
    expect(screen.getByText("Local · Lab/my-model")).toBeInTheDocument();
  });

  it("renders the compact pill with the full label as its name", () => {
    render(<LocalBadge local={LOCAL} compact />);
    expect(screen.getByRole("img", { name: "Local · Lab/my-model" })).toHaveTextContent("LO");
  });

  it("flags a deleted provider", () => {
    render(<LocalBadge local={{ ...LOCAL, missing: true }} />);
    expect(screen.getByTitle(/provider deleted/)).toBeInTheDocument();
  });

  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<div><LocalBadge local={LOCAL} /><LocalBadge local={LOCAL} compact /></div>);
    expect(await axe(container)).toHaveNoViolations();
  });
});
