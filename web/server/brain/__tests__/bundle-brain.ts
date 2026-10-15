// The real brain for tests that need its core (lint, skill, token check):
// the bundle Companion ships (brain-bundle/brain.js, built by the brains
// project) run under Bun on a wiki folder, reached over HTTP the way
// Companion reaches it. Companion's code never imports the core.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "..");
export const BUNDLE = join(WEB, "brain-bundle", "brain.js");
const PROTOCOL = (JSON.parse(readFileSync(join(WEB, "brain-bundle", "bundle.json"), "utf-8")) as { protocol: number }).protocol;

/** Bun, which runs the bundle; "" when it is not installed (tests skip). */
export const BUN = (() => {
  try {
    return execFileSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
})();

export interface BundleBrain {
  base: string;
  tokenKey: string;
  curatorKey: string;
  /** GET or POST on the curator API (/api/v1), JSON. */
  api<T = any>(path: string, body?: unknown): Promise<T>;
  /** The wiki as it is on disk now. */
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

/** Start the bundle on `wikiDir`; `env` adds or overrides BRAIN_* variables. */
export async function startBundle(wikiDir: string, env: Record<string, string> = {}): Promise<BundleBrain> {
  const dataDir = mkdtempSync(join(tmpdir(), "bundle-brain-data-"));
  const tokenKey = "test-token-key-".padEnd(48, "t");
  const curatorKey = "test-curator-key-".padEnd(48, "c");
  const child: ChildProcess = spawn(BUN, [BUNDLE], {
    env: {
      PATH: process.env.PATH ?? "",
      BRAIN_WIKI_DIR: wikiDir,
      BRAIN_DATA_DIR: dataDir,
      BRAIN_HOST: "127.0.0.1",
      BRAIN_PORT: "0",
      BRAIN_PROTOCOL: String(PROTOCOL),
      BRAIN_NAME: "test-brain",
      BRAIN_REFRESH_SECONDS: "0",
      BRAIN_TOKEN_KEY: tokenKey,
      BRAIN_CURATOR_KEY: curatorKey,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr!.on("data", (d) => { err += String(d); });
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the brain bundle did not start: ${err}`)), 20_000);
    child.stdout!.on("data", (d) => {
      out += String(d);
      const m = /\{"brain_ready":true,"port":(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the brain bundle exited (${code}): ${err}`));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "X-Brain-Key": curatorKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  return {
    base,
    tokenKey,
    curatorKey,
    api,
    refresh: async () => { await api("/admin/refresh", {}); },
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
