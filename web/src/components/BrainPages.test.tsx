// @vitest-environment jsdom
/**
 * The Pages tab of an embedded brain. Validates the list, the search, the
 * navigation files, reading a page with its metadata, following a [[link]]
 * inside the tab, and above all that page text is DATA: markdown is
 * rendered, raw HTML never (a <script> or <img onerror> in a page must not
 * become an element).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrainPageDoc } from "../api.js";

const mockApi = vi.hoisted(() => ({ brainPages: vi.fn(), brainPage: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainPages, linkWikiLinks, stripFrontmatter } from "./BrainPages.js";

const billing: BrainPageDoc = {
  slug: "billing-service",
  path: "entities/billing-service.md",
  title: "Billing Service",
  type: "entity",
  tags: ["billing"],
  updated: "2026-09-15",
  sources: ["raw/notes/components.md"],
  markdown: "---\ntitle: Billing Service\n---\n# Billing Service\n\nDeployed by the [[deploy-pipeline|pipeline]].\n\n<script>window.hacked = 1</script>\n<img src=x onerror=\"window.hacked = 2\">\n\n**Bold** text.\n",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainPages.mockImplementation(async (_slug: string, q = "") => ({
    pages: q ? [{ slug: "billing-service", path: "entities/billing-service.md", title: "Billing Service", type: "entity", tags: ["billing"], updated: null, snippet: "reads invoices from the queue" }]
      : [
        { slug: "billing-service", path: "entities/billing-service.md", title: "Billing Service", type: "entity", tags: ["billing"], updated: null },
        { slug: "deploy-pipeline", path: "concepts/deploy-pipeline.md", title: "Deploy Pipeline", type: "concept", tags: [], updated: null },
      ],
    ...(q ? { query: q } : {}),
  }));
  mockApi.brainPage.mockImplementation(async (_slug: string, page: string) => (page === "billing-service" ? billing : { ...billing, slug: page, title: page === "index" ? "index.md" : "Deploy Pipeline", path: `${page}.md`, markdown: "# Other", sources: [], tags: [] }));
});

describe("BrainPages", () => {
  it("renders the list of pages", async () => {
    render(<BrainPages slug="work" />);
    expect(await screen.findByText("2 pages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Billing Service/ })).toBeInTheDocument();
    expect(mockApi.brainPages).toHaveBeenCalledWith("work", "");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainPages slug="work" />);
    await screen.findByText("2 pages");
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: /Billing Service/ }));
    await screen.findByRole("article", { name: "Page Billing Service" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("searches, and goes back to all pages", async () => {
    render(<BrainPages slug="work" />);
    await screen.findByText("2 pages");
    fireEvent.change(screen.getByLabelText("Search the pages"), { target: { value: "invoices" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText('1 pages match "invoices"')).toBeInTheDocument();
    expect(screen.getByText("reads invoices from the queue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all pages" }));
    expect(await screen.findByText("2 pages")).toBeInTheDocument();
    mockApi.brainPages.mockResolvedValueOnce({ pages: [], query: "zzz" });
    fireEvent.change(screen.getByLabelText("Search the pages"), { target: { value: "zzz" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByText('No page matches "zzz".')).toBeInTheDocument();
  });

  it("reads a page as markdown, never as HTML, and follows a wiki link", async () => {
    render(<BrainPages slug="work" />);
    fireEvent.click(await screen.findByRole("button", { name: /Billing Service/ }));
    const article = await screen.findByRole("article", { name: "Page Billing Service" });
    expect(article).toHaveTextContent("entities/billing-service.md · entity · updated 2026-09-15 · billing");
    expect(article).toHaveTextContent("Sources: raw/notes/components.md");
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(article.querySelector("script")).toBeNull();
    expect(article.querySelector("img")).toBeNull();
    expect((window as unknown as { hacked?: number }).hacked).toBeUndefined();
    expect(article).not.toHaveTextContent("title: Billing Service");
    fireEvent.click(screen.getByRole("link", { name: "pipeline" }));
    await waitFor(() => expect(mockApi.brainPage).toHaveBeenLastCalledWith("work", "deploy-pipeline"));
    expect(await screen.findByRole("article", { name: "Page Deploy Pipeline" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹ All pages" }));
    expect(await screen.findByText("2 pages")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "index.md" }));
    await waitFor(() => expect(mockApi.brainPage).toHaveBeenLastCalledWith("work", "index"));
  });

  it("explains an empty wiki and shows errors", async () => {
    mockApi.brainPages.mockResolvedValueOnce({ pages: [] });
    render(<BrainPages slug="work" />);
    expect(await screen.findByText(/No pages yet/)).toBeInTheDocument();
    mockApi.brainPage.mockRejectedValueOnce(new Error("no page schema"));
    fireEvent.click(screen.getByRole("button", { name: "SCHEMA.md" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no page schema");
    mockApi.brainPages.mockRejectedValueOnce(new Error("The brain is not running: start it first"));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not running");
  });

  it("turns wiki links into in-tab links, but not in code or embeds", () => {
    expect(linkWikiLinks("See [[a-b|the A]] and [[c#part]] and ![[img.png]]")).toBe("See [the A](#brain-page=a-b) and [c#part](#brain-page=c) and ![[img.png]]");
    expect(linkWikiLinks("```\n[[x]]\n```\n[[y]]")).toBe("```\n[[x]]\n```\n[y](#brain-page=y)");
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
    expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
  });
});
