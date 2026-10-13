import {
  applyServerSkill,
  brainServerName,
  brainUrls,
  getBrain,
  readBrainToken,
  readServerSkill,
  type BrainConfig,
} from "./brain-store.js";
import { errorText, sameOrigin, type FetchLike } from "./brain-probe.js";

/**
 * "Skill from the server": a brain server may publish its own skill at
 * `<base>/skill` (jarvis-brain and hercle-brain do), a public endpoint:
 *
 *   { "skill_api": 1, "name", "description", "skill_md", "server_version",
 *     "content_hash": "<wiki content hash or null>", "tools": [...] }
 *
 * Companion's server fetches it (never the browser), validates it and stores
 * the SKILL.md as the brain's skill (brain-store.ts applyServerSkill), renamed
 * `<slug>-brain` like every brain skill. The text is untrusted: it is only
 * ever written to the skill file and shown as plain text, never executed or
 * rendered as HTML, and it is capped at MAX_SKILL_BYTES.
 *
 * Auth: none for "none" and "oauth" brains (the endpoint is public by design,
 * and Companion never holds the CLIs' OAuth tokens); a bearer brain's token
 * goes along only to the MCP server's own origin, like the health check.
 * Tokens are never logged or put in an error message.
 */

export const SKILL_API = 1;
/** Largest skill Companion accepts (the JSON answer, skill text included). */
export const MAX_SKILL_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 1000;

export interface ServerSkillDoc {
  skill_api: typeof SKILL_API;
  name: string;
  description: string;
  skill_md: string;
  server_version?: string;
  content_hash: string | null;
  tools?: string[];
}

export type SkillFetchResult =
  | { kind: "fetched"; doc: ServerSkillDoc; etag?: string }
  | { kind: "unchanged"; etag?: string }
  | { kind: "failed"; reason: "missing" | "http" | "invalid" | "too-large" | "unreachable"; status?: number; error: string };

export interface SkillFetchOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Sent as If-None-Match (a 304 means the stored skill is current). */
  etag?: string;
}

/** The body as text, or null when it is larger than `max` bytes (reading stops there). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The frontmatter block and the body of a SKILL.md, or null when it has none. */
function splitSkill(md: string): { frontmatter: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  return m ? { frontmatter: m[1], body: md.slice(m[0].length) } : null;
}

/** Check the JSON of `<base>/skill` against the contract; an error text when it does not hold. */
export function validateServerSkill(value: unknown): ServerSkillDoc | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "the answer is not a JSON object";
  const v = value as Record<string, unknown>;
  if (v.skill_api !== SKILL_API) return `unsupported skill_api ${JSON.stringify(v.skill_api ?? null)} (Companion reads ${SKILL_API})`;
  if (typeof v.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.name)) return "name must be a lowercase skill name";
  if (typeof v.description !== "string" || !v.description.trim()) return "description is missing";
  if (/[\r\n]/.test(v.description) || v.description.length > MAX_DESCRIPTION) return `description must be one line of at most ${MAX_DESCRIPTION} characters`;
  if (typeof v.skill_md !== "string" || !v.skill_md.trim()) return "skill_md is missing";
  const parts = splitSkill(v.skill_md);
  if (!parts) return "skill_md has no frontmatter";
  if (!/^name:\s*\S/m.test(parts.frontmatter)) return "the frontmatter of skill_md has no name";
  if (!/^description:\s*\S/m.test(parts.frontmatter)) return "the frontmatter of skill_md has no description";
  if (!parts.body.trim()) return "skill_md has no body";
  if (v.content_hash !== undefined && v.content_hash !== null && typeof v.content_hash !== "string") return "content_hash must be a string or null";
  if (v.tools !== undefined && (!Array.isArray(v.tools) || v.tools.some((t) => typeof t !== "string"))) return "tools must be a list of names";
  return {
    skill_api: SKILL_API,
    name: v.name,
    description: v.description.trim(),
    skill_md: v.skill_md,
    ...(typeof v.server_version === "string" ? { server_version: v.server_version } : {}),
    content_hash: typeof v.content_hash === "string" ? v.content_hash : null,
    ...(Array.isArray(v.tools) ? { tools: v.tools as string[] } : {}),
  };
}

/**
 * The server's SKILL.md as Companion installs it: the frontmatter rebuilt
 * with Companion's skill name (`<slug>-brain`, the name of its folder and of
 * the MCP server) and the validated one-line description; the body as is.
 */
export function installedSkillText(doc: ServerSkillDoc, slug: string): string {
  const body = splitSkill(doc.skill_md)?.body ?? "";
  return `---\nname: ${brainServerName(slug)}\ndescription: ${JSON.stringify(doc.description)}\n---\n${body.replace(/^\r?\n?/, "\n").replace(/\s*$/, "\n")}`;
}

