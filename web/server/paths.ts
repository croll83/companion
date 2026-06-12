import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Base directory for all Companion configuration and state.
 * Defaults to ~/.companion/ for self-hosted installs.
 * Override with the COMPANION_HOME env var to relocate it.
 */
export const COMPANION_HOME =
  process.env.COMPANION_HOME || join(homedir(), ".companion");
