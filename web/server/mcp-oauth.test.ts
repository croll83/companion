import { describe, expect, it, vi } from "vitest";
import { deliverLoopbackCallback, isLoopbackCallback } from "./mcp-oauth.js";

/**
 * A pasted OAuth redirect is the only URL Companion requests on the user's
 * behalf, so it must be a loopback listener's /callback carrying a code or
 * an error — never an arbitrary address (no request forgery from the UI).
 */
describe("isLoopbackCallback", () => {
  it("accepts loopback OAuth redirects", () => {
    expect(isLoopbackCallback("http://localhost:7498/callback?code=c&state=s")).toBe(true);
    expect(isLoopbackCallback("http://127.0.0.1:38083/callback/fACkhxJcacb-?code=c")).toBe(true);
    expect(isLoopbackCallback("http://[::1]:5000/callback?error=access_denied")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isLoopbackCallback("not a url")).toBe(false);
    expect(isLoopbackCallback("https://localhost:7498/callback?code=c")).toBe(false);
    expect(isLoopbackCallback("http://evil.example/callback?code=c")).toBe(false);
    expect(isLoopbackCallback("http://localhost.evil.example/callback?code=c")).toBe(false);
    expect(isLoopbackCallback("http://localhost:3456/api/sessions?code=c")).toBe(false);
    expect(isLoopbackCallback("http://localhost:7498/callback")).toBe(false);
  });
});

describe("deliverLoopbackCallback", () => {
  const url = "http://127.0.0.1:38083/callback/x?code=c";

  it("requests the URL without following redirects, and reports success", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    expect(await deliverLoopbackCallback(url, fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "manual" }));
  });

  it("never requests a URL that is not a loopback redirect", async () => {
    const fetchImpl = vi.fn();
    expect(await deliverLoopbackCallback("http://evil.example/callback?code=1", fetchImpl as unknown as typeof fetch)).toMatch(/Paste the full address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a listener error or a listener that is gone", async () => {
    expect(await deliverLoopbackCallback(url, (async () => new Response("", { status: 500 })) as unknown as typeof fetch)).toBe("The login listener answered 500");
    const gone = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await deliverLoopbackCallback(url, gone)).toMatch(/did not answer: ECONNREFUSED/);
    const odd = (async () => { throw "boom"; }) as unknown as typeof fetch;
    expect(await deliverLoopbackCallback(url, odd)).toMatch(/did not answer: boom/);
  });
});
