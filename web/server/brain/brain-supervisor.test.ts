import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The supervisor of embedded brains, with a REAL child process: a fake
 * bundle (__tests__/fake-brain-child.mjs, run by Node) whose behaviour comes
 * from a FAKE_MODE file in the wiki folder. Validates what keeps Companion's
 * sessions safe and the page useful: the port is read from stdout and both
 * pipes are drained into the log, crashes back off and end in `failed` with
 * a cause, a configuration error fails at once, a sick child is killed after
 * 3 health failures, the lockfile kills only our own leftover, and stop
 * waits for the child. Temp COMPANION_HOME only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { BrainSupervisor, BRAIN_PROTOCOL_EXPECTED, explainFailure, type BrainRunState } from "./brain-supervisor.js";
import { brainDataDir, brainDir, brainLogPath, createEmbeddedBrain, getBrain } from "./brain-store.js";
import { childBaseUrl } from "./brain-endpoints.js";
import { brainOwner } from "./brain-git.js";

const FAKE = join(__dirname, "__tests__", "fake-brain-child.mjs");
let tmp: string;
let sup: BrainSupervisor;
const spawned: ChildProcess[] = [];

function makeBrain(slug: string, mode = "ok"): string {
  const wiki = join(tmp, `wiki-${slug}`);
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, "SCHEMA.md"), "# schema\n");
  writeFileSync(join(wiki, "index.md"), "# index\n");
  writeFileSync(join(wiki, "FAKE_MODE"), mode);
  const r = createEmbeddedBrain({ name: slug, wikiDir: wiki, about: "Test brain" });
  if (!r.ok) throw new Error(r.error);
  return wiki;
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const stateOf = (slug: string): BrainRunState => sup.status(slug).state;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-sup-"));
  h.home = join(tmp, "companion");
  sup = new BrainSupervisor({
    bundlePath: FAKE,
    execPath: process.execPath,
    healthIntervalMs: 40,
    readyTimeoutMs: 1500,
    backoffStartMs: 20,
    backoffMaxMs: 60,
    maxCrashes: 3,
    stableMs: 60_000,
  });
});

afterEach(async () => {
  for (const slug of ["alpha", "beta", "gamma", "delta"]) await sup.stop(slug);
  for (const c of spawned) c.kill("SIGKILL");
  spawned.length = 0;
  rmSync(tmp, { recursive: true, force: true });
});

