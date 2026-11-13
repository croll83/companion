import { Cron } from "croner";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { scheduleTimeZone } from "../agent-schedule.js";
import { domainMemoryDir, effectiveBrainSlug, ensureGlobalDomain, GLOBAL_DOMAIN, listDomains } from "../domain-store.js";
import { ensurePrivateDir, writePrivateFile } from "../private-file.js";
import { curatorFetch, type CuratorOptions } from "./brain-curator.js";
import { brainDir, getBrain, listBrains, normalizeHttpUrl, type BrainConfig } from "./brain-store.js";

/**
 * Memory sync: every night Companion sends the memory files of the domains
 * that use a brain to that brain, so the brain (shared with other domains and
 * agents) stays in line with the domain memory without relying on the agent
 * remembering to write a note. One way only, and the memory is only read.
 *
 * A file goes when it is new or changed since the last send (sha-256 of its
 * text), whole, as a source the brain's consolidation turns into pages; a
 * changed file carries the lines that changed, so the consolidation can merge
 * just those. A deleted file sends a notice. MEMORY.md (the index) never goes.
 *
 * Remote brains get it through the brain's ingest API (`POST <ingest
 * URL>/api/v1/ingest/text`, the management listener of a brains server,
 * with an optional curator token); embedded brains through their curator API
 * (`/sources`, the same path as "Add source").
 *
 * Nothing private goes: PEM blocks of private keys and certificates are
 * replaced, and so are crypto keys and seed phrases on lines that name them;
 * a file with `brain: no` in its frontmatter is skipped. What was skipped or
 * replaced is in the run report.
 *
 * Files under the brain's folder (deleted with the brain):
 *  - memory-sync.json: the settings; memory-sync-token: the ingest token (0600);
 *  - memory-sync/<domain>/state.json: hash and time of the last send per file;
 *  - memory-sync/<domain>/sent/<file>: the text last sent (for the next diff);
 *  - memory-sync/runs.jsonl: the run reports, newest last.
 */

export interface MemorySyncConfig {
  enabled: boolean;
  /** 5-field cron in Companion's time zone. */
  schedule: string;
  /** Files sent per domain and run at most; the rest waits for the next run (reported). */
  maxFiles: number;
  /** Remote brains: the base URL of the brain's management API (where /api/v1/ingest lives). */
  ingestUrl?: string;
}

export const DEFAULT_MEMORY_SYNC_SCHEDULE = "0 3 * * *";
export const DEFAULT_MEMORY_SYNC_MAX_FILES = 40;
const MAX_FILES_LIMIT = 500;
const MIN_INTERVAL_MINUTES = 15;
const MAX_RUNS_KEPT = 30;
/** Lines of a diff shown in a source; the full text follows anyway. */
const MAX_DIFF_LINES = 400;
/** Beyond this many line pairs the diff is computed as two sets (no order). */
const MAX_LCS_CELLS = 4_000_000;
/** The ingest API caps a text at 2 MB; Companion's own "Add source" at 1 MB. */
const MAX_SOURCE_BYTES = 1_000_000;
/**
 * How long one source may take. A brains server stores each ingest as a git
 * commit: on a small instance with a large wiki that took about 40 s, and a
 * 30 s limit stopped the run while the brain was still accepting the file.
 */
export const SEND_TIMEOUT_MS = 300_000;

export type MemorySyncTrigger = "schedule" | "manual";

export interface DomainSyncReport {
  domain: string;
  sent: string[];
  deleted: string[];
  unchanged: number;
  /** Files changed or new that wait for the next run (maxFiles reached). */
  deferred: string[];
  skipped: { file: string; reason: string }[];
  redacted: { file: string; count: number }[];
  failed: { file: string; error: string }[];
}

export interface MemorySyncRun {
  at: number;
  trigger: MemorySyncTrigger;
  ok: boolean;
  /** Why the run did not go through (brain unreachable, not configured...). */
  error?: string;
  domains: DomainSyncReport[];
}

export interface MemorySyncView {
  config: MemorySyncConfig;
  tokenConfigured: boolean;
  /** The domains whose memory goes to this brain (their effective brain). */
  domains: string[];
  running: boolean;
  lastRun?: MemorySyncRun;
}

export type MemorySyncPatch = Partial<{ enabled: boolean; schedule: string; maxFiles: number; ingestUrl: string | null; token: string | null }>;

type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

// ── Settings ────────────────────────────────────────────────────────────────

