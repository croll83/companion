// @vitest-environment jsdom
/**
 * "Embedded brain (existing wiki folder)": name, folder, about, language and
 * the hide-secrets toggle. Validates that the form refuses a missing or
 * relative folder before calling the API, sends exactly the create input
 * the server expects, and in edit mode keeps the folder read-only and sends
 * only the changeable options (with "Start with Companion").
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmbeddedBrainForm } from "./EmbeddedBrainForm.js";
import { embeddedBrain } from "../test-fixtures/brains.js";

describe("EmbeddedBrainForm", () => {
  it("renders the create form with safe defaults", () => {
    render(<EmbeddedBrainForm busy={false} onSubmit={vi.fn(async () => true)} />);
    expect(screen.getByRole("form", { name: "Embedded brain" })).toBeInTheDocument();
    expect(screen.getByLabelText("Wiki folder")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Language of the wiki")).toHaveValue("auto");
    expect(screen.getByLabelText(/Hide secrets/)).toBeChecked();
    expect(screen.queryByLabelText("Start with Companion")).toBeNull();
    expect(screen.getByRole("button", { name: "Create brain" })).toBeDisabled();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<EmbeddedBrainForm busy={false} onSubmit={vi.fn(async () => true)} onCancel={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("asks for an absolute folder, then creates the brain", () => {
    const onSubmit = vi.fn(async () => true);
    render(<EmbeddedBrainForm busy={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Work " } });
    expect(screen.getByText("The wiki folder is required.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "wiki" } });
    expect(screen.getByText(/must be an absolute path/)).toBeInTheDocument();
    fireEvent.submit(screen.getByRole("form", { name: "Embedded brain" }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Wiki folder"), { target: { value: "~/wiki " } });
    fireEvent.change(screen.getByLabelText("What it is about"), { target: { value: "Team notes" } });
    fireEvent.change(screen.getByLabelText("Language of the wiki"), { target: { value: "it" } });
    fireEvent.click(screen.getByLabelText(/Hide secrets/));
    fireEvent.click(screen.getByRole("button", { name: "Create brain" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "embedded", name: "Work", about: "Team notes", wikiDir: "~/wiki", language: "it", redactSecrets: false });
  });

  it("edits an existing brain with the folder read-only", () => {
    const onSubmit = vi.fn(async () => true);
    const onCancel = vi.fn();
    render(<EmbeddedBrainForm brain={embeddedBrain()} busy={false} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByLabelText("Wiki folder")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Wiki folder")).toHaveValue("/home/me/wiki");
    fireEvent.change(screen.getByLabelText("Language of the wiki"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Work", about: "Team wiki", language: "en", redactSecrets: true, autostart: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("says it is starting while busy", () => {
    render(<EmbeddedBrainForm busy onSubmit={vi.fn(async () => true)} />);
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });
});
