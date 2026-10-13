// @vitest-environment jsdom
/**
 * "New brain": only name, what it is about and optional tags (the folder
 * under Advanced). Validates the git check first (a blocking card with
 * install links when git is missing, and "Check again"), the input checks,
 * what is sent, the success state that says the brain is OFF on every
 * domain and how to turn it on (D4), and errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { embeddedBrain } from "../test-fixtures/brains.js";

const mockApi = vi.hoisted(() => ({ brainGit: vi.fn(), createNewBrain: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { NewBrainWizard, previewSlug } from "./NewBrainWizard.js";

const created = {
  brain: embeddedBrain({ slug: "boat", name: "Boat" }),
  wiki: { dir: "/home/me/companion_brain_boat", language: "it" as const, tags: ["engine", "charter"], commit: "abcdef123456" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.brainGit.mockResolvedValue({ available: true, version: "git version 2.43.0" });
  mockApi.createNewBrain.mockResolvedValue(created);
});

async function ready() {
  await waitFor(() => expect(mockApi.brainGit).toHaveBeenCalled());
}

describe("NewBrainWizard", () => {
  it("renders the three questions and the default folder", async () => {
    render(<NewBrainWizard onCreated={vi.fn()} onClose={vi.fn()} />);
    await ready();
    expect(screen.getByRole("form", { name: "New brain" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("What it is about")).toBeInTheDocument();
    expect(screen.getByLabelText("Tags (optional)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "La Barca!" } });
    expect(screen.getByText("~/companion_brain_la-barca")).toBeInTheDocument();
    expect(screen.getByLabelText("Wiki folder")).toHaveAttribute("placeholder", "~/companion_brain_la-barca");
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<NewBrainWizard onCreated={vi.fn()} onClose={vi.fn()} />);
    await ready();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("creates the brain and explains it is off on every domain", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewBrainWizard onCreated={onCreated} onClose={onClose} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Boat " } });
    fireEvent.change(screen.getByLabelText("What it is about"), { target: { value: "The boat " } });
    fireEvent.change(screen.getByLabelText("Tags (optional)"), { target: { value: "engine, , charter" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByText("Brain Boat is ready.")).toBeInTheDocument();
    expect(mockApi.createNewBrain).toHaveBeenCalledWith({ name: "Boat", about: "The boat", tags: ["engine", "charter"] });
    expect(onCreated).toHaveBeenCalledWith(created.brain);
    expect(screen.getByText("It is off on every domain.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Domains" })).toHaveAttribute("href", "#/domains");
    expect(screen.getByText("/home/me/companion_brain_boat")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Open the brain" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("sends a folder given under Advanced, and refuses a relative one", async () => {
    render(<NewBrainWizard onCreated={vi.fn()} onClose={vi.fn()} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Boat" } });
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "wikis/boat" } });
    expect(screen.getByText(/must be an absolute path/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create brain" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "~/wikis/boat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    await waitFor(() => expect(mockApi.createNewBrain).toHaveBeenCalledWith({ name: "Boat", about: "", tags: [], wikiDir: "~/wikis/boat" }));
  });

  it("blocks with install links when git is missing, and checks again", async () => {
    mockApi.brainGit.mockResolvedValueOnce({ available: false }).mockResolvedValueOnce({ available: true });
    render(<NewBrainWizard onCreated={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText("git is needed for a new brain")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "git-scm.com/downloads" })).toHaveAttribute("href", "https://git-scm.com/downloads");
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("form", { name: "New brain" })).toBeInTheDocument();
  });

  it("shows the git card when the server finds git missing, and other errors inline", async () => {
    mockApi.createNewBrain.mockRejectedValueOnce(new Error("git is not installed: a new wiki is a git repository"));
    render(<NewBrainWizard onCreated={vi.fn()} onClose={vi.fn()} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Boat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByText("git is needed for a new brain")).toBeInTheDocument();

    mockApi.brainGit.mockRejectedValueOnce(new Error("offline"));
    mockApi.createNewBrain.mockRejectedValueOnce(new Error("/x already exists and is not empty"));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Boat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists and is not empty");
  });

  it("previews the folder name like the server", () => {
    expect(previewSlug("Città Ü 2")).toBe("citta-u-2");
    expect(previewSlug("***")).toBe("");
  });
});
