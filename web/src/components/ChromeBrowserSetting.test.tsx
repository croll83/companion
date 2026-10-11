// @vitest-environment jsdom
/**
 * "Preferred Chrome browser" (Settings): automatic by default (the browser
 * on this machine); "Detect browsers" lists them through a live
 * Chrome-enabled Claude session; choosing one saves it at once and rolls back
 * when the save is refused.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ listChromeBrowsers: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { ChromeBrowserSetting } from "./ChromeBrowserSetting.js";

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <ChromeBrowserSetting value={value} onChange={setValue} />;
}

const browsers = [
  { device_id: "dev-linux", name: "Browser 1", os_platform: "Linux", current: true },
  { device_id: "dev-mac", name: "Browser 2", os_platform: "macOS", current: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listChromeBrowsers.mockResolvedValue({ browsers, sessionId: "s1" });
  mockApi.updateSettings.mockResolvedValue({});
});

describe("ChromeBrowserSetting", () => {
  it("renders automatic by default and a saved id it does not know yet", () => {
    const { unmount } = render(<Harness />);
    expect(screen.getByLabelText("Preferred Chrome browser")).toHaveValue("");
    unmount();
    render(<Harness initial="dev-old-123456" />);
    expect(screen.getByRole("option", { name: /Saved browser/ })).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("detects the browsers and saves the chosen one", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Detect browsers" }));
    expect(await screen.findByRole("option", { name: "Browser 2 (macOS)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Browser 1 (Linux) · in use" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preferred Chrome browser"), { target: { value: "dev-mac" } });
    expect(mockApi.updateSettings).toHaveBeenCalledWith({ preferredChromeBrowser: "dev-mac" });
    expect(screen.getByLabelText("Preferred Chrome browser")).toHaveValue("dev-mac");
  });

  it("explains when no session can list the browsers, and rolls back a refused save", async () => {
    mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [], error: "No running Claude session has Claude in Chrome on" });
    mockApi.updateSettings.mockRejectedValue(new Error("refused"));
    render(<Harness initial="" />);
    fireEvent.click(screen.getByRole("button", { name: "Detect browsers" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/No running Claude session/);
    mockApi.listChromeBrowsers.mockRejectedValue(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Detect browsers" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("offline"));
    mockApi.listChromeBrowsers.mockResolvedValue({ browsers });
    fireEvent.click(screen.getByRole("button", { name: "Detect browsers" }));
    await screen.findByRole("option", { name: "Browser 2 (macOS)" });
    fireEvent.change(screen.getByLabelText("Preferred Chrome browser"), { target: { value: "dev-mac" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("refused");
    expect(screen.getByLabelText("Preferred Chrome browser")).toHaveValue("");
  });
});
