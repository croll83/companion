import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMPANION_HOME } from "./paths.js";

/**
 * The Tailscale Funnel integration was removed. Older versions started Funnel
 * with `tailscale funnel --bg <port>`, which tailscaled keeps across restarts,
 * and tracked it in `<COMPANION_HOME>/tailscale-state.json`. Nothing in the
 * app can show or stop that Funnel any more, so if the state file is still
 * there, warn at startup that the instance may still be publicly reachable.
 *
 * The file is left in place: it is the only trace that Funnel was ever on.
 * Returns true when the warning was printed.
 */
export function warnIfLegacyTailscaleFunnel(home: string = COMPANION_HOME): boolean {
  const statePath = join(home, "tailscale-state.json");
  if (!existsSync(statePath)) return false;
  console.warn(
    `[tailscale] ${statePath} exists: an older Companion enabled Tailscale Funnel, and the in-app ` +
      "Tailscale integration has been removed. Funnel may still be exposing this instance publicly. " +
      "Check with `tailscale funnel status`, turn it off with `sudo tailscale funnel reset`, then delete that file.",
  );
  return true;
}
