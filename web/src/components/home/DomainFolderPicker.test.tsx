// @vitest-environment jsdom
/**
 * DomainFolderPicker (home page) chooses where a new session runs: its
 * domain (GLOBAL by default, or one created inline) and a new folder inside
 * the domain or an existing folder. It always explains what a domain shares.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ listDomains: vi.fn(), createDomain: vi.fn() }));
vi.mock("../../api.js", () => ({ api: mockApi }));
vi.mock("../FolderPicker.js", () => ({
  FolderPicker: ({ onSelect, onClose }: { onSelect: (p: string) => void; onClose: () => void }) => (
    <div>
      <button type="button" onClick={() => { onSelect("/repos/herd-app"); onClose(); }}>pick folder</button>
    </div>
  ),
}));

import { DomainFolderPicker, folderSlug, type FolderMode } from "./DomainFolderPicker.js";

const onDomain = vi.fn();
const onMode = vi.fn();

function Harness({ initialDomain = "global", initialMode = "new" as FolderMode }) {
  const [domain, setDomain] = useState(initialDomain);
  const [mode, setMode] = useState<FolderMode>(initialMode);
  const [name, setName] = useState("Brave Falcon");
  const [cwd, setCwd] = useState("/repos/old");
  return (
    <DomainFolderPicker
      domain={domain}
      onDomainChange={(d) => { onDomain(d); setDomain(d); }}
      folderMode={mode}
      onFolderModeChange={(m) => { onMode(m); setMode(m); }}
      folderName={name}
      onFolderNameChange={setName}
      cwd={cwd}
      onCwdChange={setCwd}
    />
  );
}

const domains = [
  { slug: "global", name: "GLOBAL", path: "/h/companion_domain_global" },
  { slug: "herd", name: "Herd", path: "/h/companion_domain_herd" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listDomains.mockResolvedValue({ root: "/h", skillGroups: [], domains });
  mockApi.createDomain.mockResolvedValue({ slug: "new-topic", name: "New Topic", path: "/h/companion_domain_new-topic" });
});

describe("DomainFolderPicker", () => {
  it("renders the domains, the sharing note and where the session will run", async () => {
    render(<Harness />);
    expect(await screen.findByRole("option", { name: "Herd" })).toBeInTheDocument();
    expect(screen.getByText(/share memory, skills, MCP servers and instructions/)).toBeInTheDocument();
    expect(screen.getByText("/h/companion_domain_global/brave-falcon")).toBeInTheDocument();
  });

  it("passes axe accessibility scan in both folder modes", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Harness />);
    await screen.findByRole("option", { name: "Herd" });
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("radio", { name: "Existing folder" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches domain and updates the target folder", async () => {
    render(<Harness />);
    await screen.findByRole("option", { name: "Herd" });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "herd" } });
    expect(onDomain).toHaveBeenCalledWith("herd");
    fireEvent.change(screen.getByLabelText("New folder name"), { target: { value: "Fix Login!" } });
    expect(screen.getByText("/h/companion_domain_herd/fix-login")).toBeInTheDocument();
  });

  // "+ New domain…" creates the domain inline and selects it.
  it("creates a domain inline", async () => {
    render(<Harness />);
    await screen.findByRole("option", { name: "Herd" });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("New domain name"), { target: { value: "New Topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onDomain).toHaveBeenCalledWith("new-topic"));
    expect(mockApi.createDomain).toHaveBeenCalledWith("New Topic");
    expect(screen.getByRole("option", { name: "New Topic" })).toBeInTheDocument();
  });

  it("shows a creation error and can cancel", async () => {
    mockApi.createDomain.mockRejectedValue(new Error("already exists"));
    render(<Harness />);
    await screen.findByRole("option", { name: "Herd" });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("New domain name"), { target: { value: "Herd" } });
    fireEvent.keyDown(screen.getByLabelText("New domain name"), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Domain")).toBeInTheDocument();
  });

  it("attaches an existing folder through the folder picker", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Existing folder" }));
    expect(onMode).toHaveBeenCalledWith("existing");
    fireEvent.click(screen.getByRole("button", { name: "old" }));
    fireEvent.click(screen.getByRole("button", { name: "pick folder" }));
    expect(screen.getByText("/repos/herd-app")).toBeInTheDocument();
  });

  // A remembered domain that was removed falls back to GLOBAL.
  it("falls back to GLOBAL for an unknown remembered domain", async () => {
    render(<Harness initialDomain="gone" />);
    await waitFor(() => expect(onDomain).toHaveBeenCalledWith("global"));
  });

  it("slugifies folder names like the server", () => {
    expect(folderSlug("Brave Falcon")).toBe("brave-falcon");
    expect(folderSlug("  Città! ")).toBe("citta");
  });
});