/** GET `<base>/skill` (5 s timeout by default). */
export async function fetchServerSkill(brain: BrainConfig, opts: SkillFetchOptions = {}): Promise<SkillFetchResult> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const { skillUrl, mcpUrl } = brainUrls(brain);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.etag) headers["If-None-Match"] = opts.etag;
  if (brain.remote?.auth.mode === "bearer" && sameOrigin(skillUrl, mcpUrl)) {
    const token = readBrainToken(brain.slug);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await doFetch(skillUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { kind: "failed", reason: "unreachable", error: `the server could not be reached: ${errorText(err, timeoutMs)}` };
  }
  const etag = res.headers.get("etag") ?? undefined;
  if (res.status === 304) {
    await res.body?.cancel().catch(() => {});
    return { kind: "unchanged", ...(etag ? { etag } : {}) };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return res.status === 404
      ? { kind: "failed", reason: "missing", status: 404, error: "the server does not publish a skill (HTTP 404 on /skill)" }
      : { kind: "failed", reason: "http", status: res.status, error: `HTTP ${res.status} on /skill` };
  }
  let text: string | null;
  try {
    text = await readCapped(res, MAX_SKILL_BYTES);
  } catch (err) {
    return { kind: "failed", reason: "unreachable", error: `the answer could not be read: ${errorText(err, timeoutMs)}` };
  }
  if (text === null) return { kind: "failed", reason: "too-large", error: `the skill is larger than ${MAX_SKILL_BYTES / 1024} KB` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "failed", reason: "invalid", error: "the answer of /skill is not JSON" };
  }
  const doc = validateServerSkill(json);
  if (typeof doc === "string") return { kind: "failed", reason: "invalid", error: `invalid skill: ${doc}` };
  return { kind: "fetched", doc, ...(etag ? { etag } : {}) };
}

export interface SkillRefreshOptions extends Omit<SkillFetchOptions, "etag"> {
  /**
   * Reuse the stored ETag (If-None-Match). Off when the brain's URL or auth
   * just changed: the stored skill may come from another server.
   */
  conditional?: boolean;
  /** For a 304: the wiki version the stored skill now stands for (from the health check). */
  contentHash?: string;
}

export interface SkillRefreshResult {
  outcome: "updated" | "unchanged" | "failed";
  error?: string;
  brain?: BrainConfig;
}

/**
 * Fetch a brain's skill and store the outcome: a new skill (source becomes
 * "server"), "unchanged" (304), or a note when it failed (see
 * applyServerSkill: a failure never loses a usable skill).
 */
export async function refreshBrainSkill(slug: string, opts: SkillRefreshOptions = {}): Promise<SkillRefreshResult> {
  const brain = getBrain(slug);
  if (!brain) return { outcome: "failed", error: "Brain not found" };
  const conditional = (opts.conditional ?? true) && brain.skill.source === "server" && !!readServerSkill(slug);
  const etag = conditional ? brain.skill.server?.etag : undefined;
  const r = await fetchServerSkill(brain, { fetch: opts.fetch, timeoutMs: opts.timeoutMs, ...(etag ? { etag } : {}) });
  const now = Date.now();
  if (r.kind === "fetched") {
    const next = applyServerSkill(slug, {
      kind: "fetched",
      text: installedSkillText(r.doc, slug),
      meta: {
        fetchedAt: now,
        ...(r.etag ? { etag: r.etag } : {}),
        contentHash: r.doc.content_hash,
        ...(r.doc.server_version ? { serverVersion: r.doc.server_version } : {}),
        name: r.doc.name,
      },
    });
    return { outcome: "updated", brain: next };
  }
  if (r.kind === "unchanged") {
    const next = applyServerSkill(slug, { kind: "unchanged", fetchedAt: now, ...(opts.contentHash !== undefined ? { contentHash: opts.contentHash } : {}) });
    return { outcome: next?.skill.note ? "failed" : "unchanged", brain: next, ...(next?.skill.note ? { error: next.skill.note } : {}) };
  }
  const fallback = brain.skill.source === "server" && readServerSkill(slug)
    ? "the last fetched skill stays in use"
    : brain.skill.source === "custom" ? "the custom skill stays in use" : "using the generated skill";
  const note = `Skill from the server unavailable: ${r.error}; ${fallback}.`;
  const next = applyServerSkill(slug, { kind: "failed", note });
  return { outcome: "failed", error: note, brain: next };
}

/**
 * After a health check: a "server" skill built from another wiki version
 * than the one the server now reports is fetched again (a 304 just records
 * the new version). Null when nothing had to be done.
 */
export async function refreshSkillOnNewContent(
  brain: BrainConfig,
  healthHash: string | undefined,
  opts: Omit<SkillRefreshOptions, "conditional" | "contentHash"> = {},
): Promise<SkillRefreshResult | null> {
  const stored = brain.skill.source === "server" ? brain.skill.server?.contentHash : null;
  if (!stored || !healthHash || stored === healthHash) return null;
  return refreshBrainSkill(brain.slug, { ...opts, conditional: true, contentHash: healthHash });
}
