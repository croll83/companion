// @vitest-environment jsdom
/**
 * FolderScopeSelector is the Global / Project-folders picker shared by saved
 * prompts and env profiles. These tests cover rendering (including the
 * "not assigned yet" state used by legacy env profiles), accessibility and
 * every callback.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FolderScopeSelector, type FolderScope } from "./FolderScopeSelector.js";

function setup(scope: FolderScope | null, folders: string[] = []) {
  const props = {
    onScopeChange: vi.fn(),
    onRemoveFolder: vi.fn(),
    onAddFolder: vi.fn(),
  };
  const utils = render(
    <FolderScopeSelector
      scope={scope}
      folders={folders}
      description="Where it applies."
      folderHint="Only inside these folders."
      {...props}
    />,
  );
  return { ...utils, ...props };
}

describe("FolderScopeSelector", () => {
  it("renders the scope options and the description as a labelled group", () => {
    setup("global");
    expect(screen.getByRole("group", { name: "Scope" })).toBeInTheDocument();
    expect(screen.getByText("Where it applies.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Project folders" })).toHaveAttribute("aria-pressed", "false");
    // Folder controls only appear for project scope.
    expect(screen.queryByRole("button", { name: "Add folder" })).not.toBeInTheDocument();
  });

  it("passes axe accessibility scan with project folders shown", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = setup("project", ["/work/repo", "/work/other"]);
    expect(await axe(container)).toHaveNoViolations();
  });

  // A legacy env profile has no scope yet: neither option is pressed.
  it("presses neither option when the scope is not assigned", () => {
    setup(null);
    expect(screen.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Project folders" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports scope changes", () => {
    const { onScopeChange } = setup(null);
    fireEvent.click(screen.getByRole("button", { name: "Project folders" }));
    fireEvent.click(screen.getByRole("button", { name: "Global" }));
    expect(onScopeChange.mock.calls).toEqual([["project"], ["global"]]);
  });

  it("lists folders by name with the full path as tooltip, and removes or adds folders", () => {
    const { onRemoveFolder, onAddFolder } = setup("project", ["/work/repo"]);
    expect(screen.getByText("Only inside these folders.")).toBeInTheDocument();
    expect(screen.getByTitle("/work/repo")).toHaveTextContent("repo");

    fireEvent.click(screen.getByLabelText("Remove folder /work/repo"));
    expect(onRemoveFolder).toHaveBeenCalledWith("/work/repo");

    fireEvent.click(screen.getByRole("button", { name: "Add folder" }));
    expect(onAddFolder).toHaveBeenCalled();
  });
});
