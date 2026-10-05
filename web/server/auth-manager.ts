import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { COMPANION_HOME, legacyStatePath } from "./paths.js";
import { isTailscaleIPv4 } from "./network-trust.js";

const DEFAULT_AUTH_FILE = join(COMPANION_HOME, "auth.json");
// Versions before COMPANION_HOME was honoured here always used ~/.companion.
const DEFAULT_LEGACY_AUTH_FILE = legacyStatePath("auth.json");
let authFile = DEFAULT_AUTH_FILE;
let legacyAuthFile = DEFAULT_LEGACY_AUTH_FILE;
const TOKEN_BYTES = 32; // 64 hex characters

interface AuthData {
  token: string;
  createdAt: number;
}

let cachedToken: string | null = null;

/**
 * Get the auth token. Priority:
 * 1. COMPANION_AUTH_TOKEN env var
 * 2. Persisted token from COMPANION_HOME/auth.json (falling back to the
 *    ~/.companion/auth.json older versions wrote, copied over so the token —
 *    and every device logged in with it — survives the move)
 * 3. Auto-generate and persist a new token
 */
export function getToken(): string {
  // Env var override (always takes priority)
  const envToken = process.env.COMPANION_AUTH_TOKEN;
  if (envToken && envToken.trim()) {
    cachedToken = envToken.trim();
    return cachedToken;
  }

  // Return cached token if available
  if (cachedToken) return cachedToken;

  const persisted = readTokenFile(authFile);
  if (persisted) {
    cachedToken = persisted;
    return cachedToken;
  }
  const legacy = legacyAuthFile ? readTokenFile(legacyAuthFile) : null;
  if (legacy) {
    persistToken(legacy, "migrate legacy auth token");
    cachedToken = legacy;
    return cachedToken;
  }

  // Generate new token
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  persistToken(token, "persist auth token");
  cachedToken = token;
  return token;
}

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuthData>;
    return typeof data.token === "string" && data.token.length >= 32 ? data.token : null;
  } catch {
    // File corrupt or unreadable
    return null;
  }
}

function persistToken(token: string, what: string): void {
  const data: AuthData = { token, createdAt: Date.now() };
  try {
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error(`[auth] Failed to ${what}:`, err);
  }
}

/**
 * Verify a candidate token using constant-time comparison.
 */
export function verifyToken(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getToken();
  const candidateBuf = Buffer.from(candidate);
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

/**
 * Get the primary LAN IP address for QR code URL generation.
 * Falls back to "localhost" if no LAN IP is found.
 */
export function getLanAddress(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "localhost";
}

/**
 * Get all available access addresses: localhost, LAN IP, and Tailscale IP.
 * Tailscale uses 100.x.x.x addresses (CGNAT range) on utun / tailscale interfaces.
 */
export function getAllAddresses(): { label: string; ip: string }[] {
  const result: { label: string; ip: string }[] = [
    { label: "Localhost", ip: "localhost" },
  ];

  const interfaces = networkInterfaces();
  let lanIp: string | null = null;
  let tailscaleIp: string | null = null;

  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;

      // Tailscale uses 100.64.0.0/10 (CGNAT) — detect by IP range
      if (isTailscaleIPv4(addr.address)) {
        tailscaleIp = addr.address;
        continue;
      }

      if (!lanIp) lanIp = addr.address;
    }
  }

  if (lanIp) result.push({ label: "LAN", ip: lanIp });
  if (tailscaleIp) result.push({ label: "Tailscale", ip: tailscaleIp });

  return result;
}

/**
 * Regenerate the auth token — creates a new random token, persists it,
 * and returns the new value.  Existing sessions using the old token will
 * be invalidated on their next request.
 */
export function regenerateToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  persistToken(token, "persist regenerated token");
  cachedToken = token;
  return token;
}

/** Reset cached state, optionally pointing at other files — for testing only */
export function _resetForTest(paths?: { authFile: string; legacyAuthFile: string | null }): void {
  cachedToken = null;
  authFile = paths?.authFile ?? DEFAULT_AUTH_FILE;
  legacyAuthFile = paths ? paths.legacyAuthFile : DEFAULT_LEGACY_AUTH_FILE;
}
