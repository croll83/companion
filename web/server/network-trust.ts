/**
 * Network origin checks for endpoints that authenticate with something other
 * than the Companion token (the agent webhook trigger). Such endpoints must
 * never be reachable from the internet: only this machine (loopback) and the
 * tailnet are trusted.
 *
 * Trusted ranges:
 *  - loopback: 127.0.0.0/8, ::1 (and their IPv4-mapped forms)
 *  - Tailscale IPv4: the CGNAT range 100.64.0.0/10
 *  - Tailscale IPv6: fd7a:115c:a1e0::/48
 */

/** Strip an IPv4-mapped IPv6 prefix ("::ffff:1.2.3.4" → "1.2.3.4"). */
function unmapIPv4(addr: string): string {
  const lower = addr.toLowerCase();
  return lower.startsWith("::ffff:") && lower.includes(".") ? lower.slice(7) : lower;
}

function parseIPv4(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

/** True for an address in Tailscale's IPv4 range 100.64.0.0/10. */
export function isTailscaleIPv4(addr: string): boolean {
  const octets = parseIPv4(unmapIPv4(addr));
  return !!octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Expand an IPv6 address into its 8 hextets (numbers); null if malformed. */
function parseIPv6(addr: string): number[] | null {
  const zoneless = addr.split("%")[0];
  if (!/^[0-9a-f:]+$/i.test(zoneless)) return null;
  const halves = zoneless.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return values.every((v) => Number.isInteger(v)) ? values : null;
}

/** True when `addr` is loopback, Tailscale IPv4 or Tailscale IPv6. */
export function isTrustedNetworkAddress(addr: string): boolean {
  if (!addr) return false;
  const v4 = parseIPv4(unmapIPv4(addr));
  if (v4) return v4[0] === 127 || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127);
  const v6 = parseIPv6(addr.toLowerCase());
  if (!v6) return false;
  const isLoopback = v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
  const isTailscale = v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0;
  return isLoopback || isTailscale;
}

/**
 * TCP peer address of a request, from Bun's `server.requestIP` (Hono passes
 * the Bun server as `c.env`). Undefined where there is no Bun server.
 */
export function socketAddress(env: unknown, req: Request): string | undefined {
  const server = env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(req)?.address;
}

/** Headers a reverse proxy or tunnel uses to pass on the real client address. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "forwarded"];

/**
 * Client addresses claimed by forwarding headers. A request relayed by a local
 * proxy or tunnel (cloudflared, nginx, ...) reaches us from loopback, so the
 * socket address alone would wrongly trust internet traffic. RFC 7239
 * `Forwarded: for=` values are reduced to the bare address.
 */
export function forwardedAddresses(headers: Headers): string[] {
  const out: string[] = [];
  for (const name of FORWARDING_HEADERS) {
    const value = headers.get(name);
    if (!value) continue;
    for (const raw of value.split(",")) {
      let entry = raw.trim();
      if (name === "forwarded") {
        const match = /for=("?)([^;"]*)\1/i.exec(entry);
        if (!match) continue;
        entry = match[2];
      }
      // "[v6]:port" → v6, "v4:port" → v4
      const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
      if (bracketed) entry = bracketed[1];
      else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(entry)) entry = entry.split(":")[0];
      // Unparseable entries ("unknown", obfuscated ids) count as untrusted.
      out.push(entry);
    }
  }
  return out;
}

/**
 * The request is trusted only if the socket peer AND every address named in
 * forwarding headers are trusted. Appended proxy entries cannot be removed by
 * a client, so spoofing a trusted address in the header does not help.
 */
export function isTrustedRequest(socketAddress: string | undefined, headers: Headers): boolean {
  if (!socketAddress || !isTrustedNetworkAddress(socketAddress)) return false;
  return forwardedAddresses(headers).every(isTrustedNetworkAddress);
}
