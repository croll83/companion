// @vitest-environment jsdom
/**
 * SessionEnvProfiles lists the names of the env profiles the server applied
 * to a session's CLI (SdkSessionInfo.envProfiles), in application order.
 * It is display-only: the interaction it supports is the tooltip explaining
 * the override order, and reacting to the session list changing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useStore } from "../store.js";
import { SessionEnvProfiles } from "./SessionEnvProfiles.js";
import type { SdkSessionInfo } from "../types.js";

function sdk(overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return { sessionId: "s1", state: "connected", cwd: "/work", createdAt: 1, ...overrides };
}

beforeEach(() => {
  useStore.setState({ sdkSessions: [] });
});

describe("SessionEnvProfiles", () => {
  it("renders the applied profile names in order", () => {
    useStore.setState({ sdkSessions: [sdk({ envProfiles: ["Everywhere", "Repo", "Jarvis"] })] });
    render(<SessionEnvProfiles sessionId="s1" />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Everywhere", "Repo", "Jarvis"]);
    expect(screen.getByRole("list")).toHaveAttribute("title", expect.stringContaining("later profiles override"));
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    useStore.setState({ sdkSessions: [sdk({ envProfiles: ["Everywhere"] })] });
    const { container } = render(<SessionEnvProfiles sessionId="s1" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("renders nothing without profiles or for another session", () => {
    useStore.setState({ sdkSessions: [sdk({ envProfiles: [] }), sdk({ sessionId: "s2", envProfiles: ["Other"] })] });
    const { container } = render(<SessionEnvProfiles sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  // A relaunch re-resolves profiles; the block follows the refreshed list.
  it("updates when the session list is refreshed", () => {
    useStore.setState({ sdkSessions: [sdk()] });
    render(<SessionEnvProfiles sessionId="s1" />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    act(() => {
      useStore.setState({ sdkSessions: [sdk({ envProfiles: ["Repo"] })] });
    });
    expect(screen.getByRole("region", { name: "Environment profiles" })).toHaveTextContent("Repo");
  });
});
