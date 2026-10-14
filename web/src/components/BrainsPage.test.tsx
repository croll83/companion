// @vitest-environment jsdom
/**
 * The Brains page container: list on phones, list + brain on desktop, a
 * health check per brain when the page opens, "Connect remote brain" in a
 * sheet, and every action through the API followed by a reload. Errors are
 * shown; an unknown brain in the URL is reported. A health check that
 * refetched a server skill reloads the list; "Refresh skill" goes to the API.
 * Embedded brains: adopted from a sheet (folder checked, then the wiki
 * check), created by the "New brain" wizard, started/stopped/restarted and their
 * log read through the API.
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
  refreshBrainSkill: vi.fn(),
  brainProcess: vi.fn(),
  brainLogs: vi.fn(),
  checkAdoptFolder: vi.fn(),
  brainLint: vi.fn(),
  brainGit: vi.fn(),
  createNewBrain: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { BrainsPage } from "./BrainsPage.js";
import { embeddedBrain, jarvisBrain, oauthBrain, teamBrain } from "../test-fixtures/brains.js";

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

  // The server reported a new wiki version and the server fetched the skill
  // again: the page reloads to show it. "Refresh skill" calls the API.
  it("reloads after a skill refetch and refreshes the skill on demand", async () => {
    mockApi.listBrains.mockResolvedValue({ brains: [oauthBrain()] });
    mockApi.brainHealth.mockResolvedValue({ reachable: true, checkedAt: 0, skillRefresh: "updated" });
    mockApi.refreshBrainSkill.mockResolvedValue({ outcome: "unchanged", brain: oauthBrain() });
    render(<BrainsPage slug="hercle" />);
    await screen.findByRole("article", { name: "Brain Hercle" });
    await waitFor(() => expect(mockApi.listBrains).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Refresh skill" }));
    await waitFor(() => expect(mockApi.refreshBrainSkill).toHaveBeenCalledWith("hercle"));
    await waitFor(() => expect(mockApi.listBrains).toHaveBeenCalledTimes(3));
  });

  // Adopt: the folder is checked, the brain created and listed, its wiki check shown, then "Done" opens it.
  it("adopts an existing folder from its sheet, shows the wiki check, and opens the brain", async () => {
    mockApi.createBrain.mockResolvedValueOnce(embeddedBrain());
    mockApi.checkAdoptFolder.mockResolvedValueOnce({ ok: true, path: "/home/me/wiki", ready: true, advice: [] });
    mockApi.brainLint.mockResolvedValueOnce({ ok: true, errors: 0, warnings: 0, pages: 3, advice: [] });
    render(<BrainsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Adopt existing folder" }));
    expect(screen.getByRole("dialog", { name: "Adopt existing folder" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "/home/me/wiki" } });
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByText(/nothing to fix/)).toBeInTheDocument();
    expect(mockApi.createBrain).toHaveBeenCalledWith({ kind: "embedded", name: "Work", about: "", wikiDir: "/home/me/wiki", language: "auto", redactSecrets: true });
    await waitFor(() => expect(mockApi.listBrains).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("link", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the New brain wizard and lists the brain it creates", async () => {
    mockApi.brainGit.mockResolvedValue({ available: true });
    mockApi.createNewBrain.mockResolvedValueOnce({ brain: embeddedBrain({ slug: "boat", name: "Boat" }), wiki: { dir: "/home/me/companion_brain_boat", language: "it", tags: ["overview"], commit: "abcdef123456" } });
    render(<BrainsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "New brain" }));
    expect(screen.getByRole("dialog", { name: "New brain" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Boat" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Create brain" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(await screen.findByText("Brain Boat is ready.")).toBeInTheDocument();
    await waitFor(() => expect(mockApi.listBrains).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // Start/Stop/Restart go to the API, then the list reloads and health is checked again (not after Stop).
  it("drives an embedded brain's process and reads its log", async () => {
    mockApi.listBrains.mockResolvedValue({ brains: [embeddedBrain()] });
    mockApi.brainProcess.mockResolvedValue({ runtime: { state: "running", crashes: 0 } });
    mockApi.brainLogs.mockResolvedValueOnce({ lines: ["hello log"] }).mockRejectedValueOnce(new Error("log unreadable"));
    render(<BrainsPage slug="work" />);
    await screen.findByRole("article", { name: "Brain Work" });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(mockApi.brainProcess).toHaveBeenCalledWith("work", "restart"));
    await waitFor(() => expect(mockApi.brainHealth).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mockApi.brainProcess).toHaveBeenCalledWith("work", "stop"));
    fireEvent.click(screen.getByRole("button", { name: "Show log" }));
    expect(await screen.findByLabelText("Brain log")).toHaveTextContent("hello log");
    fireEvent.click(screen.getByRole("button", { name: "Reload log" }));
    expect(await screen.findByText("log unreadable")).toBeInTheDocument();
    expect(mockApi.brainHealth).toHaveBeenCalledTimes(2);
  });
});