function configPath(slug: string): string {
  return join(brainDir(slug), "memory-sync.json");
}

function tokenPath(slug: string): string {
  return join(brainDir(slug), "memory-sync-token");
}

function syncDir(slug: string): string {
  return join(brainDir(slug), "memory-sync");
}

function normalizeConfig(raw: unknown): MemorySyncConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<MemorySyncConfig>;
  const ingestUrl = normalizeHttpUrl(c.ingestUrl);
  return {
    enabled: c.enabled === true,
    schedule: typeof c.schedule === "string" && c.schedule.trim() ? c.schedule.trim() : DEFAULT_MEMORY_SYNC_SCHEDULE,
    maxFiles: typeof c.maxFiles === "number" && Number.isInteger(c.maxFiles) && c.maxFiles >= 1 ? Math.min(c.maxFiles, MAX_FILES_LIMIT) : DEFAULT_MEMORY_SYNC_MAX_FILES,
    ...(ingestUrl ? { ingestUrl } : {}),
  };
}

export function readMemorySyncConfig(slug: string): MemorySyncConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(slug), "utf-8")));
  } catch {
    return normalizeConfig({});
  }
}

function readToken(slug: string): string | undefined {
  try {
    return readFileSync(tokenPath(slug), "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A cron Companion accepts: 5 fields, runs no more often than every 15 minutes. */
export function checkSchedule(schedule: string): string | null {
  let runs: Date[];
  try {
    runs = new Cron(schedule, { mode: "5-part", paused: true, timezone: scheduleTimeZone() }).nextRuns(4);
  } catch {
    return "The schedule must be a 5-field cron expression (minute hour day month weekday)";
  }
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60_000) return `The schedule may not run more often than every ${MIN_INTERVAL_MINUTES} minutes`;
  }
  return null;
}

/** Apply a settings change: validated, saved, token stored apart (never returned). */
export function updateMemorySync(slug: string, patch: MemorySyncPatch): Result<MemorySyncConfig> {
  const brain = getBrain(slug);
  if (!brain) return { ok: false, status: 404, error: "Brain not found" };
  const next: MemorySyncConfig = { ...readMemorySyncConfig(slug) };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, status: 400, error: "enabled must be true or false" };
    next.enabled = patch.enabled;
  }
  if (patch.schedule !== undefined) {
    const schedule = typeof patch.schedule === "string" ? patch.schedule.trim() : "";
    const bad = checkSchedule(schedule);
    if (bad) return { ok: false, status: 400, error: bad };
    next.schedule = schedule;
  }
  if (patch.maxFiles !== undefined) {
    if (typeof patch.maxFiles !== "number" || !Number.isInteger(patch.maxFiles) || patch.maxFiles < 1 || patch.maxFiles > MAX_FILES_LIMIT) {
      return { ok: false, status: 400, error: `maxFiles must be a whole number from 1 to ${MAX_FILES_LIMIT}` };
    }
    next.maxFiles = patch.maxFiles;
  }
  if (patch.ingestUrl !== undefined) {
    if (patch.ingestUrl === null || patch.ingestUrl === "") delete next.ingestUrl;
    else {
      const url = normalizeHttpUrl(patch.ingestUrl);
      if (!url) return { ok: false, status: 400, error: "The ingest URL must start with http:// or https://" };
      next.ingestUrl = url.replace(/\/api\/v1\/?$/, "");
    }
  }
  if (patch.token !== undefined && patch.token !== null && (typeof patch.token !== "string" || !/^[\x21-\x7e]{1,500}$/.test(patch.token.trim()))) {
    return { ok: false, status: 400, error: "The token must be printable characters without spaces" };
  }
  if (next.enabled && brain.kind === "remote" && !next.ingestUrl) {
    return { ok: false, status: 400, error: "A remote brain needs the URL of its ingest API (the brain server's management address)" };
  }
  ensurePrivateDir(brainDir(slug));
  writePrivateFile(configPath(slug), `${JSON.stringify(next, null, 2)}\n`);
  if (patch.token === null || patch.token === "") rmSync(tokenPath(slug), { force: true });
  else if (typeof patch.token === "string") writePrivateFile(tokenPath(slug), `${patch.token.trim()}\n`);
  return { ok: true, value: next };
}

/** The domains whose sessions use this brain: their memory is what goes. */
export function memorySyncDomains(slug: string): string[] {
  const global = ensureGlobalDomain();
  const out: string[] = [];
  for (const d of listDomains()) {
    const brain = d.slug === GLOBAL_DOMAIN ? global.brain ?? null : effectiveBrainSlug(d, global);
    if (brain === slug) out.push(d.slug);
  }
  return out.sort();
}

