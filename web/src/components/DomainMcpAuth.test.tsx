// @vitest-environment jsdom
/**
 * The access panel of a private MCP server on the Domains page: one view
 * per state (unchecked, open, manual headers, needs a client, sign-in,
 * signed in, API key), each button calling the right API action, a sign-in
 * that completes by itself (polling) or from a pasted address, and errors
 * shown where the user acts. The API is mocked: no request leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { McpAuthView } from "../api.js";

const mockApi = vi.hoisted(() => ({
  mcpAuth: vi.fn(async () => ({})),
  mcpSignIn: vi.fn(async () => ({ authUrl: "https://as.example/authorize?x=1", redirectUri: "http://localhost:3456/api/mcp-auth/callback" })),
}));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainMcpAuth, mcpAuthLabel, mcpAuthNeedsAction } from "./DomainMcpAuth.js";

function setup(auth: McpAuthView) {
  const onChanged = vi.fn();
  const utils = render(<DomainMcpAuth slug="acme" name="gdrive" auth={auth} onChanged={onChanged} />);
  return { onChanged, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("labels", () => {
  // The row shows one short line; states needing the user open the panel by themselves.
  it("names every state and flags the ones that need the user", () => {
    const base = { owner: "acme" };
    expect(mcpAuthLabel({ ...base, state: "unchecked" })).toBe("access not checked");
    expect(mcpAuthLabel({ ...base, state: "open" })).toBe("open");
    expect(mcpAuthLabel({ ...base, state: "manual" })).toBe("credentials in mcp.json");
    expect(mcpAuthLabel({ ...base, state: "needs-client" })).toBe("OAuth · needs a client ID");
    expect(mcpAuthLabel({ ...base, state: "needs-sign-in" })).toBe("OAuth · sign-in needed");
    expect(mcpAuthLabel({ ...base, state: "signed-in" })).toBe("OAuth · signed in");
    expect(mcpAuthLabel({ ...base, state: "signed-in", account: "me@x" })).toBe("OAuth · me@x");
    expect(mcpAuthLabel({ ...base, state: "needs-key" })).toBe("API key needed");
    expect(mcpAuthLabel({ ...base, state: "key-set" })).toBe("API key set");
    expect(mcpAuthNeedsAction({ ...base, state: "needs-key" })).toBe(true);
    expect(mcpAuthNeedsAction({ ...base, state: "open" })).toBe(false);
    expect(mcpAuthNeedsAction(undefined)).toBe(false);
  });
});

describe("DomainMcpAuth", () => {
  it("renders the check button of an unchecked server and runs it", async () => {
    const { onChanged } = setup({ owner: "acme", state: "unchecked" });
    fireEvent.click(screen.getByRole("button", { name: "Check access" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "check" });
  });

  it("offers to take over hand-written headers, and an API key on an open server", async () => {
    const { unmount } = setup({ owner: "acme", state: "manual" });
    expect(screen.getByText(/headers in mcp.json/)).toBeInTheDocument();
    unmount();
    setup({ owner: "acme", state: "open" });
    fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
    expect(screen.getByRole("form", { name: "API key of gdrive" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "check" }));
  });

  it("saves the OAuth client the provider needs, showing the redirect URI to register", async () => {
    setup({ owner: "acme", state: "needs-client", redirectUri: "http://localhost:3456/api/mcp-auth/callback" });
    expect(screen.getByText("http://localhost:3456/api/mcp-auth/callback")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save client" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: " cid.apps " } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "sec" } });
    fireEvent.click(save);
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "client", clientId: "cid.apps", clientSecret: "sec" }));
  });

  it("signs in: opens the provider's page and finishes from a pasted address", async () => {
    setup({ owner: "global", state: "needs-sign-in", sharedWith: ["gmail"], clientId: "cid.apps.googleusercontent.com" });
    expect(screen.getByText(/Same sign-in: gmail/)).toBeInTheDocument();
    expect(screen.getByText(/Shared by every domain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const link = await screen.findByRole("link", { name: "Open the sign-in page" });
    expect(link).toHaveAttribute("href", "https://as.example/authorize?x=1");
    expect(link).toHaveAttribute("target", "_blank");
    fireEvent.change(screen.getByLabelText("Address the sign-in page ended on"), { target: { value: "http://localhost:3456/api/mcp-auth/callback?code=c&state=s" } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "finish", url: "http://localhost:3456/api/mcp-auth/callback?code=c&state=s" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open the sign-in page" })).toBeNull());
  });

  // A browser on this machine lands on Companion's callback: the panel polls until signed in.
  it("polls while a sign-in is open and closes it once signed in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onChanged = vi.fn();
    const { rerender } = render(<DomainMcpAuth slug="acme" name="gdrive" auth={{ owner: "acme", state: "needs-sign-in" }} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("link", { name: "Open the sign-in page" });
    onChanged.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(onChanged).toHaveBeenCalled();
    rerender(<DomainMcpAuth slug="acme" name="gdrive" auth={{ owner: "acme", state: "signed-in", account: "me@acme" }} onChanged={onChanged} />);
    await waitFor(() => expect(screen.queryByRole("link", { name: "Open the sign-in page" })).toBeNull());
    expect(screen.getByText("Signed in as me@acme.")).toBeInTheDocument();
  });

  it("signs out, and lets the user change the client of a signed-in server", async () => {
    setup({ owner: "acme", state: "signed-in", clientId: "cid.apps", hasClientSecret: true });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "sign-out" }));
    fireEvent.click(screen.getByRole("button", { name: /Client cid.apps…/ }));
    expect(screen.getByLabelText(/Client secret \(saved: leave empty to keep it\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save client" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "client", clientId: "cid.apps" }));
    fireEvent.click(screen.getByRole("button", { name: /Client cid.apps…/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "OAuth client of gdrive" })).toBeNull();
  });

  it("hides the client button for a client Companion registered itself", () => {
    setup({ owner: "acme", state: "needs-sign-in", dynamicClient: true });
    expect(screen.queryByRole("button", { name: /Client/ })).toBeNull();
  });

  it("sets, changes and removes an API key", async () => {
    const { unmount } = setup({ owner: "acme", state: "needs-key", header: "X-Api-Key" });
    expect(screen.getByLabelText("Header")).toHaveValue("X-Api-Key");
    fireEvent.change(screen.getByLabelText("Key or token"), { target: { value: "k-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "key", header: "X-Api-Key", value: "k-1" }));
    unmount();
    setup({ owner: "acme", state: "key-set", header: "Authorization" });
    expect(screen.getByText(/Key set \(header Authorization\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mockApi.mcpAuth).toHaveBeenCalledWith("acme", "gdrive", { action: "key", header: "Authorization", value: "" }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("form", { name: "API key of gdrive" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "API key of gdrive" })).toBeNull();
  });

  it("shows the API's error and the stored one", async () => {
    mockApi.mcpSignIn.mockRejectedValueOnce(new Error("This provider needs a client ID"));
    const { unmount } = setup({ owner: "acme", state: "needs-sign-in" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This provider needs a client ID");
    unmount();
    setup({ owner: "acme", state: "needs-sign-in", error: "The sign-in was revoked" });
    expect(screen.getByRole("alert")).toHaveTextContent("The sign-in was revoked");
  });

  it("cancels an open sign-in", async () => {
    setup({ owner: "acme", state: "needs-sign-in" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("link", { name: "Open the sign-in page" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("link", { name: "Open the sign-in page" })).toBeNull();
  });

  it("passes axe accessibility scan in the sign-in and client states", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = setup({ owner: "acme", state: "needs-sign-in", clientId: "cid" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("link", { name: "Open the sign-in page" });
    fireEvent.click(screen.getByRole("button", { name: /Client cid/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
