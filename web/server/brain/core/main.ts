// Entry point of the brain bundle (dist/brain/brain.js, built with
// `bun build --target=bun`). Companion's supervisor runs it as a child:
//
//   bun dist/brain/brain.js --brain-dir=<COMPANION_HOME/brains/slug>
//
// with the configuration in the environment (config.ts). Once listening it
// prints ONE JSON line on stdout, which the supervisor reads to learn the
// ephemeral port:
//
//   {"brain_ready":true,"port":N,"protocol":1,"version":"..."}
//
// A configuration error (wrong BRAIN_PROTOCOL, missing wiki) is printed on
// stderr as `brain: <message>` and the process exits with code 2.
// The wiki is re-read every BRAIN_REFRESH_SECONDS, on SIGHUP and on
// POST /api/v1/admin/refresh. With BRAIN_EXIT_WITH_PARENT=1 the process exits
// when its stdin closes, i.e. when the Companion that spawned it is gone.

import { loadConfig } from "./config.js";
import { Brain } from "./brain.js";
import { createFetchHandler } from "./http.js";
import { BRAIN_PROTOCOL, VERSION } from "./version.js";

/** What main needs from the runtime: injected by tests (Bun.serve does not exist under vitest). */
export interface BrainRuntime {
  serve: (opts: { hostname: string; port: number; fetch: (req: Request) => Promise<Response> }) => { port: number; stop: () => void };
  out: (line: string) => void;
}

export interface RunningBrain {
  brain: Brain;
  port: number;
  stop: () => void;
}

/** Load the config, open the brain, listen, announce the port. Throws on a bad configuration. */
export function startBrain(env: NodeJS.ProcessEnv, rt: BrainRuntime): RunningBrain {
  const cfg = loadConfig(env);
  const brain = new Brain(cfg);
  const server = rt.serve({ hostname: cfg.host, port: cfg.port, fetch: createFetchHandler(brain) });
  const timer = cfg.refreshSeconds > 0 ? setInterval(() => brain.refresh(), cfg.refreshSeconds * 1000) : undefined;
  timer?.unref?.();
  brain.audit.log({ event: "listening", detail: `http://${cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host}:${server.port}/mcp redact_secrets=${cfg.redactSecrets} tokens=${!!cfg.tokenKey}` });
  rt.out(JSON.stringify({ brain_ready: true, port: server.port, protocol: BRAIN_PROTOCOL, version: VERSION }));
  return {
    brain,
    port: server.port,
    stop: () => {
      if (timer) clearInterval(timer);
      server.stop();
      brain.inbox.close();
    },
  };
}

/** Run as the process entry: signals, parent watch, exit codes. */
export function main(env: NodeJS.ProcessEnv, rt: BrainRuntime, proc: Pick<NodeJS.Process, "on" | "exit" | "stdin" | "stderr">): RunningBrain | null {
  let running: RunningBrain;
  try {
    running = startBrain(env, rt);
  } catch (e) {
    proc.stderr.write(`brain: ${(e as Error).message}\n`);
    proc.exit(2);
    return null;
  }
  const stop = () => {
    running.stop();
    proc.exit(0);
  };
  proc.on("SIGHUP", () => running.brain.refresh(true));
  proc.on("SIGTERM", stop);
  proc.on("SIGINT", stop);
  if (env.BRAIN_EXIT_WITH_PARENT === "1") {
    proc.stdin.on("end", stop);
    proc.stdin.on("close", stop);
    proc.stdin.resume();
  }
  return running;
}

if ((import.meta as { main?: boolean }).main) {
  const bun = (globalThis as { Bun?: { serve: BrainRuntime["serve"] } }).Bun;
  if (!bun) {
    process.stderr.write("brain: this bundle runs under Bun\n");
    process.exit(2);
  }
  main(process.env, { serve: (o) => bun.serve({ ...o }), out: (line) => process.stdout.write(`${line}\n`) }, process);
}
