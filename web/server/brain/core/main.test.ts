// Configuration and process entry of the brain bundle. The supervisor in
// Companion relies on this contract: a bad configuration (wrong
// BRAIN_PROTOCOL above all) exits with code 2 and a `brain:` line on stderr;
// a good one prints exactly one JSON ready line with the bound port; signals
// reload or stop; with BRAIN_EXIT_WITH_PARENT the process stops when its
// stdin closes. Bun.serve does not exist under vitest, so serve is injected.

import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkProtocol, isTailnet, loadConfig } from "./config.js";
import { main, startBrain, type BrainRuntime } from "./main.js";
import { BRAIN_PROTOCOL } from "./version.js";
import { makeWiki, tmp } from "./__tests__/fixture.js";

const wikiDir = makeWiki();
const dataRoot = tmp();
afterAll(() => {
  rmSync(wikiDir, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});
const base = () => ({ BRAIN_WIKI_DIR: wikiDir, BRAIN_DATA_DIR: join(dataRoot, String(Math.random()).slice(2)), BRAIN_REFRESH_SECONDS: "0" });

describe("config", () => {
  it("has safe defaults and fails closed", () => {
    const c = loadConfig({ BRAIN_WIKI_DIR: "x", BRAIN_DATA_DIR: "y" });
    expect(c).toMatchObject({ host: "127.0.0.1", port: 7421, name: "brain", owner: "the user", language: "auto", redactSecrets: true, refreshSeconds: 120, maxNotesPerHour: 1000 });
    expect(c.tokenKey).toBeUndefined();
    expect(loadConfig({ ...base(), BRAIN_PORT: "0" }).port).toBe(0);
    expect(loadConfig({ ...base(), BRAIN_HOST: "100.116.1.2" }).host).toBe("100.116.1.2");
    for (const h of ["0.0.0.0", "192.168.1.10", "100.63.0.1", "lab.local"]) expect(() => loadConfig({ ...base(), BRAIN_HOST: h })).toThrow(/loopback/);
    expect(isTailnet("100.128.0.1")).toBe(false);
    expect(() => loadConfig({ BRAIN_DATA_DIR: "y" })).toThrow(/BRAIN_WIKI_DIR/);
    expect(() => loadConfig({ BRAIN_WIKI_DIR: "x" })).toThrow(/BRAIN_DATA_DIR/);
    expect(() => loadConfig({ ...base(), BRAIN_REDACT_SECRETS: "yes" })).toThrow(/BRAIN_REDACT_SECRETS/);
    expect(loadConfig({ ...base(), BRAIN_REDACT_SECRETS: "false" }).redactSecrets).toBe(false);
    expect(() => loadConfig({ ...base(), BRAIN_PORT: "70000" })).toThrow(/BRAIN_PORT/);
    expect(() => loadConfig({ ...base(), BRAIN_NAME: "Work Brain" })).toThrow(/BRAIN_NAME/);
    expect(() => loadConfig({ ...base(), BRAIN_LANGUAGE: "fr" })).toThrow(/BRAIN_LANGUAGE/);
    expect(() => loadConfig({ ...base(), BRAIN_SKILL_TOPICS: "all" })).toThrow(/BRAIN_SKILL_TOPICS/);
    expect(() => loadConfig({ ...base(), BRAIN_SKILL_DESCRIPTION: "two\nlines" })).toThrow(/one line/);
    expect(() => loadConfig({ ...base(), BRAIN_OWNER: "x".repeat(81) })).toThrow(/BRAIN_OWNER/);
    expect(() => loadConfig({ ...base(), BRAIN_TOKEN_KEY: "short" })).toThrow(/BRAIN_TOKEN_KEY/);
    expect(loadConfig({ ...base(), BRAIN_ALLOWED_EMAIL_DOMAINS: "@Example.org, acme.it", BRAIN_ALLOWED_HOSTS: "a, b" })).toMatchObject({ allowedEmailDomains: ["example.org", "acme.it"], allowedHosts: ["a", "b"] });
  });

  it("refuses another BRAIN_PROTOCOL, accepts its own or none", () => {
    expect(() => checkProtocol({ BRAIN_PROTOCOL: String(BRAIN_PROTOCOL + 1) })).toThrow(/BRAIN_PROTOCOL mismatch/);
    expect(() => checkProtocol({ BRAIN_PROTOCOL: String(BRAIN_PROTOCOL) })).not.toThrow();
    expect(() => checkProtocol({})).not.toThrow();
  });
});

function fakeRuntime(port = 43210) {
  const lines: string[] = [];
  const stop = vi.fn();
  const serve = vi.fn((_o: Parameters<BrainRuntime["serve"]>[0]) => ({ port, stop }));
  return { rt: { serve, out: (l: string) => lines.push(l) } satisfies BrainRuntime, lines, stop, serve };
}

describe("startBrain", () => {
  it("listens on the configured host and prints one ready line with the bound port", async () => {
    const f = fakeRuntime();
    const running = startBrain({ ...base(), BRAIN_PORT: "0", BRAIN_REFRESH_SECONDS: "60", BRAIN_PROTOCOL: String(BRAIN_PROTOCOL) }, f.rt);
    expect(f.serve.mock.calls[0][0]).toMatchObject({ hostname: "127.0.0.1", port: 0 });
    expect(f.lines).toHaveLength(1);
    expect(JSON.parse(f.lines[0])).toMatchObject({ brain_ready: true, port: 43210, protocol: BRAIN_PROTOCOL });
    // The fetch handler handed to serve is the brain's.
    const res = await f.serve.mock.calls[0][0].fetch(new Request("http://127.0.0.1:43210/healthz"));
    expect(res.status).toBe(200);
    running.stop();
    expect(f.stop).toHaveBeenCalled();
  });
});

class FakeProc extends EventEmitter {
  stdin = new EventEmitter() as EventEmitter & { resume: () => void };
  stderr = { write: vi.fn() };
  exit = vi.fn();
  constructor() {
    super();
    this.stdin.resume = vi.fn();
  }
}

describe("main", () => {
  it("exits 2 with a brain: line on a protocol mismatch", () => {
    const f = fakeRuntime();
    const proc = new FakeProc();
    expect(main({ ...base(), BRAIN_PROTOCOL: "999" }, f.rt, proc as never)).toBeNull();
    expect(proc.stderr.write.mock.calls[0][0]).toMatch(/^brain: BRAIN_PROTOCOL mismatch/);
    expect(proc.exit).toHaveBeenCalledWith(2);
    expect(f.lines).toEqual([]);
  });

  it("reloads on SIGHUP, stops on SIGTERM and when the parent's pipe closes", () => {
    const f = fakeRuntime();
    const proc = new FakeProc();
    const running = main({ ...base(), BRAIN_EXIT_WITH_PARENT: "1" }, f.rt, proc as never)!;
    const refresh = vi.spyOn(running.brain, "refresh");
    proc.emit("SIGHUP");
    expect(refresh).toHaveBeenCalledWith(true);
    expect(proc.stdin.resume).toHaveBeenCalled();
    proc.stdin.emit("end");
    expect(f.stop).toHaveBeenCalled();
    expect(proc.exit).toHaveBeenCalledWith(0);

    const g = fakeRuntime();
    const proc2 = new FakeProc();
    main(base(), g.rt, proc2 as never);
    expect(proc2.stdin.listenerCount("end")).toBe(0);
    proc2.emit("SIGTERM");
    expect(g.stop).toHaveBeenCalled();
  });
});
