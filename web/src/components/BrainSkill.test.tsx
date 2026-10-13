// @vitest-environment jsdom
/**
 * The skill of a brain: the server's skill (fetched from `<base>/skill`,
 * shown as plain text, with "Refresh skill"), the generated SKILL.md shown as
 * a preview, or a custom text edited in place. Save appears only when
 * something changed; a note says why a server skill is not in use.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainSkill } from "./BrainSkill.js";
import { jarvisBrain, oauthBrain } from "../test-fixtures/brains.js";

describe("BrainSkill", () => {
  it("shows the generated skill as a preview, without a save button", () => {
    render(<BrainSkill brain={jarvisBrain()} busy={false} onSave={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Skill · jarvis-brain" })).toBeInTheDocument();
    expect(screen.getByLabelText("Generated skill")).toHaveTextContent("name: jarvis-brain");
    expect(screen.queryByRole("button", { name: "Save skill" })).toBeNull();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainSkill brain={jarvisBrain({ skill: { source: "custom", custom: "Body" } })} busy={false} onSave={vi.fn()} onRefresh={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("switches to a custom text and saves it", () => {
    const onSave = vi.fn(async () => true);
    render(<BrainSkill brain={jarvisBrain()} busy={false} onSave={onSave} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Custom text"));
    const save = screen.getByRole("button", { name: "Save skill" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/SKILL.md body/), { target: { value: "Use the tools." } });
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ source: "custom", custom: "Use the tools." });
  });

  // From custom back to generated: the old preview is stale, so a hint replaces it.
  it("goes back to the generated skill", () => {
    const onSave = vi.fn(async () => true);
    render(<BrainSkill brain={jarvisBrain({ skill: { source: "custom", custom: "Body" } })} busy={false} onSave={onSave} onRefresh={vi.fn()} />);
    expect(screen.getByLabelText(/SKILL.md body/)).toHaveValue("Body");
    fireEvent.click(screen.getByLabelText("Generated from the about text"));
    expect(screen.getByText(/Save to switch back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect(onSave).toHaveBeenCalledWith({ source: "generated" });
  });

  // A skill from a server is untrusted: it is shown as text in a <pre>, so
  // markup in it (here a <script>) is never rendered or executed.
  it("shows the server's skill as plain text and refreshes it", async () => {
    let done: () => void = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((r) => { done = r; }));
    const { container } = render(<BrainSkill brain={oauthBrain()} busy={false} onSave={vi.fn()} onRefresh={onRefresh} />);
    const pre = screen.getByLabelText("Skill from the server");
    expect(pre).toHaveTextContent("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/https:\/\/brain\.example\/skill/)).toBeInTheDocument();
    expect(screen.getByText(/server 0\.2\.0 · does not depend on the wiki content/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh skill" }));
    expect(onRefresh).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeDisabled();
    done();
    expect(await screen.findByRole("button", { name: "Refresh skill" })).toBeEnabled();
  });

  it("says when the server's skill follows the wiki version", () => {
    const brain = oauthBrain();
    render(<BrainSkill brain={{ ...brain, skill: { ...brain.skill, server: { fetchedAt: 0, contentHash: "abcdef0123456789" } } }} busy={false} onSave={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText(/follows the wiki \(abcdef012345\)/)).toBeInTheDocument();
  });

  // Switching to the server's skill is a save (the server fetches it); the note
  // from a failed fetch is shown.
  it("switches to the server's skill and shows a fetch note", () => {
    const onSave = vi.fn(async () => true);
    render(<BrainSkill brain={jarvisBrain({ skill: { source: "generated", note: "Skill from the server unavailable: HTTP 404." } })} busy={false} onSave={onSave} onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("HTTP 404");
    fireEvent.click(screen.getByLabelText("From the server"));
    expect(screen.getByText(/Save to fetch the skill the brain publishes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect(onSave).toHaveBeenCalledWith({ source: "server" });
  });

  it("passes axe accessibility scan with a server skill", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainSkill brain={oauthBrain({ skill: { ...oauthBrain().skill, note: "Refresh failed." } })} busy={false} onSave={vi.fn()} onRefresh={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
