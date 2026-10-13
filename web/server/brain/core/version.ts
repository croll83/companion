// Version of the brain server, reported by /healthz, the MCP initialize and /skill.
export const VERSION = "1.0.0";

/**
 * Contract between Companion and the bundle it spawns (env names, the ready
 * line on stdout, the token format, the /api/v1 routes). Companion passes the
 * number it was built with in BRAIN_PROTOCOL; a bundle with another number
 * refuses to start (e.g. after an update that replaced only half the files).
 */
export const BRAIN_PROTOCOL = 1;