describe("BrainSupervisor", () => {
  it("speaks the protocol of the bundle it was built with", () => {
    // Companion and the bundle (built by brains, brain-bundle/bundle.json) must agree, or every child would exit with code 2.
    expect(BRAIN_PROTOCOL_EXPECTED).toBe(JSON.parse(readFileSync(join(__dirname, "../../brain-bundle/bundle.json"), "utf-8")).protocol);
  });

  it("starts the child, reads its port, drains its output into the log, and stops it", async () => {
    const wiki = makeBrain("alpha");
    const onReady = vi.fn();
    sup = new BrainSupervisor({ bundlePath: FAKE, execPath: process.execPath, healthIntervalMs: 40, onReady });
    sup.start("alpha");
    expect(stateOf("alpha")).toBe("starting");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    const st = sup.status("alpha");
    expect(st.port).toBeGreaterThan(0);
    expect(childBaseUrl("alpha")).toBe(`http://127.0.0.1:${st.port}`);
    expect(onReady).toHaveBeenCalledWith("alpha");
    expect(Number(readFileSync(join(brainDataDir("alpha"), "brain.pid"), "utf-8"))).toBe(st.pid);
    sup.start("alpha"); // already running: no second child
    expect(sup.status("alpha").pid).toBe(st.pid);

    // The env the child got: wiki, data, names, protocol, keys (never Companion's own variables).
    await waitFor(() => sup.logTail("alpha").some((l) => l.includes("fake_env")));
    const envLine = sup.logTail("alpha").find((l) => l.includes("fake_env"))!;
    const { fake_env: env, argv } = JSON.parse(envLine.slice(envLine.indexOf("{")));
    expect(env).toMatchObject({
      BRAIN_WIKI_DIR: wiki,
      BRAIN_DATA_DIR: brainDataDir("alpha"),
      BRAIN_HOST: "127.0.0.1",
      BRAIN_PORT: "0",
      BRAIN_PROTOCOL: "1",
      BRAIN_NAME: "alpha-brain",
      BRAIN_TITLE: "alpha brain",
      BRAIN_ABOUT: "Test brain",
      BRAIN_LANGUAGE: "auto",
      BRAIN_REDACT_SECRETS: "true",
      BRAIN_TOKEN_KEY: "<64 chars>",
      BRAIN_CURATOR_KEY: "<64 chars>",
      BRAIN_EXIT_WITH_PARENT: "1",
    });
    expect(argv).toEqual([`--brain-dir=${brainDir("alpha")}`]);
    expect(sup.logTail("alpha").some((l) => l.includes("not json, an ordinary log line"))).toBe(true);

    await sup.stop("alpha");
    expect(stateOf("alpha")).toBe("stopped");
    expect(existsSync(join(brainDataDir("alpha"), "brain.pid"))).toBe(false);
    expect(childBaseUrl("alpha")).toBeNull();
    expect(await sup.waitRunning("alpha", 100)).toBe(false);
  });

  // The skill fetched from the child follows its wiki: each health answer's
  // content hash reaches onHealth. The owner is a person (git user.name),
  // not the Unix login, so the brain's text does not read "the knowledge base of jarvis".
  it("reports each health check's content hash, and names the owner from git", async () => {
    makeBrain("alpha");
    const onHealth = vi.fn();
    sup = new BrainSupervisor({ bundlePath: FAKE, execPath: process.execPath, healthIntervalMs: 40, onHealth });
    sup.start("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    await waitFor(() => onHealth.mock.calls.length > 0);
    expect(onHealth).toHaveBeenCalledWith("alpha", "fake");
    await waitFor(() => sup.logTail("alpha").some((l) => l.includes("fake_env")));
    const envLine = sup.logTail("alpha").find((l) => l.includes("fake_env"))!;
    expect(JSON.parse(envLine.slice(envLine.indexOf("{"))).fake_env.BRAIN_OWNER).toBe(brainOwner());
  });

  // Consolidation's threshold and catch-up ride on the health ticks: a
  // listener gets the inbox counts of each good answer, until it unsubscribes,
  // and a throwing listener never breaks the supervisor.
  it("hands each good health answer's inbox counts to the health listeners", async () => {
    makeBrain("alpha");
    sup = new BrainSupervisor({ bundlePath: FAKE, execPath: process.execPath, healthIntervalMs: 40 });
    const ticks: unknown[] = [];
    sup.addHealthListener(() => { throw new Error("listener bug"); });
    const off = sup.addHealthListener((slug, tick) => ticks.push({ slug, ...tick }));
    sup.start("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    await waitFor(() => ticks.length > 0);
    expect(ticks[0]).toEqual({ slug: "alpha", contentHash: "fake", inbox: { pending: 2 } });
    off();
    const seen = ticks.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(ticks.length).toBe(seen);
  });

  it("restarts a crashing child with backoff, then fails with the cause", async () => {
    makeBrain("beta", "crash");
    sup.start("beta");
    await waitFor(() => stateOf("beta") === "failed");
    const st = sup.status("beta");
    expect(st.crashes).toBe(3);
    expect(st.cause).toMatch(/keeps stopping: something broke at startup/);
    expect(st.action).toMatch(/press Start/);
    expect(st.lastExitCode).toBe(1);
    expect(sup.logTail("beta").filter((l) => l.includes("[supervisor] started")).length).toBe(3);
    expect(st.startedAt).toBeUndefined();
    expect(await sup.waitRunning("beta", 100)).toBe(false);
    // Start again after fixing the cause: the crash count starts over.
    writeFileSync(join(getBrain("beta")!.embedded!.wikiDir, "FAKE_MODE"), "ok");
    sup.start("beta");
    expect(await sup.waitRunning("beta", 5000)).toBe(true);
    expect(sup.status("beta").cause).toBeUndefined();
  });

  // Back up after a crash: the old explanation goes away, the crash stays counted.
  it("recovers from a single crash and clears its cause", async () => {
    makeBrain("delta", "crash-once");
    sup.start("delta");
    expect(await sup.waitRunning("delta", 5000)).toBe(true);
    expect(sup.status("delta")).toMatchObject({ state: "running", crashes: 1, lastExitCode: 1 });
    expect(sup.status("delta").cause).toBeUndefined();
  });

  it("fails at once on a configuration error (exit 2), with a readable cause", async () => {
    makeBrain("gamma", "protocol");
    sup.start("gamma");
    await waitFor(() => stateOf("gamma") === "failed");
    expect(sup.status("gamma").crashes).toBe(1);
    expect(sup.status("gamma").cause).toMatch(/different versions/);
  });

  it("fails before spawning when the wiki folder or the bundle is missing", async () => {
    const wiki = makeBrain("delta");
    rmSync(join(wiki, "SCHEMA.md"));
    sup.start("delta");
    expect(sup.status("delta")).toMatchObject({ state: "failed", cause: expect.stringMatching(/wiki folder .* is missing/), action: expect.stringMatching(/Restore the folder/) });

    writeFileSync(join(wiki, "SCHEMA.md"), "# s\n");
    const noBundle = new BrainSupervisor({ bundlePath: join(tmp, "missing.js") });
    noBundle.start("delta");
    expect(noBundle.status("delta")).toMatchObject({ state: "failed", cause: expect.stringMatching(/brain program is missing/) });

    noBundle.start("not-a-brain");
    expect(noBundle.status("not-a-brain").cause).toMatch(/not an embedded brain/);
    expect(sup.status("never-started")).toEqual({ state: "stopped", crashes: 0 });
  });

  it("kills a child that stops answering /healthz, then gives up", async () => {
    makeBrain("alpha", "unhealthy");
    sup.start("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    await waitFor(() => sup.logTail("alpha").some((l) => l.includes("health check failed (1)")));
    await waitFor(() => stateOf("alpha") === "failed", 8000);
    expect(sup.status("alpha").cause).toMatch(/health check failed 3 times/);
  });

  it("kills a child that never announces its port", async () => {
    makeBrain("beta", "hang");
    sup = new BrainSupervisor({ bundlePath: FAKE, execPath: process.execPath, readyTimeoutMs: 300, backoffStartMs: 10, maxCrashes: 1 });
    sup.start("beta");
    expect(await sup.waitRunning("beta", 50)).toBe(false); // timeout while starting
    await waitFor(() => stateOf("beta") === "failed");
    expect(sup.status("beta").cause).toMatch(/no ready line within/);
  });

  // Reads /proc/<pid>/cmdline, like the supervisor: Linux only.
  it.skipIf(process.platform !== "linux")("lockfile: kills our own leftover child, leaves another install's alone", async () => {
    makeBrain("alpha");
    mkdirSync(brainDataDir("alpha"), { recursive: true });
    // A leftover of this install: same bundle, same brain folder.
    const ours = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", FAKE, `--brain-dir=${brainDir("alpha")}`], { stdio: "ignore" });
    spawned.push(ours);
    await waitFor(() => existsSync(`/proc/${ours.pid}/cmdline`) && readFileSync(`/proc/${ours.pid}/cmdline`, "utf-8").includes("--brain-dir"));
    writeFileSync(join(brainDataDir("alpha"), "brain.pid"), `${ours.pid}\n`);
    const gone = new Promise((r) => ours.once("exit", r));
    sup.start("alpha");
    await gone;
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    await sup.stop("alpha");

    // Another installation (another bundle path) runs this brain: do not touch it.
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "/elsewhere/dist/brain/brain.js", `--brain-dir=${brainDir("alpha")}`], { stdio: "ignore" });
    spawned.push(other);
    await waitFor(() => existsSync(`/proc/${other.pid}/cmdline`) && readFileSync(`/proc/${other.pid}/cmdline`, "utf-8").includes("--brain-dir"));
    writeFileSync(join(brainDataDir("alpha"), "brain.pid"), `${other.pid}\n`);
    sup.start("alpha");
    expect(sup.status("alpha")).toMatchObject({ state: "failed", cause: expect.stringMatching(/Another Companion installation/) });
    expect(other.exitCode).toBeNull();

    // A reused PID that is not a brain, or garbage in the file: ignored.
    writeFileSync(join(brainDataDir("alpha"), "brain.pid"), `${process.pid}\n`);
    sup.start("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
  });

  it("startAll starts autostart brains only; stopAll stops them", async () => {
    makeBrain("alpha");
    makeBrain("beta");
    const cfg = JSON.parse(readFileSync(join(brainDir("beta"), "brain.json"), "utf-8"));
    cfg.embedded.autostart = false;
    writeFileSync(join(brainDir("beta"), "brain.json"), JSON.stringify(cfg));
    sup.startAll();
    expect(stateOf("alpha")).toBe("starting");
    expect(stateOf("beta")).toBe("stopped");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    sup.stopAll();
    await waitFor(() => stateOf("alpha") === "stopped");
  });

  it("restart gives a new child; the log rotates at its size cap", async () => {
    makeBrain("alpha");
    sup = new BrainSupervisor({ bundlePath: FAKE, execPath: process.execPath, logMaxBytes: 300 });
    sup.start("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    const first = sup.status("alpha").pid;
    await sup.restart("alpha");
    expect(await sup.waitRunning("alpha", 5000)).toBe(true);
    expect(sup.status("alpha").pid).not.toBe(first);
    expect(existsSync(`${brainLogPath("alpha")}.1`)).toBe(true);
    expect(sup.logTail("alpha", 3)).toHaveLength(3);
    expect(sup.logTail("nope")).toEqual([]);
  });
});

describe("explainFailure", () => {
  it("turns stderr into a cause and an action", () => {
    expect(explainFailure(["brain: SCHEMA.md not found in /x: not a wiki folder"], undefined).cause).toMatch(/missing or is not a wiki/);
    expect(explainFailure([], undefined).cause).toMatch(/without an error message/);
    expect(explainFailure(["", "brain: boom"], undefined).cause).toBe("The brain keeps stopping: boom");
  });
});
