// @vitest-environment jsdom
/**
 * SessionDomain shows the focused session's domain in the session panel, a
 * "legacy memory" badge for sessions from before domains, and "Change
 * domain" (domain sessions only), which warns that memory, skills, MCP and
 * instructions switch, then calls POST /sessions/:id/domain. Legacy sessions
 * get "Migrate to domain" instead (POST /sessions/:id/migrate-domain).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  listDomains: vi.fn(),
  changeSessionDomain: vi.fn(),
  migrateSessionToDomain: vi.fn(),
  getLegacyMemory: vi.fn(),
  copyLegacyMemory: vi.fn(),
  listSessions: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { SessionDomain } from "./SessionDomain.js";
import { useStore } from "../store.js";

const domain = (slug: string, name: string) => ({ slug, name, createdAt: 0, mcpDisabled: [], chrome: false, path: `/h/companion_domain_${slug}`, sessionCount: 0, totalSessions: 0, memoryNotes: 0, skills: [], mcpServers: [], skillGroupStates: {} });

function setSession(extra: Record<string, unknown>) {
  useStore.getState().setSdkSessions([{ sessionId: "s1", state: "connected", cwd: "/w", createdAt: 1, ...extra } as never]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listDomains.mockResolvedValue({ root: "/h", skillGroups: [], domains: [domain("global", "GLOBAL"), domain("herd", "Herd")] });
  mockApi.changeSessionDomain.mockResolvedValue({ ok: true, from: "global", to: "herd", interruptsWork: false });
  mockApi.migrateSessionToDomain.mockResolvedValue({ ok: true, from: "legacy", to: "herd", interruptsWork: false });
  mockApi.listSessions.mockResolvedValue([]);
  // By default a legacy Claude session has an empty folder memory.
  mockApi.getLegacyMemory.mockResolvedValue({ backend: "claude", dir: "/m", notes: [] });
  mockApi.copyLegacyMemory.mockResolvedValue({ copied: [], skipped: [] });
});

describe("SessionDomain", () => {
  it("renders the domain name of a domain session", async () => {
    setSession({ domain: "herd" });
    render(<SessionDomain sessionId="s1" />);
    expect(await screen.findByText("Herd")).toBeInTheDocument();
    expect(screen.queryByText("legacy memory")).toBeNull();
  });

  // Legacy sessions keep their folder memory: badge, and no "Change domain".
  it("marks legacy sessions and does not offer to move them", async () => {
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    expect(await screen.findByText("legacy memory")).toBeInTheDocument();
    expect(screen.getByText("GLOBAL")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change domain" })).toBeNull();
  });

  it("passes axe accessibility scan in the idle and choose states", async () => {
    const { axe } = await import("vitest-axe");
    setSession({ domain: "global" });
    const { container } = render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warns, then moves the session to the chosen domain", async () => {
    setSession({ domain: "global" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    expect(screen.getByText(/reads the memory, skills, MCP servers/)).toBeInTheDocument();
    expect(screen.getByLabelText("Move to domain")).toHaveValue("herd");
    fireEvent.click(screen.getByRole("button", { name: "Move and restart" }));
    expect(mockApi.changeSessionDomain).toHaveBeenCalledWith("s1", "herd");
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to Herd");
  });

  it("shows the server's refusal and can be cancelled", async () => {
    mockApi.changeSessionDomain.mockRejectedValue(new Error("busy"));
    setSession({ domain: "global" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockApi.changeSessionDomain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Move and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("busy");
  });

  // Migration is the only way a legacy session joins a domain. GLOBAL is a
  // valid target (a legacy session only sits under it), and the warning says
  // the old folder memory stops being read.
  it("offers legacy sessions every domain, warns about the old memory, then migrates", async () => {
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    const select = screen.getByLabelText("Migrate to domain");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(["global", "herd"]);
    expect(screen.getByText(/old folder memory is no longer read/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "herd" } });
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    // The folder memory is read first (empty here, so no dialog), then the migration runs.
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to Herd");
    expect(mockApi.getLegacyMemory).toHaveBeenCalledWith("s1", "herd");
    expect(mockApi.migrateSessionToDomain).toHaveBeenCalledWith("s1", "herd");
    expect(mockApi.changeSessionDomain).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("This session has no folder memory: nothing to copy");
    // The session list is refreshed so the legacy badge and amber title go away.
    expect(mockApi.listSessions).toHaveBeenCalled();
  });

  it("passes axe accessibility scan in the migrate state", async () => {
    const { axe } = await import("vitest-axe");
    setSession({ domain: "global", legacyMemory: true });
    const { container } = render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("disables the migration while it runs and shows a refusal", async () => {
    let reject!: (e: Error) => void;
    mockApi.migrateSessionToDomain.mockReturnValue(new Promise((_, r) => { reject = r; }));
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    expect(await screen.findByRole("button", { name: "Migrating..." })).toBeDisabled();
    reject(new Error("Session is archived"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Session is archived");
  });

  // ── Guided memory migration ──────────────────────────────────────────────

  const notes = [
    { file: "deploy.md", name: "Deploy", description: "how to deploy", type: "project", preview: "Run the build, then rsync." },
    { file: "prefs.md", name: "Prefs", description: "user prefs", type: "feedback", preview: "Reply in Italian.", existsInDomain: true },
    { file: "todo.md", name: "Todo", description: "", type: "", preview: "" },
  ];

  async function openReview() {
    mockApi.getLegacyMemory.mockResolvedValue({ backend: "claude", dir: "/home/u/.claude/projects/-w/memory", notes });
    setSession({ domain: "global", legacyMemory: true, backendType: "claude" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    fireEvent.change(screen.getByLabelText("Migrate to domain"), { target: { value: "herd" } });
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    return screen.findByRole("dialog", { name: "Folder memory to keep" });
  }

  // The dialog lists every note: checked by default, except the ones already
  // in the target domain (disabled, they would never be overwritten).
  it("lists the folder notes with their type, description and preview", async () => {
    const dialog = await openReview();
    expect(mockApi.getLegacyMemory).toHaveBeenCalledWith("s1", "herd");
    expect(within(dialog).getByText("/home/u/.claude/projects/-w/memory")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Deploy")).toBeChecked();
    expect(within(dialog).getByLabelText("Todo")).toBeChecked();
    const dup = within(dialog).getByLabelText("Prefs");
    expect(dup).not.toBeChecked();
    expect(dup).toBeDisabled();
    expect(within(dialog).getByText("already in the domain")).toBeInTheDocument();
    expect(within(dialog).getByText("project")).toBeInTheDocument();
    expect(within(dialog).getByText("how to deploy")).toBeInTheDocument();
    expect(within(dialog).getByText("Preview of deploy.md")).toBeInTheDocument();
    expect(within(dialog).getByText("Run the build, then rsync.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy 2 notes and migrate" })).toBeEnabled();
    expect(mockApi.migrateSessionToDomain).not.toHaveBeenCalled();
  });

  it("passes axe accessibility scan with the memory review dialog open", async () => {
    const { axe } = await import("vitest-axe");
    await openReview();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  // Copy first, then migrate; the outcome (copied and skipped) stays visible.
  it("copies the chosen notes, then migrates and shows the outcome", async () => {
    mockApi.copyLegacyMemory.mockResolvedValue({
      copied: ["deploy.md"],
      skipped: [{ file: "todo.md", reason: "A note with this file name is already in the domain memory" }],
    });
    const dialog = await openReview();
    fireEvent.click(within(dialog).getByLabelText("Todo"));
    expect(within(dialog).getByRole("button", { name: "Copy 1 note and migrate" })).toBeEnabled();
    fireEvent.click(within(dialog).getByLabelText("Todo"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy 2 notes and migrate" }));
    const status = await screen.findByRole("status");
    expect(mockApi.copyLegacyMemory).toHaveBeenCalledWith("s1", "herd", ["deploy.md", "todo.md"]);
    expect(mockApi.copyLegacyMemory.mock.invocationCallOrder[0]).toBeLessThan(mockApi.migrateSessionToDomain.mock.invocationCallOrder[0]);
    expect(status).toHaveTextContent("Copied 1 note into the domain memory.");
    expect(status).toHaveTextContent("Skipped todo.md: A note with this file name is already in the domain memory");
    expect(status).toHaveTextContent("Moved to Herd");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the copy button when no note is chosen", async () => {
    const dialog = await openReview();
    fireEvent.click(within(dialog).getByLabelText("Deploy"));
    fireEvent.click(within(dialog).getByLabelText("Todo"));
    expect(within(dialog).getByRole("button", { name: "Copy 0 notes and migrate" })).toBeDisabled();
  });

  it("migrates without copying, or cancels without migrating", async () => {
    let dialog = await openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockApi.migrateSessionToDomain).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Migrate to domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Migrate without copying" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to");
    expect(mockApi.copyLegacyMemory).not.toHaveBeenCalled();
    expect(mockApi.migrateSessionToDomain).toHaveBeenCalledTimes(1);
  });

  // A failed copy must not migrate: the notes would otherwise be lost to the session.
  it("does not migrate when the copy fails", async () => {
    mockApi.copyLegacyMemory.mockRejectedValue(new Error("disk full"));
    const dialog = await openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy 2 notes and migrate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Copying the notes failed, so the session was not migrated: disk full");
    expect(mockApi.migrateSessionToDomain).not.toHaveBeenCalled();
  });

  // If the folder memory cannot be read, the dialog says so and still lets the user migrate.
  it("shows a read error in the dialog and offers to migrate without copying", async () => {
    mockApi.getLegacyMemory.mockRejectedValue(new Error("Session is archived"));
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Could not read the folder memory: Session is archived");
    expect(within(dialog).queryByRole("button", { name: /^Copy/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Migrate without copying" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to GLOBAL");
  });

  // Codex loses nothing: an accurate (non-warning) text, no memory lookup, no dialog.
  it("migrates a legacy Codex session directly with an accurate explanation", async () => {
    setSession({ domain: "global", legacyMemory: true, backendType: "codex" });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    expect(screen.getByText(/Nothing is lost: ~\/\.codex\/AGENTS\.md and the project/)).toBeInTheDocument();
    expect(screen.queryByText(/old folder memory is no longer read/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to GLOBAL");
    expect(mockApi.getLegacyMemory).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent("nothing to copy");
  });

  // Defensive: the store may not know the backend; a server "codex" answer migrates without a dialog.
  it("migrates without a dialog when the server reports a Codex session", async () => {
    mockApi.getLegacyMemory.mockResolvedValue({ backend: "codex", notes: [], info: "nothing lost" });
    setSession({ domain: "global", legacyMemory: true });
    render(<SessionDomain sessionId="s1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Migrate to domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Migrate and restart" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Moved to GLOBAL");
    expect(screen.getByRole("status")).not.toHaveTextContent("nothing to copy");
  });
});
