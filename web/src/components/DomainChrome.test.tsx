// @vitest-environment jsdom
/**
 * Claude in Chrome for a domain (Claude Code only): the switch, and the
 * browser its sessions drive ("Prefer local browser", a detected browser,
 * or a deviceId typed by hand when the list cannot be fetched or the saved
 * browser is offline).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({ listChromeBrowsers: vi.fn() }));
vi.mock("../api.js", () => ({ api: mockApi }));

import { DomainChrome } from "./DomainChrome.js";
import { herdDomain } from "../test-fixtures/domains.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.listChromeBrowsers.mockResolvedValue({
    browsers: [
      { deviceId: "dev-linux", name: "Chrome", osPlatform: "Linux", isLocal: true, inUse: true },
      { deviceId: "dev-mac", name: "Safari-Chrome", osPlatform: "macOS", isLocal: false, inUse: false },
    ],
  });
});

describe("DomainChrome", () => {
  it("renders the switch and turns Chrome on", () => {
    const onUpdate = vi.fn(async () => {});
    render(<DomainChrome domain={herdDomain()} busy={false} onUpdate={onUpdate} />);
    expect(screen.queryByLabelText("Browser to drive")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Claude in Chrome" }));
    expect(onUpdate).toHaveBeenCalledWith({ chrome: true });
  });

  it("passes axe accessibility scan with the browser selector", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<DomainChrome domain={herdDomain({ chrome: true })} busy={false} onUpdate={vi.fn(async () => {})} />);
    await screen.findByRole("option", { name: "Chrome (Linux) · local" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("selects a detected browser (the VPS case: drive the remote Mac) and detects again", async () => {
    const onUpdate = vi.fn(async () => {});
    render(<DomainChrome domain={herdDomain({ chrome: true })} busy={false} onUpdate={onUpdate} />);
    const select = screen.getByLabelText("Browser to drive");
    expect(select).toHaveValue("local");
    expect(await screen.findByRole("option", { name: "Safari-Chrome (macOS) · remote" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "dev-mac" } });
    expect(onUpdate).toHaveBeenCalledWith({ chromeBrowser: "dev-mac" });
    fireEvent.click(screen.getByRole("button", { name: "Detect browsers" }));
    await waitFor(() => expect(mockApi.listChromeBrowsers).toHaveBeenLastCalledWith(true));
  });

  it("keeps the selector usable when the browser list cannot be fetched", async () => {
    mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [], error: "Chrome is off" });
    const onUpdate = vi.fn(async () => {});
    render(<DomainChrome domain={herdDomain({ chrome: true })} busy={false} onUpdate={onUpdate} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Chrome is off");
    fireEvent.change(screen.getByLabelText("Browser to drive"), { target: { value: "__manual__" } });
    const manual = screen.getByLabelText("Browser deviceId");
    fireEvent.change(manual, { target: { value: "  typed-device  " } });
    fireEvent.keyDown(manual, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith({ chromeBrowser: "typed-device" });
  });

  it("surfaces a saved deviceId that is not in the list, and reports an empty list or a failure", async () => {
    mockApi.listChromeBrowsers.mockResolvedValue({ browsers: [] });
    const { unmount } = render(<DomainChrome domain={herdDomain({ chrome: true, chromeBrowser: "offline-device" })} busy={false} onUpdate={vi.fn(async () => {})} />);
    expect(await screen.findByLabelText("Browser deviceId")).toHaveValue("offline-device");
    expect(await screen.findByRole("status")).toHaveTextContent("No browser is connected");
    unmount();
    mockApi.listChromeBrowsers.mockRejectedValue(new Error("network down"));
    render(<DomainChrome domain={herdDomain({ chrome: true })} busy={false} onUpdate={vi.fn(async () => {})} />);
    expect(await screen.findByRole("status")).toHaveTextContent("network down");
  });
});
