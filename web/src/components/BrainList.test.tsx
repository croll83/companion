// @vitest-environment jsdom
/**
 * The list of brains: health dot and text, URL, the domains using each,
 * a hint when a plugin serves the same URL, the empty state, and "Connect
 * remote brain".
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { BrainList, brainDomainsText, healthText } from "./BrainList.js";
import { jarvisBrain, teamBrain } from "../test-fixtures/brains.js";

describe("healthText", () => {
  it("describes every health state", () => {
    expect(healthText(undefined)).toBe("Checking…");
    expect(healthText("checking")).toBe("Checking…");
    expect(healthText({ reachable: false, checkedAt: 0 })).toBe("Unreachable");
    expect(healthText({ reachable: false, error: "HTTP 503", checkedAt: 0 })).toBe("Unreachable: HTTP 503");
    expect(healthText({ reachable: true, pages: 80, version: "0.3.0", checkedAt: 0 })).toBe("Reachable · 80 pages · v0.3.0");
    expect(healthText({ reachable: true, checkedAt: 0 })).toBe("Reachable");
  });

  it("names the domains using a brain", () => {
    expect(brainDomainsText(jarvisBrain())).toBe("Used by GLOBAL (default), Herd");
    expect(brainDomainsText(teamBrain())).toBe("On no domain");
  });
});

describe("BrainList", () => {
  const health = { jarvis: { reachable: true, pages: 80, checkedAt: 0 }, team: { reachable: false, error: "timeout", checkedAt: 0 } };

  it("renders each brain with its health, URL and domains", () => {
    render(<BrainList brains={[jarvisBrain(), teamBrain()]} health={health} selected="jarvis" onConnect={vi.fn()} />);
    const jarvis = screen.getByRole("link", { name: /Jarvis/ });
    expect(jarvis).toHaveAttribute("href", "#/brains/jarvis");
    expect(jarvis).toHaveAttribute("aria-current", "page");
    expect(jarvis).toHaveTextContent("http://100.116.99.9:7421");
    expect(jarvis).toHaveTextContent("Used by GLOBAL (default), Herd · a plugin serves the same URL");
    expect(screen.getByRole("img", { name: "Reachable · 80 pages" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Unreachable: timeout" })).toBeInTheDocument();
  });

  it("passes axe accessibility scan", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<BrainList brains={[jarvisBrain(), teamBrain()]} health={{ jarvis: "checking" }} onConnect={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("explains the empty state and connects a brain", () => {
    const onConnect = vi.fn();
    render(<BrainList brains={[]} health={{}} onConnect={onConnect} />);
    expect(screen.getByText(/No brain yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect remote brain" }));
    expect(onConnect).toHaveBeenCalled();
  });
});