/**
 * The lines sessions of a domain read about memory sync (Claude's appended
 * prompt, Codex's AGENTS.md): empty when the domain's brain does not sync.
 */
export function memorySyncNotice(brain: Pick<BrainConfig, "slug" | "name"> | undefined | null): string[] {
  if (!brain || !readMemorySyncConfig(brain.slug).enabled) return [];
  return [
    "# Domain memory and the brain",
    "",
    `Companion sends this domain's memory files to the brain "${brain.name}" every night (memory sync). So:`,
    "- write new facts in the memory files as usual: they reach the brain without a note;",
    "- use the brain's note tool only to correct or complete brain pages on things the memory does not hold;",
    "- read the brain for knowledge shared with other domains and agents;",
    "- a memory file with `brain: no` in its frontmatter is never sent.",
    "",
  ];
}

// ── Memory files ────────────────────────────────────────────────────────────

export interface MemoryFile {
  name: string;
  text: string;
  hash: string;
  mtimeMs: number;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The memory files of a folder: top-level *.md except the MEMORY.md index. */
export function readMemoryFiles(dir: string): MemoryFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: MemoryFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name === "MEMORY.md" || name.startsWith(".")) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      const text = readFileSync(join(dir, name), "utf-8");
      files.push({ name, text, hash: sha256(text), mtimeMs: st.mtimeMs });
    } catch {
      /* vanished meanwhile */
    }
  }
  return files;
}

