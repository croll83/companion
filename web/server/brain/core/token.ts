// Session identity tokens minted by Companion for each session it connects to
// an embedded brain:
//
//   brn_<base64url("<domain>|<sessionId>")>.<base64url(hmac-sha256(BRAIN_TOKEN_KEY, payload))>
//
// The author of an inbox note is then the session that wrote it, and a
// session cannot pass itself off as another (an X-Session header could be
// set by anyone). Tokens never expire: rotating the key revokes them all.
// Companion's server has its own copy of the minting side (brain-token.ts):
// it never imports this core, which runs only inside the bundle.

import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_PREFIX = "brn_";

export interface TokenClaims {
  domain: string;
  sessionId: string;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(key: string, payload: string): string {
  return b64url(createHmac("sha256", key).update(payload).digest());
}

/** The claims of a valid token, or null (wrong prefix, shape, encoding or signature). */
export function verifyToken(key: string, token: string | null | undefined): TokenClaims | null {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(sign(key, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const bar = decoded.indexOf("|");
  if (bar <= 0 || bar === decoded.length - 1) return null;
  return { domain: decoded.slice(0, bar), sessionId: decoded.slice(bar + 1) };
}

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  return m ? m[1] : null;
}

/** Mint a token (used by tests and by the smoke script; Companion mints its own). */
export function mintToken(key: string, claims: TokenClaims): string {
  const payload = b64url(`${claims.domain}|${claims.sessionId}`);
  return `${TOKEN_PREFIX}${payload}.${sign(key, payload)}`;
}
