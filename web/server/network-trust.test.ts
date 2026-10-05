import { describe, it, expect } from "vitest";
import {
  forwardedAddresses,
  isTailscaleIPv4,
  isTrustedNetworkAddress,
  isTrustedRequest,
  socketAddress,
} from "./network-trust.js";

// These checks guard the agent webhook, which is authenticated by its secret
// only: anything that is not this machine or the tailnet must be refused.

describe("isTailscaleIPv4", () => {
  it("matches exactly 100.64.0.0/10", () => {
    expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
    expect(isTailscaleIPv4("100.127.255.254")).toBe(true);
    expect(isTailscaleIPv4("::ffff:100.100.1.1")).toBe(true);
    // Just outside the range on both sides
    expect(isTailscaleIPv4("100.63.255.255")).toBe(false);
    expect(isTailscaleIPv4("100.128.0.1")).toBe(false);
    expect(isTailscaleIPv4("10.0.0.1")).toBe(false);
    expect(isTailscaleIPv4("100.64.0")).toBe(false);
    expect(isTailscaleIPv4("100.64.0.256")).toBe(false);
  });
});

describe("isTrustedNetworkAddress", () => {
  it("trusts IPv4 and IPv6 loopback, including mapped forms", () => {
    for (const addr of ["127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      expect(isTrustedNetworkAddress(addr)).toBe(true);
    }
  });

  it("trusts Tailscale IPv4 and fd7a:115c:a1e0::/48 IPv6", () => {
    expect(isTrustedNetworkAddress("100.101.102.103")).toBe(true);
    expect(isTrustedNetworkAddress("fd7a:115c:a1e0::1")).toBe(true);
    expect(isTrustedNetworkAddress("FD7A:115C:A1E0:AB12:4843:CD96:6258:B240")).toBe(true);
    expect(isTrustedNetworkAddress("fd7a:115c:a1e0:ab12::5%tailscale0")).toBe(true);
  });

  it("refuses LAN, public, other ULA and malformed addresses", () => {
    for (const addr of [
      "", "192.168.1.10", "10.1.2.3", "8.8.8.8", "203.0.113.7",
      "fd7a:115c:a1e1::1", // next /48
      "fd00::1", "2001:db8::1", "::", "::2",
      "unknown", "1:2:3:4:5:6:7:8::", "1::2::3", "fd7a:115c:a1e0:zzzz::1",
      "::ffff:8.8.8.8",
    ]) {
      expect(isTrustedNetworkAddress(addr), addr).toBe(false);
    }
  });
});

describe("forwardedAddresses", () => {
  it("collects every address from the common forwarding headers", () => {
    const headers = new Headers({
      "X-Forwarded-For": "198.51.100.4, 100.64.0.2",
      "X-Real-IP": "100.64.0.3",
      "CF-Connecting-IP": "2001:db8::7",
      Forwarded: 'for=192.0.2.60;proto=http, for="[2001:db8:cafe::17]:4711", for=unknown',
    });
    expect(forwardedAddresses(headers)).toEqual([
      "198.51.100.4", "100.64.0.2", "100.64.0.3", "2001:db8::7",
      "192.0.2.60", "2001:db8:cafe::17", "unknown",
    ]);
  });

  it("strips ports from IPv4 entries and ignores Forwarded parts without for=", () => {
    const headers = new Headers({ "X-Forwarded-For": "100.64.0.2:5555", Forwarded: "proto=https" });
    expect(forwardedAddresses(headers)).toEqual(["100.64.0.2"]);
  });
});

describe("isTrustedRequest", () => {
  it("needs a trusted socket peer", () => {
    expect(isTrustedRequest(undefined, new Headers())).toBe(false);
    expect(isTrustedRequest("203.0.113.7", new Headers())).toBe(false);
    expect(isTrustedRequest("100.64.1.1", new Headers())).toBe(true);
  });

  it("also needs every forwarded address to be trusted (local proxies/tunnels)", () => {
    // A tunnel on this host connects from loopback; the real client is in the
    // header. A spoofed trusted entry does not help: the proxy appends the
    // real address, and all of them must be trusted.
    expect(isTrustedRequest("127.0.0.1", new Headers({ "X-Forwarded-For": "8.8.8.8" }))).toBe(false);
    expect(isTrustedRequest("127.0.0.1", new Headers({ "X-Forwarded-For": "100.64.0.9, 8.8.8.8" }))).toBe(false);
    expect(isTrustedRequest("127.0.0.1", new Headers({ "X-Forwarded-For": "100.64.0.9" }))).toBe(true);
    expect(isTrustedRequest("::1", new Headers({ Forwarded: "for=unknown" }))).toBe(false);
  });
});

describe("socketAddress", () => {
  it("reads the peer address from the Bun server env, if any", () => {
    const req = new Request("http://localhost/");
    expect(socketAddress({ requestIP: () => ({ address: "100.64.0.1" }) }, req)).toBe("100.64.0.1");
    expect(socketAddress({ requestIP: () => null }, req)).toBeUndefined();
    expect(socketAddress(undefined, req)).toBeUndefined();
  });
});