/** `brain: no` (or false/off) in the frontmatter keeps a file out of the brain. */
export function optedOut(text: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!fm && /^brain:\s*["']?(no|false|off)["']?\s*$/im.test(fm[1]);
}

const KEY_WORDS = /private[\s_-]?key|priv[\s_-]?key|chiave privata|secret[\s_-]?key|seed|mnemonic|wif\b|xprv/i;

/**
 * Replace what must never leave the machine: PEM blocks of private keys and
 * certificates anywhere; on lines naming a private key or seed, long hex or
 * base58 strings and 12-24 word phrases; extended private keys anywhere.
 */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  const swap = (label: string) => () => {
    count++;
    return `[omesso dall'invio al brain: ${label}]`;
  };
  let out = text.replace(/-----BEGIN ([A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*)-----[\s\S]*?(?:-----END \1-----|$)/g, (_m, label: string) => swap(label.toLowerCase())());
  out = out.replace(/\bxprv[1-9A-HJ-NP-Za-km-z]{100,}/g, swap("chiave privata estesa"));
  out = out
    .split("\n")
    .map((line) => {
      if (!KEY_WORDS.test(line)) return line;
      return line
        .replace(/\b(?:0x)?[0-9a-fA-F]{64,}\b/g, swap("chiave"))
        .replace(/\b[1-9A-HJ-NP-Za-km-z]{44,}\b/g, swap("chiave"))
        .replace(/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, swap("frase seed"));
    })
    .join("\n");
  return { text: out, count };
}

/**
 * The lines that changed from `before` to `after`, "- " removed and "+ "
 * added, in order (LCS); past MAX_LCS_CELLS, as two sets.
 */
export function diffLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_LCS_CELLS) {
    const inA = new Set(a);
    const inB = new Set(b);
    return [...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`)];
  }
  const n = a.length;
  const m = b.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function fit(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_SOURCE_BYTES) return text;
  let cut = text.slice(0, MAX_SOURCE_BYTES / 2);
  while (Buffer.byteLength(cut, "utf8") > MAX_SOURCE_BYTES - 200) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return `${cut}\n\n[testo troncato: il file supera 1 MB]\n`;
}

/** The source text of a new or changed file. */
export function sourceText(domain: string, file: string, text: string, now: number, previous?: { text: string; sentAt: number }): string {
  const lines = [`# Memoria del dominio ${domain}: ${file}`, "", `File di memoria delle sessioni Companion del dominio "${domain}", inviato in automatico il ${day(now)} UTC.`];
  if (previous) {
    const diff = diffLines(previous.text, text);
    const shown = diff.slice(0, MAX_DIFF_LINES);
    lines.push(
      `È un aggiornamento: la versione precedente è stata inviata il ${day(previous.sentAt)} UTC. Integra nelle pagine solo quello che è cambiato.`,
      "",
      "## Cosa è cambiato",
      "",
      "```diff",
      ...shown,
      "```",
      ...(diff.length > shown.length ? ["", `(altre ${diff.length - shown.length} righe cambiate: vedi il testo completo)`] : []),
    );
  }
  lines.push("", "## Testo completo", "", text);
  return fit(lines.join("\n"));
}

/** The source text of a file removed from the memory. */
export function deletedText(domain: string, file: string, now: number, last?: string): string {
  return fit([
    `# Memoria del dominio ${domain}: ${file} (eliminato)`,
    "",
    `Il file è stato tolto dalla memoria delle sessioni Companion del dominio "${domain}" (rilevato il ${day(now)} UTC).`,
    "Se una pagina riporta fatti presi solo da questo file, vanno verificati: possono essere superati o sbagliati.",
    ...(last ? ["", "## Ultima versione inviata", "", last] : []),
  ].join("\n"));
}

// ── State ───────────────────────────────────────────────────────────────────

interface SentFile {
  hash: string;
  sentAt: number;
}

interface DomainState {
  files: Record<string, SentFile>;
}

function domainDir(slug: string, domain: string): string {
  return join(syncDir(slug), domain);
}

function readState(slug: string, domain: string): DomainState {
  try {
    const raw = JSON.parse(readFileSync(join(domainDir(slug, domain), "state.json"), "utf-8")) as Partial<DomainState>;
    return { files: raw.files && typeof raw.files === "object" ? raw.files : {} };
  } catch {
    return { files: {} };
  }
}

function saveState(slug: string, domain: string, state: DomainState): void {
  ensurePrivateDir(join(domainDir(slug, domain), "sent"));
  writePrivateFile(join(domainDir(slug, domain), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function readSent(slug: string, domain: string, file: string): string | undefined {
  try {
    return readFileSync(join(domainDir(slug, domain), "sent", file), "utf-8");
  } catch {
    return undefined;
  }
}

function recordSent(slug: string, domain: string, state: DomainState, file: string, hash: string, text: string, now: number): void {
  ensurePrivateDir(join(domainDir(slug, domain), "sent"));
  writePrivateFile(join(domainDir(slug, domain), "sent", file), text);
  state.files[file] = { hash, sentAt: now };
  saveState(slug, domain, state);
}

function forgetSent(slug: string, domain: string, state: DomainState, file: string): void {
  rmSync(join(domainDir(slug, domain), "sent", file), { force: true });
  delete state.files[file];
  saveState(slug, domain, state);
}

/**
 * Record a domain's memory as already in the brain without sending it (a
 * memory moved by hand before the sync was on). `before`: only the files not
 * modified since then; the others go with the next run.
 */
export function markMemorySent(slug: string, domain: string, opts: { before?: number; now?: number } = {}): string[] {
  const state = readState(slug, domain);
  const now = opts.now ?? Date.now();
  const marked: string[] = [];
  for (const f of readMemoryFiles(domainMemoryDir(domain))) {
    if (opts.before !== undefined && f.mtimeMs > opts.before) continue;
    if (optedOut(f.text)) continue;
    recordSent(slug, domain, state, f.name, f.hash, redactSecrets(f.text).text, now);
    marked.push(f.name);
  }
  return marked.sort();
}

function readRuns(slug: string): MemorySyncRun[] {
  try {
    return readFileSync(join(syncDir(slug), "runs.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MemorySyncRun);
  } catch {
    return [];
  }
}

function saveRun(slug: string, run: MemorySyncRun): void {
  const runs = [...readRuns(slug), run].slice(-MAX_RUNS_KEPT);
  ensurePrivateDir(syncDir(slug));
  writePrivateFile(join(syncDir(slug), "runs.jsonl"), `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

// ── Sending ─────────────────────────────────────────────────────────────────

export interface SourceToSend {
  name: string;
  text: string;
  note: string;
}

/** Send one source; throws SendError (fatal = the brain is unreachable: stop the run). */
export type SourceSender = (source: SourceToSend) => Promise<void>;

export class SendError extends Error {
  fatal: boolean;
  constructor(message: string, fatal: boolean) {
    super(message);
    this.fatal = fatal;
  }
}

const FOCUS = "Memoria di sessioni Companion: integra i fatti nelle pagine giuste; se è un aggiornamento, integra solo la sezione \"Cosa è cambiato\".";

export function remoteSender(ingestUrl: string, token: string | undefined, doFetch: typeof fetch = fetch): SourceSender {
  return async (source) => {
    let res: Response;
    try {
      res = await doFetch(`${ingestUrl}/api/v1/ingest/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name: source.name, text: source.text, note: source.note, focus: FOCUS }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SendError(`The brain's ingest API did not answer: ${(err as Error).message}`, true);
    }
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    let message = body.slice(0, 300);
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    // Wrong address, token or scope: every file would fail the same way.
    throw new SendError(`HTTP ${res.status}: ${message}`, res.status === 401 || res.status === 403 || res.status === 404 || res.status >= 500);
  };
}

export function embeddedSender(slug: string, curator: (slug: string, path: string, opts: CuratorOptions) => Promise<unknown> = curatorFetch): SourceSender {
  return async (source) => {
    try {
      await curator(slug, "/sources", { method: "POST", body: { name: source.name, text: source.text, note: source.note, by: "Companion memory sync" }, timeoutMs: SEND_TIMEOUT_MS });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new SendError((err as Error).message, status === 409 || status === 502);
    }
  };
}

const sourceName = (domain: string, file: string) => `memoria-${domain}-${file.replace(/\.md$/, "")}`.slice(0, 200);

/**
 * One domain: send what is new, changed or deleted since the last run, at
 * most `maxFiles` (changed first, then new, newest first; deletions after).
 */
export async function syncDomain(slug: string, domain: string, send: SourceSender, opts: { maxFiles: number; now: number }): Promise<DomainSyncReport> {
  const report: DomainSyncReport = { domain, sent: [], deleted: [], unchanged: 0, deferred: [], skipped: [], redacted: [], failed: [] };
  const state = readState(slug, domain);
  const files = readMemoryFiles(domainMemoryDir(domain));
  const present = new Set(files.map((f) => f.name));
  const changed: MemoryFile[] = [];
  const added: MemoryFile[] = [];
  for (const f of files) {
    const prev = state.files[f.name];
    if (prev?.hash === f.hash) report.unchanged++;
    else (prev ? changed : added).push(f);
  }
  const newestFirst = (x: MemoryFile, y: MemoryFile) => y.mtimeMs - x.mtimeMs;
  const queue: ({ kind: "file"; file: MemoryFile } | { kind: "deleted"; name: string })[] = [
    ...changed.sort(newestFirst).map((file) => ({ kind: "file" as const, file })),
    ...added.sort(newestFirst).map((file) => ({ kind: "file" as const, file })),
    ...Object.keys(state.files).filter((n) => !present.has(n)).sort().map((name) => ({ kind: "deleted" as const, name })),
  ];
  let budget = opts.maxFiles;
  for (const item of queue) {
    const name = item.kind === "file" ? item.file.name : item.name;
    if (item.kind === "file" && optedOut(item.file.text)) {
      report.skipped.push({ file: name, reason: "brain: no" });
      continue;
    }
    if (budget <= 0) {
      report.deferred.push(name);
      continue;
    }
    budget--;
    try {
      if (item.kind === "deleted") {
        await send({ name: sourceName(domain, name), text: deletedText(domain, name, opts.now, readSent(slug, domain, name)), note: `Memoria del dominio ${domain}: il file ${name} è stato eliminato.` });
        forgetSent(slug, domain, state, name);
        report.deleted.push(name);
        continue;
      }
      const { text, count } = redactSecrets(item.file.text);
      if (count) report.redacted.push({ file: name, count });
      const prev = state.files[name];
      const prevText = prev ? readSent(slug, domain, name) : undefined;
      const source = sourceText(domain, name, text, opts.now, prev && prevText !== undefined ? { text: prevText, sentAt: prev.sentAt } : undefined);
      await send({ name: sourceName(domain, name), text: source, note: `Memoria del dominio ${domain}: file ${name} ${prev ? "aggiornato" : "nuovo"}.` });
      recordSent(slug, domain, state, name, item.file.hash, text, opts.now);
      report.sent.push(name);
    } catch (err) {
      report.failed.push({ file: name, error: (err as Error).message });
      if (err instanceof SendError && err.fatal) {
        // What is left waits for the next run (opted-out files stay skipped, not waiting).
        const rest = queue.slice(queue.indexOf(item) + 1).filter((q) => q.kind === "deleted" || !optedOut(q.file.text));
        report.deferred.push(...rest.map((q) => (q.kind === "file" ? q.file.name : q.name)));
        throw Object.assign(err, { report });
      }
    }
  }
  return report;
}

// ── Service ─────────────────────────────────────────────────────────────────

export interface MemorySyncDeps {
  now?: () => number;
  fetch?: typeof fetch;
  curator?: (slug: string, path: string, opts: CuratorOptions) => Promise<unknown>;
}

let instance: MemorySync | undefined;

export function setMemorySync(service: MemorySync | undefined): void {
  instance = service;
}

export function getMemorySync(): MemorySync | undefined {
  return instance;
}

export class MemorySync {
  private timers = new Map<string, Cron>();
  private running = new Set<string>();
  private now: () => number;
  private fetchImpl?: typeof fetch;
  private curator?: MemorySyncDeps["curator"];

  constructor(deps: MemorySyncDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetchImpl = deps.fetch;
    this.curator = deps.curator;
  }

  /** Arm the cron of every brain with memory sync on (server start). */
  startAll(): void {
    for (const b of listBrains()) this.schedule(b.slug);
  }

  stopAll(): void {
    for (const t of this.timers.values()) t.stop();
    this.timers.clear();
  }

  /** (Re)arm a brain's cron, or disarm it when the sync is off or the brain is gone. */
  schedule(slug: string): void {
    this.timers.get(slug)?.stop();
    this.timers.delete(slug);
    const config = getBrain(slug) ? readMemorySyncConfig(slug) : undefined;
    if (!config?.enabled) return;
    try {
      this.timers.set(slug, new Cron(config.schedule, { mode: "5-part", timezone: scheduleTimeZone() }, () => {
        void this.run(slug, "schedule").catch((err: unknown) => console.warn(`[memory-sync] ${slug}: scheduled run failed:`, err));
      }));
    } catch (err) {
      console.warn(`[memory-sync] ${slug}: schedule "${config.schedule}" not armed:`, err);
    }
  }

  view(slug: string): MemorySyncView {
    const lastRun = readRuns(slug).at(-1);
    return {
      config: readMemorySyncConfig(slug),
      tokenConfigured: !!readToken(slug),
      domains: memorySyncDomains(slug),
      running: this.running.has(slug),
      ...(lastRun ? { lastRun } : {}),
    };
  }

  configure(slug: string, patch: MemorySyncPatch): Result<MemorySyncView> {
    const r = updateMemorySync(slug, patch);
    if (!r.ok) return r;
    this.schedule(slug);
    return { ok: true, value: this.view(slug) };
  }

  private sender(brain: BrainConfig, config: MemorySyncConfig): SourceSender | string {
    if (brain.kind === "embedded") return embeddedSender(brain.slug, this.curator);
    if (!config.ingestUrl) return "No ingest URL: set the brain server's management address";
    return remoteSender(config.ingestUrl, readToken(brain.slug), this.fetchImpl);
  }

  /** Send every domain's changes now. 409 while a run of this brain is in progress. */
  async run(slug: string, trigger: MemorySyncTrigger): Promise<Result<MemorySyncRun>> {
    const brain = getBrain(slug);
    if (!brain) return { ok: false, status: 404, error: "Brain not found" };
    if (this.running.has(slug)) return { ok: false, status: 409, error: "A memory sync of this brain is in progress" };
    const config = readMemorySyncConfig(slug);
    if (trigger === "schedule" && !config.enabled) return { ok: false, status: 409, error: "Memory sync is off" };
    this.running.add(slug);
    const now = this.now();
    const run: MemorySyncRun = { at: now, trigger, ok: true, domains: [] };
    try {
      const send = this.sender(brain, config);
      if (typeof send === "string") {
        run.ok = false;
        run.error = send;
      } else {
        for (const domain of memorySyncDomains(slug)) {
          try {
            run.domains.push(await syncDomain(slug, domain, send, { maxFiles: config.maxFiles, now }));
          } catch (err) {
            const report = (err as { report?: DomainSyncReport }).report;
            if (report) run.domains.push(report);
            run.ok = false;
            run.error = (err as Error).message;
            break;
          }
        }
        if (run.domains.some((d) => d.failed.length)) run.ok = false;
      }
      saveRun(slug, run);
      const sent = run.domains.reduce((n, d) => n + d.sent.length + d.deleted.length, 0);
      console.log(`[memory-sync] ${slug}: ${trigger} run, ${sent} source(s) sent${run.error ? `, stopped: ${run.error}` : ""}`);
      return { ok: true, value: run };
    } finally {
      this.running.delete(slug);
    }
  }
}
