#!/usr/bin/env bun
/**
 * Smoke test of the built brain bundle (dist/brain/brain.js) under Bun, the
 * way Companion's supervisor runs it. Unit tests run the core under Node
 * (vitest); this is the only check of the real bundle, its Bun.serve
 * transport and SQLite under Bun.
 *
 *   bun run build && bun scripts/brain-smoke.ts [path/to/brain.js]
 *
 * Steps: generate a wiki in a temp folder, start the bundle on an ephemeral
 * port, read the ready line, then healthz, MCP initialize with a stock SDK
 * client and a brn_ token, brain_search, brain_inbox_add, a consolidation run
 * (start + finalize) with X-Brain-Key; finally a wrong BRAIN_PROTOCOL must be
 * refused. Exits non-zero on the first failure. Writes only to temp folders.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeWiki, tmp } from "../server/brain/core/__tests__/fixture.js";
import { mintToken } from "../server/brain/core/token.js";
import { BRAIN_PROTOCOL } from "../server/brain/core/version.js";

const bundle = resolve(process.argv[2] ?? resolve(import.meta.dir, "../dist/brain/brain.js"));
const TOKEN_KEY = "smoke-token-key-".padEnd(48, "x");
const CURATOR_KEY = "smoke-curator-key-".padEnd(48, "y");
const cleanup: string[] = [];

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

function startChild(env: Record<string, string>): { child: ChildProcess; ready: Promise<number>; exited: Promise<number | null>; stderr: () => string } {
  const child = spawn(process.execPath, [bundle, "--brain-dir=/tmp/brain-smoke"], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  let out = "";
  child.stderr!.on("data", (d) => { err += String(d); });
  const ready = new Promise<number>((res, rej) => {
    child.stdout!.on("data", (d) => {
      out += String(d);
      for (const line of out.split("\n")) {
        try {
          const msg = JSON.parse(line) as { brain_ready?: boolean; port?: number };
          if (msg.brain_ready && msg.port) res(msg.port);
        } catch { /* audit lines and partial lines */ }
      }
    });
    child.once("exit", (code) => rej(new Error(`child exited (${code}) before ready: ${err.trim()}`)));
    setTimeout(() => rej(new Error("no ready line within 15 s")), 15_000).unref();
  });
  // A child that must fail never gets awaited for readiness: no unhandled rejection.
  ready.catch(() => undefined);
  const exited = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));
  return { child, ready, exited, stderr: () => err };
}

async function main(): Promise<void> {
  check(existsSync(bundle), `bundle exists (${bundle})`);
  const wikiDir = makeWiki(true);
  const dataDir = tmp("brain-smoke-data-");
  cleanup.push(wikiDir, dataDir);
  const env = {
    BRAIN_WIKI_DIR: wikiDir,
    BRAIN_DATA_DIR: dataDir,
    BRAIN_HOST: "127.0.0.1",
    BRAIN_PORT: "0",
    BRAIN_NAME: "smoke-brain",
    BRAIN_TITLE: "Smoke brain",
    BRAIN_OWNER: "CI",
    BRAIN_LANGUAGE: "auto",
    BRAIN_PROTOCOL: String(BRAIN_PROTOCOL),
    BRAIN_TOKEN_KEY: TOKEN_KEY,
    BRAIN_CURATOR_KEY: CURATOR_KEY,
  };
  const run = startChild(env);
  try {
    const port = await run.ready;
    check(port > 0, `ready line with an ephemeral port (${port})`);
    const base = `http://127.0.0.1:${port}`;

    const health = (await (await fetch(`${base}/healthz`)).json()) as { status: string; pages: number; protocol: number };
    check(health.status === "ok" && health.pages > 0 && health.protocol === BRAIN_PROTOCOL, "healthz");

    const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    check(denied.status === 401, "MCP without a brn_ token is refused");

    const token = mintToken(TOKEN_KEY, { domain: "GLOBAL", sessionId: "smoke-session" });
    const client = new Client({ name: "smoke", version: "1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    check((client.getInstructions() ?? "").includes("Smoke brain"), "MCP initialize (instructions from the wiki)");
    const search = await client.callTool({ name: "brain_search", arguments: { query: "billing service" } });
    const hits = JSON.parse((search.content as { text: string }[])[0].text) as { results: { slug?: string }[] };
    check(hits.results[0]?.slug === "billing-service", "brain_search");
    const add = await client.callTool({ name: "brain_inbox_add", arguments: { kind: "new_fact", statement: "The smoke test recorded this note through the bundle.", pages: ["billing-service"], sources: ["person:self"] } });
    check(add.isError !== true, "brain_inbox_add with a brn_ token (SQLite write)");
    await client.close();

    const api = (path: string, body: unknown) => fetch(`${base}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json", "x-brain-key": CURATOR_KEY }, body: JSON.stringify(body) });
    check((await fetch(`${base}/api/v1/consolidation/runs`, { method: "POST", body: "{}" })).status === 401, "curator API without X-Brain-Key is refused");
    const started = (await (await api("/consolidation/runs", { run_id: "smoke-run" })).json()) as { run_id: string; counts: { notes: number } };
    check(started.run_id === "smoke-run" && started.counts.notes === 1, "consolidation run started with the note");
    const fin = await api("/consolidation/runs/smoke-run/finalize", { summary: "smoke" });
    check(fin.status === 200, "consolidation run finalized");

    const skill = await fetch(`${base}/skill`);
    check(skill.status === 200 && ((await skill.json()) as { name: string }).name === "smoke-brain", "public skill");
  } finally {
    run.child.kill("SIGTERM");
    const code = await run.exited;
    check(code === 0 || code === null, `child stopped on SIGTERM (code ${code})`);
  }

  const wrong = startChild({ ...env, BRAIN_PROTOCOL: String(BRAIN_PROTOCOL + 99) });
  const wrongCode = await wrong.exited;
  check(wrongCode === 2 && /BRAIN_PROTOCOL mismatch/.test(wrong.stderr()), "a wrong BRAIN_PROTOCOL is refused (exit 2)");
}

main()
  .then(() => console.log("brain smoke test passed"))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });
