// @vitest-environment jsdom
/**
 * Tests for the SessionBrowserPane component.
 *
 * The pane previews a dev server running on this host: a typed localhost URL
 * is rewritten to the companion's /browser/host-proxy route and loaded in a
 * sandboxed iframe. Validates:
 * - Toolbar and placeholder render immediately (no server round-trip)
 * - Proxy URL construction (port, path, query string)
 * - URL validation errors and dismissing them
 * - Enter key navigation and the reload button
 * - Accessibility (axe scan)
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { SessionBrowserPane } from "./SessionBrowserPane.js";

function navigate(url: string, via: "click" | "enter" = "click") {
  const input = screen.getByLabelText("Navigate URL");
  fireEvent.change(input, { target: { value: url } });
  if (via === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.click(screen.getByText("Go"));
}

describe("SessionBrowserPane", () => {
  // ─── Render ───────────────────────────────────────────────────────────
  it("shows the toolbar and placeholder text before any navigation", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
    expect(screen.getByLabelText("Navigate URL")).toBeInTheDocument();
    expect(screen.getByText("Go")).toBeInTheDocument();
    expect(screen.getByLabelText("Reload browser")).toBeInTheDocument();
    expect(screen.queryByTitle("Browser preview")).not.toBeInTheDocument();
  });

  // ─── Proxy URL construction ───────────────────────────────────────────
  it("constructs the host-proxy URL when navigating", () => {
    // The frontend builds /api/sessions/:id/browser/host-proxy/:port/path
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://localhost:8080/dashboard");

    const iframe = screen.getByTitle("Browser preview");
    expect(iframe).toHaveAttribute("src", "/api/sessions/s1/browser/host-proxy/8080/dashboard");
    // Proxied content must stay isolated from the companion origin.
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  });

  it("navigates when Enter is pressed in the URL field", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://127.0.0.1:5000/", "enter");
    expect(screen.getByTitle("Browser preview")).toHaveAttribute(
      "src",
      "/api/sessions/s1/browser/host-proxy/5000/",
    );
  });

  it("uses default port 80 for http URLs without explicit port", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://localhost/path");
    expect(screen.getByTitle("Browser preview")).toHaveAttribute(
      "src",
      "/api/sessions/s1/browser/host-proxy/80/path",
    );
  });

  it("uses default port 443 for https URLs without explicit port", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("https://localhost/secure");
    expect(screen.getByTitle("Browser preview")).toHaveAttribute(
      "src",
      "/api/sessions/s1/browser/host-proxy/443/secure",
    );
  });

  it("preserves query string without doubling it", () => {
    // Regression test: query string should appear once in the proxy URL, not twice
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://localhost:3000/api?q=hello");
    expect(screen.getByTitle("Browser preview")).toHaveAttribute(
      "src",
      "/api/sessions/s1/browser/host-proxy/3000/api?q=hello",
    );
  });

  it("ignores a blank URL", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("   ");
    expect(screen.queryByTitle("Browser preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid URL")).not.toBeInTheDocument();
  });

  // ─── Validation errors ────────────────────────────────────────────────
  it("shows an error for an invalid URL and lets the user dismiss it", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("not-a-url");
    expect(screen.getByText("Invalid URL")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByText("Invalid URL")).not.toBeInTheDocument();
  });

  it("rejects non-http URL schemes", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("ftp://files.example.com");
    expect(screen.getByText("Only http:// and https:// URLs are supported")).toBeInTheDocument();
  });

  it("rejects non-localhost hostnames", () => {
    // Only dev servers on this host are proxied
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://example.com/path");
    expect(screen.getByText("Only localhost URLs are supported (e.g. http://localhost:3000)")).toBeInTheDocument();
    expect(screen.queryByTitle("Browser preview")).not.toBeInTheDocument();
  });

  // ─── Reload button ────────────────────────────────────────────────────
  it("reload button re-assigns the iframe src", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://localhost:3000/");
    const iframe = screen.getByTitle("Browser preview") as HTMLIFrameElement;
    iframe.src = "about:blank";

    fireEvent.click(screen.getByLabelText("Reload browser"));
    expect(iframe.getAttribute("src")).toBe("/api/sessions/s1/browser/host-proxy/3000/");
  });

  it("reload button does nothing before any navigation", () => {
    render(<SessionBrowserPane sessionId="s1" />);
    fireEvent.click(screen.getByLabelText("Reload browser"));
    expect(screen.getByText("Enter a URL and click Go to preview.")).toBeInTheDocument();
  });

  // ─── Accessibility ────────────────────────────────────────────────────
  it("passes axe accessibility scan (placeholder state)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility scan (navigation error banner)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    navigate("not-a-url");
    expect(screen.getByText("Invalid URL")).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("passes axe accessibility scan (active preview with toolbar)", async () => {
    const { axe } = await import("vitest-axe");
    const { container } = render(<SessionBrowserPane sessionId="s1" />);
    navigate("http://localhost:3000/");
    // Remove the iframe before axe scan — axe-core cannot inspect sandboxed
    // iframes in jsdom and throws "Respondable target" errors. The toolbar
    // and surrounding structure are still scanned for a11y compliance.
    container.querySelector("iframe")?.remove();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
