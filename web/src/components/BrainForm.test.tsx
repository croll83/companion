// @vitest-environment jsdom
/**
 * The connect / edit form of a remote brain: required fields, URL checks,
 * a bearer token required only when none is set yet (the existing token is
 * never shown: an empty field keeps it), and the Advanced URL overrides
 * (left out on create, removed with null on edit).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainForm } from "./BrainForm.js";
import { oauthBrain, teamBrain } from "../test-fixtures/brains.js";

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("BrainForm", () => {
  it("renders the connect form with the derived URLs", () => {
    render(<BrainForm busy={false} onSubmit={vi.fn()} />);
    expect(screen.getByRole("form", { name: "Connect remote brain" })).toBeInTheDocument();
    type("Base URL", "http://b:1/");
    expect(screen.getByText("http://b:1/mcp")).toBeInTheDocument();
    expect(screen.getByText("http://b:1/healthz")).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainForm brain={teamBrain()} busy={false} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  // Create: overrides left empty are not sent, the token is sent once typed.
  it("submits a new brain, requiring a token for bearer auth", () => {
    const onSubmit = vi.fn(async () => true);
    render(<BrainForm busy={false} onSubmit={onSubmit} />);
    const submit = screen.getByRole("button", { name: "Connect brain" });
    expect(submit).toBeDisabled();
    type("Name", "Team");
    type("Base URL", "ftp://x");
    expect(screen.getByText("URLs must start with http:// or https://.")).toBeInTheDocument();
    type("Base URL", "https://team.example");
    type("What it is about", " Team wiki ");
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "bearer" } });
    expect(screen.getByText("Bearer authentication needs a token.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    type("Token", " tok ");
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ name: "Team", about: "Team wiki", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "tok" });
  });

  it("sends Advanced overrides when filled", () => {
    const onSubmit = vi.fn(async () => true);
    render(<BrainForm busy={false} onSubmit={onSubmit} />);
    type("Name", "X");
    type("Base URL", "http://x");
    type("MCP URL (override)", "http://x/rpc");
    type("Health URL (override)", "http://x/ok");
    fireEvent.submit(screen.getByRole("form"));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ mcpUrl: "http://x/rpc", healthUrl: "http://x/ok", auth: { mode: "none" } }));
  });

  // Edit: the stored token is kept when the field stays empty; empty
  // overrides are sent as null so an old override is removed.
  it("edits a brain without re-typing its token", () => {
    const onSubmit = vi.fn(async () => true);
    const onCancel = vi.fn();
    render(<BrainForm brain={teamBrain()} busy={false} onSubmit={onSubmit} onCancel={onCancel} />);
    expect(screen.getByText(/A token is set/)).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Team", about: "", baseUrl: "https://team.example", auth: { mode: "bearer" }, mcpUrl: null, healthUrl: null });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("requires a name", () => {
    render(<BrainForm busy={false} onSubmit={vi.fn()} />);
    type("Base URL", "http://x");
    expect(screen.getByText("A name is required.")).toBeInTheDocument();
    type("Name", "X");
    type("Base URL", "");
    expect(screen.getByText("The base URL is required.")).toBeInTheDocument();
  });

  // OAuth with a pre-registered client: the client id is required, the
  // callback port optional (an integer 1-65535); no token field.
  it("connects an OAuth brain with a client id and an optional callback port", () => {
    const onSubmit = vi.fn(async () => true);
    render(<BrainForm busy={false} onSubmit={onSubmit} />);
    type("Name", "Hercle");
    type("Base URL", "https://brain.example");
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "oauth" } });
    expect(screen.queryByLabelText("Token")).toBeNull();
    expect(screen.getByText("OAuth needs the client id of the pre-registered app.")).toBeInTheDocument();
    type("OAuth client id", "a b");
    expect(screen.getByText("The client id cannot contain spaces.")).toBeInTheDocument();
    type("OAuth client id", " app-1 ");
    type("Callback port (optional)", "99999");
    expect(screen.getByText("The callback port must be a number from 1 to 65535.")).toBeInTheDocument();
    type("Callback port (optional)", "8765");
    fireEvent.click(screen.getByRole("button", { name: "Connect brain" }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Hercle", about: "", baseUrl: "https://brain.example", auth: { mode: "oauth", clientId: "app-1", callbackPort: 8765 } });
  });

  it("edits an OAuth brain, keeping its client and dropping the port when cleared", () => {
    const onSubmit = vi.fn(async () => true);
    render(<BrainForm brain={oauthBrain()} busy={false} onSubmit={onSubmit} />);
    expect(screen.getByLabelText("OAuth client id")).toHaveValue("11111111-2222-3333-4444-555555555555");
    type("Callback port (optional)", "");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: { mode: "oauth", clientId: "11111111-2222-3333-4444-555555555555" } }));
  });

  it("passes axe accessibility scan with OAuth fields", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainForm brain={oauthBrain()} busy={false} onSubmit={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
