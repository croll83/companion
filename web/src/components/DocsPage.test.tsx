// @vitest-environment jsdom
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DocsPage } from "./DocsPage.js";
import { defaultDocPath } from "../docs/registry.js";

// These tests exercise the real markdown registry (loaded via import.meta.glob)
// and the real react-markdown renderer so we validate that bundled content,
// frontmatter parsing, navigation, and routing fallbacks all work end to end.

describe("DocsPage", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  // Render test: the default (#/docs, empty path) doc resolves to the index doc,
  // its H1 heading renders, and every nav group label is present in the sidebar.
  it("renders the index doc heading and all nav groups", () => {
    render(<DocsPage docPath="" />);

    // The index doc's frontmatter title is "The Companion"; its body H1 too.
    expect(screen.getByRole("heading", { level: 1, name: "The Companion" })).toBeInTheDocument();

    // Nav groups mirror the former docs.json navigation. Scope to the sidebar
    // nav since the index body also links to some of these labels.
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(within(nav).getByText("Get Started")).toBeInTheDocument();
    expect(within(nav).getByText("Guides")).toBeInTheDocument();
    expect(within(nav).getByText("Deploy")).toBeInTheDocument();
    expect(within(nav).getByText("Reference")).toBeInTheDocument();

    // Sanity: the default path is the index doc.
    expect(defaultDocPath).toBe("index");
  });

  // Accessibility: the rendered docs page (nav + content) must have no axe violations.
  it("passes axe accessibility checks", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DocsPage docPath="guides/agents" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // Interaction: clicking a nav item points its anchor at the right hash route.
  // (App-level routing turns that hash into a new docPath; here we assert the
  // link target and that rendering with that path swaps the visible doc.)
  it("navigates between docs via nav links", () => {
    const { rerender } = render(<DocsPage docPath="" />);

    // Scope to the sidebar nav (the index body also contains an "Agents" link).
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    const agentsLink = within(nav).getByRole("link", { name: "Agents" });
    expect(agentsLink).toHaveAttribute("href", "#/docs/guides/agents");

    // Simulate the route changing to that doc (what the hashchange would produce).
    fireEvent.click(agentsLink);
    rerender(<DocsPage docPath="guides/agents" />);

    // The Agents doc heading is now shown instead of the index heading.
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
    // The active nav link is marked as the current page.
    expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  });

  // Not-found: an unknown doc path shows a "Page not found" message while the
  // navigation remains visible so the user can recover.
  it("shows a not-found message for an unknown path but keeps nav", () => {
    render(<DocsPage docPath="does/not/exist" />);

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    // Nav is still rendered.
    const nav = screen.getByRole("navigation", { name: "Documentation" });
    expect(within(nav).getByText("Guides")).toBeInTheDocument();
  });

  // Renderer coverage: render content-heavy docs so the custom markdown
  // renderers (tables, fenced code, external links) actually execute. The
  // reference page has GFM tables; chat-webhooks has fenced code + http links.
  it("renders rich markdown — tables, code blocks, and external links", () => {
    const { unmount } = render(<DocsPage docPath="reference/cli-and-api" />);
    // Table renderers (table/thead/th/td) produce a real <table>.
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(0);
    unmount();

    const main = render(<DocsPage docPath="guides/chat-webhooks" />);
    // External links go through the non-internal <a> branch (new tab).
    const externalLinks = main
      .getAllByRole("link")
      .filter((a) => a.getAttribute("target") === "_blank");
    expect(externalLinks.length).toBeGreaterThan(0);
    for (const link of externalLinks) {
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
});
