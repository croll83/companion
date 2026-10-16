// @vitest-environment jsdom
/**
 * The Linear tab of a domain: pick connection → team → project, the
 * per-domain rules (start / archive) with "Connection default" as the
 * migration-safe default, save, unlink, a link whose connection was
 * removed, and no connection at all. The API is mocked: no Linear call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { DomainLinearInfo } from "../api.js";

const mockApi = vi.hoisted(() => ({
  getDomainLinear: vi.fn(),
  listLinearConnections: vi.fn(),
  getLinearStates: vi.fn(),
  listLinearTeamProjects: vi.fn(),
  setDomainLinear: vi.fn(),
  clearDomainLinear: vi.fn(),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainLinear } from "./DomainLinear.js";

const connections = [
  { id: "conn-bskts", name: "Bskts", workspaceName: "bskts", apiKeyLast4: "****abcd" },
  { id: "conn-croll83", name: "croll83", workspaceName: "", apiKeyLast4: "****efgh" },
];
const teamsByConn: Record<string, unknown[]> = {
  "conn-bskts": [{
    id: "team-bsk", key: "BSK", name: "Bskts",
    states: [{ id: "st-todo", name: "Todo", type: "unstarted" }, { id: "st-progress", name: "In Progress", type: "started" }, { id: "st-review", name: "In Review", type: "started" }],
  }],
  "conn-croll83": [{ id: "team-cro", key: "CRO", name: "croll83", states: [{ id: "st-cro", name: "Todo", type: "unstarted" }] }],
};

const linked: DomainLinearInfo = {
  link: {
    connectionId: "conn-bskts", teamId: "team-bsk", teamKey: "BSK", teamName: "Bskts", projectId: "p-bskts", projectName: "Bskts",
    connectionName: "Bskts", workspaceName: "bskts",
    archiveTransition: { enabled: true, stateId: "st-review", stateName: "In Review" },
  },
  rules: {
    start: { enabled: true, stateId: "st-todo", stateName: "Todo", source: "connection" },
    archive: { enabled: true, stateId: "st-review", stateName: "In Review", source: "domain" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getDomainLinear.mockResolvedValue({ link: null });
  mockApi.listLinearConnections.mockResolvedValue({ connections });
  mockApi.getLinearStates.mockImplementation(async (id: string) => ({ teams: teamsByConn[id] ?? [] }));
  mockApi.listLinearTeamProjects.mockResolvedValue({ projects: [{ id: "p-bskts", name: "Bskts", state: "" }, { id: "p-shiki", name: "Shiki", state: "" }] });
  mockApi.setDomainLinear.mockResolvedValue({ link: linked.link });
  mockApi.clearDomainLinear.mockResolvedValue({ ok: true });
});

async function ready() {
  await screen.findByLabelText("Workspace (connection)");
  await waitFor(() => expect(screen.getByLabelText("Team")).not.toBeDisabled());
}

describe("DomainLinear", () => {
  it("renders the pickers for an unlinked domain, first connection preselected", async () => {
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Workspace (connection)")).toHaveValue("conn-bskts");
    expect(screen.getByRole("option", { name: "Bskts (bskts)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "BSK · Bskts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link domain" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    mockApi.getDomainLinear.mockResolvedValue(linked);
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    await ready();
    expect(await axe(container)).toHaveNoViolations();
  });

  // Whole team by default; the project list comes from the chosen team.
  it("links a domain to a team and project with rules", async () => {
    const onChanged = vi.fn();
    render(<DomainLinear slug="herd" onChanged={onChanged} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "team-bsk" } });
    await waitFor(() => expect(mockApi.listLinearTeamProjects).toHaveBeenCalledWith("team-bsk", "conn-bskts"));
    await screen.findByRole("option", { name: "Shiki" });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p-shiki" } });
    fireEvent.change(screen.getByLabelText("When a session starts"), { target: { value: "st-progress" } });
    fireEvent.change(screen.getByLabelText("When a session is archived"), { target: { value: "__off__" } });
    fireEvent.click(screen.getByRole("button", { name: "Link domain" }));
    await waitFor(() => expect(mockApi.setDomainLinear).toHaveBeenCalledWith("herd", {
      connectionId: "conn-bskts", teamId: "team-bsk", projectId: "p-shiki",
      autoTransition: { enabled: true, stateId: "st-progress" },
      archiveTransition: { enabled: false },
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(onChanged).toHaveBeenCalled();
  });

  // Existing link: shows what applies today ("Connection default (Todo)").
  it("shows the saved link and rules, and keeps the connection default", async () => {
    mockApi.getDomainLinear.mockResolvedValue(linked);
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    await ready();
    expect(screen.getByLabelText("Team")).toHaveValue("team-bsk");
    await waitFor(() => expect(screen.getByLabelText("Project")).toHaveValue("p-bskts"));
    expect(screen.getByLabelText("When a session starts")).toHaveValue("__inherit__");
    expect(screen.getByRole("option", { name: "Connection default (Todo)" })).toBeInTheDocument();
    expect(screen.getByLabelText("When a session is archived")).toHaveValue("st-review");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.setDomainLinear).toHaveBeenCalledWith("herd", {
      connectionId: "conn-bskts", teamId: "team-bsk",
      autoTransition: null,
      archiveTransition: { enabled: true, stateId: "st-review" },
    }));
  });

  // Rules name states of one team: another workspace/team resets them.
  it("resets the rules when the workspace changes", async () => {
    mockApi.getDomainLinear.mockResolvedValue(linked);
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    await ready();
    fireEvent.change(screen.getByLabelText("Workspace (connection)"), { target: { value: "conn-croll83" } });
    await screen.findByRole("option", { name: "CRO · croll83" });
    expect(screen.getByLabelText("When a session is archived")).toHaveValue("__inherit__");
    expect(screen.getByLabelText("Team")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("unlinks the domain", async () => {
    mockApi.getDomainLinear.mockResolvedValue(linked);
    const onChanged = vi.fn();
    render(<DomainLinear slug="herd" onChanged={onChanged} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(mockApi.clearDomainLinear).toHaveBeenCalledWith("herd"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows save and unlink errors", async () => {
    mockApi.getDomainLinear.mockResolvedValue(linked);
    mockApi.setDomainLinear.mockRejectedValueOnce(new Error("No project"));
    mockApi.clearDomainLinear.mockRejectedValueOnce(new Error("Domain not found"));
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No project");
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Domain not found"));
  });

  it("flags a link whose connection was removed", async () => {
    mockApi.getDomainLinear.mockResolvedValue({ link: { ...linked.link!, broken: "connection_missing", connectionName: "" } });
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("connection of this link was removed");
  });

  it("explains how to add a connection when there is none", async () => {
    mockApi.listLinearConnections.mockResolvedValue({ connections: [] });
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    expect(await screen.findByText("No Linear connection yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Linear settings" })).toHaveAttribute("href", "#/integrations/linear");
  });

  it("reports load errors (domain and teams)", async () => {
    mockApi.getDomainLinear.mockRejectedValueOnce(new Error("Domain not found"));
    const { unmount } = render(<DomainLinear slug="nope" onChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Domain not found");
    unmount();
    mockApi.getLinearStates.mockRejectedValueOnce(new Error("Unauthorized"));
    render(<DomainLinear slug="herd" onChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unauthorized");
  });
});
