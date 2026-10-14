// Runtime configuration of the brain server, read once from the environment.
// Invalid values stop the start (fail closed).
//
// Identity and prose come from the environment, so the same code serves any
// wiki: BRAIN_NAME (MCP server and skill name, e.g. "work-brain"),
// BRAIN_TITLE ("Work brain"), BRAIN_OWNER (whose knowledge base it is),
// BRAIN_ABOUT (one paragraph on what it covers), BRAIN_LANGUAGE (stemming).
//
// Authentication is optional and additive:
//  - BRAIN_TOKEN_KEY set: /mcp requires a `brn_` token signed with it
//    (Companion mints one per session, token.ts);
//  - BRAIN_CURATOR_KEY set: /api/v1/* requires the X-Brain-Key header.
// Without them a stock MCP client works with no credentials; the server may
// then listen only on loopback or on a Tailscale address (100.64.0.0/10).

import { BRAIN_PROTOCOL } from "./version.js";
import { LANGUAGES, type Language } from "./search.js";

export interface Config {
  host: string;
  /** 0 = an ephemeral port, printed on stdout once bound (the ready line). */
  port: number;
  wikiDir: string;
  dataDir: string;
  /** MCP server name, tool namespace and skill name. */
  name: string;
  title: string;
  owner: string;
  about: string;
  language: Language;
  /** How often the wiki folder is re-read, in seconds (0 = never; SIGHUP or /api/v1/admin/refresh force a reload). */
  refreshSeconds: number;
  /** Replace secrets with [REDACTED:<rule>] in what the MCP tools return. */
  redactSecrets: boolean;
  /** Extra Host header names accepted besides the bind address (e.g. a MagicDNS name). */
  allowedHosts: string[];
  /** E-mail domains that inbox notes may contain (any other address counts as personal data). */
  allowedEmailDomains: string[];
  /** Wiki-derived topics in the public skill (GET /skill): "index" = index.md titles and tags, "none" = only the about text. */
  skillTopics: SkillTopics;
  /** Operator description of the skill (one line); undefined = built from the title and about text. */
  skillDescription?: string;
  /** HMAC key of the `brn_` session tokens; undefined = /mcp needs no token. */
  tokenKey?: string;
  /** The X-Brain-Key of /api/v1; undefined = the API needs no key. */
  curatorKey?: string;
  /** Notes per hour from all sessions together (a swarm of agents cannot flood the inbox). */
  maxNotesPerHour: number;
}

export const SKILL_TOPICS = ["index", "none"] as const;
export type SkillTopics = (typeof SKILL_TOPICS)[number];
/** Longest skill description accepted by Claude Code and Codex. */
export const MAX_SKILL_DESCRIPTION = 1000;

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

export function isLoopback(host: string): boolean {
  return LOOPBACK.includes(host);
}

export function isTailnet(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return a >= 64 && a <= 127 && b <= 255 && c <= 255;
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false" (got ${JSON.stringify(value)})`);
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value === undefined || value === "" ? fallback : value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} is not valid (an integer from ${min} to ${max})`);
  return n;
}

function oneLine(name: string, value: string | undefined, max: number): string | undefined {
  const v = value?.trim() || undefined;
  if (v === undefined) return undefined;
  if (/[\r\n]/.test(v)) throw new Error(`${name} must be one line`);
  if (v.length > max) throw new Error(`${name} is longer than ${max} characters`);
  return v;
}

/** A secret from the environment: at least 32 characters, no whitespace. */
function key(name: string, value: string | undefined): string | undefined {
  const v = value?.trim() || undefined;
  if (v === undefined) return undefined;
  if (v.length < 32 || /\s/.test(v)) throw new Error(`${name} must be at least 32 characters without spaces`);
  return v;
}

/** BRAIN_PROTOCOL, when set, must be the bundle's: a half-updated install must not start. */
export function checkProtocol(env: NodeJS.ProcessEnv): void {
  const p = env.BRAIN_PROTOCOL?.trim();
  if (p && p !== String(BRAIN_PROTOCOL)) {
    throw new Error(`BRAIN_PROTOCOL mismatch: Companion expects protocol ${p}, this brain bundle speaks ${BRAIN_PROTOCOL} (reinstall or rebuild Companion)`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  checkProtocol(env);
  const tokenKey = key("BRAIN_TOKEN_KEY", env.BRAIN_TOKEN_KEY);
  const curatorKey = key("BRAIN_CURATOR_KEY", env.BRAIN_CURATOR_KEY);
  const host = env.BRAIN_HOST?.trim() || "127.0.0.1";
  if (!isLoopback(host) && !isTailnet(host)) {
    throw new Error(`BRAIN_HOST must be a loopback address or a Tailscale address (100.64.0.0/10) (got ${JSON.stringify(host)})`);
  }
  const port = int("BRAIN_PORT", env.BRAIN_PORT, 7421, 0, 65535);
  const wikiDir = env.BRAIN_WIKI_DIR;
  const dataDir = env.BRAIN_DATA_DIR;
  if (!wikiDir) throw new Error("BRAIN_WIKI_DIR is required");
  if (!dataDir) throw new Error("BRAIN_DATA_DIR is required");
  const name = env.BRAIN_NAME?.trim() || "brain";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("BRAIN_NAME must be lowercase letters, digits and hyphens (e.g. work-brain)");
  const owner = oneLine("BRAIN_OWNER", env.BRAIN_OWNER, 80) ?? "the user";
  const title = oneLine("BRAIN_TITLE", env.BRAIN_TITLE, 80) ?? name;
  const language = (env.BRAIN_LANGUAGE?.trim() || "auto") as Language;
  if (!(LANGUAGES as readonly string[]).includes(language)) throw new Error(`BRAIN_LANGUAGE must be one of ${LANGUAGES.join(", ")}`);
  const topics = env.BRAIN_SKILL_TOPICS?.trim() || "index";
  if (!(SKILL_TOPICS as readonly string[]).includes(topics)) throw new Error(`BRAIN_SKILL_TOPICS must be one of ${SKILL_TOPICS.join(", ")}`);
  return {
    host,
    port,
    wikiDir,
    dataDir,
    name,
    title,
    owner,
    about: (env.BRAIN_ABOUT ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
    language,
    refreshSeconds: int("BRAIN_REFRESH_SECONDS", env.BRAIN_REFRESH_SECONDS, 120, 0, 86_400),
    redactSecrets: bool("BRAIN_REDACT_SECRETS", env.BRAIN_REDACT_SECRETS, true),
    allowedHosts: list(env.BRAIN_ALLOWED_HOSTS),
    allowedEmailDomains: list(env.BRAIN_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, "")),
    skillTopics: topics as SkillTopics,
    skillDescription: oneLine("BRAIN_SKILL_DESCRIPTION", env.BRAIN_SKILL_DESCRIPTION, MAX_SKILL_DESCRIPTION),
    tokenKey,
    curatorKey,
    maxNotesPerHour: int("BRAIN_MAX_NOTES_PER_HOUR", env.BRAIN_MAX_NOTES_PER_HOUR, 1000, 1, 1_000_000),
  };
}
