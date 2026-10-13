// @vitest-environment jsdom
/**
 * The Brains page container: list on phones, list + brain on desktop, a
 * health check per brain when the page opens, "Connect remote brain" in a
 * sheet, and every action through the API followed by a reload. Errors are
 * shown; an unknown brain in the URL is reported.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listBrains: vi.fn(),
  createBrain: vi.fn(),
  updateBrain: vi.fn(),
  deleteBrain: vi.fn(),
  brainHealth: vi.fn(),
  testBrain: vi.fn(),
  adoptPluginAsBrain: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainsPage } from "./BrainsPage.js";
import { jarvisBrain, teamBrain } from "../test-fixtures/brains.js";

const originalMatchMedia = window.matchMedia;
function desktop(on: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: on, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  desktop(false);
  window.location.hash = "";
  mockApi.listBrains.mockResolvedValue({ brains: [jarvisBrain(), teamBrain()] });
  mockApi.brainHealth.mockImplementation(async (slug: string) => (slug === "jarvis" ? { reachable: true, pages: 80, checkedAt: 0 } : { reachable: false, error: "timeout", checkedAt: 0 }));
  mockApi.createBrain.mockResolvedValue(teamBrain({ slug: "new" }));
  mockApi.updateBrain.mockResolvedValue(jarvisBrain());
  mockApi.deleteBrain.mockResolvedValue({ ok: true, clearedFrom: [] });
  mockApi.adoptPluginAsBrain.mockResolvedValue({ adoptedIn: ["herd"], brain: jarvisBrain() });
  mockApi.testBrain.mockResolvedValue({ health: { reachable: true, checkedAt: 0 }, mcp: { ok: true } });
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("BrainsPage", () => {
  it("on phones lists the brains and checks each one's health", async () => {
    render(<BrainsPage />);
    expect(await screen.findByRole("navigation", { name: "Brains" })).toBeInTheDocument();
    expect(screen.getByText(/Memory = the CLI's private notes/)).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Reachable · 80 pages" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Unreachable: timeout" })).toBeInTheDocument();
    expect(mockApi.brainHealth).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    desktop(true);
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainsPage />);
    await screen.findByRole("article", { name: "Brain Jarvis" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("on desktop shows the list and the first brain", async () => {
    desktop(true);
    render(<BrainsPage />);
    expect(await screen.findByRole("article", { name: "Brain Jarvis" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Brains" })).toBeInTheDocument();
  });

  it("opens one brain on phones and reports an unknown one", async () => {
    const { unmount } = render(<BrainsPage slug="team" />);
    expect(await screen.findByRole("article", { name: "Brain Team" })).toBeInTheDocument();
    unmount();
    render(<BrainsPage slug="nope" />);
    expect(await screen.findByText('No brain "nope".')).toBeInTheDocument();
  });

  it("connects a remote brain from the sheet and opens it", async () => {
    render(<BrainsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect remote brain" }));
    const sheet = screen.getByRole("dialog", { name: "Connect remote brain" });
    expect(sheet).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://new" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect brain" }));
    await waitFor(() => expect(window.location.hash).toBe("#/brains/new"));
    expect(mockApi.createBrain).toHaveBeenCalledWith({ name: "New", about: "", baseUrl: "http://new", auth: { mode: "none" } });
    expect(mockApi.listBrains).toHaveBeenCalledTimes(2);
  });

  it("shows API errors", async () => {
    mockApi.createBrain.mockRejectedValueOnce(new Error("A brain \"new\" already exists"));
    render(<BrainsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect remote brain" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://new" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect brain" }));
    expect(await screen.findByText('A brain "new" already exists')).toBeInTheDocument();
  });

  it("reports a list that cannot load and a failed health check", async () => {
    mockApi.listBrains.mockRejectedValueOnce(new Error("offline"));
    const { unmount } = render(<BrainsPage />);
    expect(await screen.findByText("offline")).toBeInTheDocument();
    unmount();
    mockApi.brainHealth.mockRejectedValue(new Error("boom"));
    render(<BrainsPage />);
    expect((await screen.findAllByRole("img", { name: "Unreachable: boom" })).length).toBe(2);
  });

  // The detail's actions reach the API; an URL/token change re-checks health.
  it("wires the brain's actions", async () => {
    render(<BrainsPage slug="jarvis" />);
    await screen.findByRole("article", { name: "Brain Jarvis" });
    fireEvent.click(screen.getByRole("button", { name: "Adopt plugin as brain" }));
    await waitFor(() => expect(mockApi.adoptPluginAsBrain).toHaveBeenCalledWith("jarvis", "jarvis-brain@jarvis-lab"));

    fireEvent.click(screen.getByRole("button", { name: "Edit brain" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.updateBrain).toHaveBeenCalledWith("jarvis", expect.objectContaining({ baseUrl: "http://100.116.99.9:7421" })));
    await waitFor(() => expect(mockApi.brainHealth).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mockApi.testBrain).toHaveBeenCalledWith("jarvis"));

    fireEvent.click(screen.getByRole("button", { name: "Remove brain…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brain" }));
    await waitFor(() => expect(window.location.hash).toBe("#/brains"));
    expect(mockApi.deleteBrain).toHaveBeenCalledWith("jarvis");
  });

  it("shows a failed connection test as an error", async () => {
    mockApi.testBrain.mockRejectedValueOnce(new Error("Brain not found"));
    render(<BrainsPage slug="team" />);
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Brain not found")).toBeInTheDocument();
  });

  it("keeps the hash when a removal fails", async () => {
    mockApi.deleteBrain.mockRejectedValueOnce(new Error("nope"));
    window.location.hash = "#/brains/team";
    render(<BrainsPage slug="team" />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove brain…" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove brain" }));
    expect(await screen.findByText("nope")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/brains/team");
  });
});
