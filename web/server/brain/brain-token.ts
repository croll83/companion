import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFile } from "../private-file.js";
import { brainDir } from "./brain-store.js";

/**
 * Keys of an EMBEDDED brain, all derived from its `secret` file (32 random
 * bytes, hex, 0600, created with the brain):
 *
 *  - the token key (BRAIN_TOKEN_KEY of the child): signs the per-session
 *    `brn_<base64url(domain|sessionId)>.<hmac>` tokens Companion mints at
 *    every spawn, so the brain knows which session wrote a note and no
 *    session can pass itself off as another;
 *  - the curator key (BRAIN_CURATOR_KEY, sent as X-Brain-Key): opens the
 *    child's /api/v1, which only Companion's server calls.
 *
 * Tokens never expire: replacing `secret` (and restarting the brain) revokes
 * every token and the curator key at once. A remote brain's `secret` holds
 * its bearer token instead and is never read here.
 *
 * The child verifies tokens with its own copy of this format (token.ts of
 * the brains core, inside the bundle): the two must stay in step.
 */

const PREFIX = "brn_";

function secretFile(slug: string): string {
  return join(brainDir(slug), "secret");
}

function readSecret(slug: string): string | null {
  try {
    const hex = readFileSync(secretFile(slug), "utf-8").trim();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch {
    return null;
  }
}

/** Create the brain's secret when it has none (a new embedded brain). The folder must exist. */
export function ensureEmbeddedSecret(slug: string): void {
  if (readSecret(slug)) return;
  writePrivateFile(secretFile(slug), `${randomBytes(32).toString("hex")}\n`);
}

/** The child's keys, derived from the secret; null when the brain has no valid secret. */
export function embeddedKeys(slug: string): { tokenKey: string; curatorKey: string } | null {
  const secret = readSecret(slug);
  if (!secret) return null;
  const derive = (label: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(label).digest("hex");
  return { tokenKey: derive("companion-brain-token-key"), curatorKey: derive("companion-brain-curator-key") };
}

function signature(tokenKey: string, payload: string): string {
  return createHmac("sha256", tokenKey).update(payload).digest("base64url");
}

/** A session's token for an embedded brain; null when the brain has no secret. */
export function mintBrainToken(slug: string, domain: string, sessionId: string): string | null {
  const keys = embeddedKeys(slug);
  if (!keys) return null;
  const payload = Buffer.from(`${domain}|${sessionId}`).toString("base64url");
  return `${PREFIX}${payload}.${signature(keys.tokenKey, payload)}`;
}

/** Whether `token` is a `brn_` token signed for this brain (checked by the proxy before forwarding). */
export function isValidBrainToken(slug: string, token: string | null | undefined): boolean {
  if (!token?.startsWith(PREFIX)) return false;
  const keys = embeddedKeys(slug);
  if (!keys) return false;
  const [payload, sig, extra] = token.slice(PREFIX.length).split(".");
  if (!payload || !sig || extra !== undefined) return false;
  const given = Buffer.from(sig);
  const expected = Buffer.from(signature(keys.tokenKey, payload));
  return given.length === expected.length && timingSafeEqual(given, expected);
}
