/**
 * How the companion hands the bridge URL to the spawned Claude Code CLI.
 *
 * This module is the single source of truth for the valid bridge modes. It is
 * deliberately free of Node-only imports so it can be shared by the server
 * (settings normalization, PUT /api/settings validation) and the browser
 * bundle (SettingsPage), mirroring `effort.ts`. Adding a mode here is enough
 * for every layer to accept it — previously each layer enumerated the modes by
 * hand and the route forgot "stdio", silently reverting the user's choice.
 *
 * - "loopback" (default): pass `--sdk-url ws://127.0.0.1:PORT/...` on argv.
 *   Works on Claude Code v1.2.1+ which rejects the literal "localhost".
 *   BROKEN on Claude Code v2.1.142+ which restricts --sdk-url to a hardcoded
 *   list of Anthropic hostnames.
 * - "jsonHandoff": write a temp JSON descriptor and pass its path via the
 *   CLAUDE_BRIDGE_CONFIG env var, mirroring just-every/code's v0.6.98
 *   approach. Also broken on 2.1.142+ for the same allowlist reason.
 * - "tlsLoopback": spawn the CLI with `--sdk-url wss://<allowlisted-host>:PORT/...`
 *   where the hostname is mapped to 127.0.0.1 via /etc/hosts and served by
 *   an embedded Bun.serve TLS proxy with a self-signed cert trusted via
 *   NODE_EXTRA_CA_CERTS. Works on 2.1.142+ but breaks on builds where
 *   --sdk-url drives the Remote Control SSE/worker transport (e.g. 2.1.175).
 * - "stdio": spawn the CLI WITHOUT --sdk-url and exchange the same NDJSON
 *   protocol over the child's stdin/stdout. This is the supported Agent SDK
 *   "streaming input" transport — immune to the --sdk-url allowlist changes —
 *   and is the recommended mode for host Claude sessions.
 */
export const CLI_BRIDGE_MODES = ["loopback", "jsonHandoff", "tlsLoopback", "stdio"] as const;

export type CliBridgeMode = (typeof CLI_BRIDGE_MODES)[number];

/** Mode used when nothing (or an unknown value) is stored. Unchanged for backward compatibility. */
export const DEFAULT_CLI_BRIDGE_MODE: CliBridgeMode = "loopback";

/** Type guard: true only for one of the values in {@link CLI_BRIDGE_MODES}. */
export function isCliBridgeMode(value: unknown): value is CliBridgeMode {
  return typeof value === "string" && (CLI_BRIDGE_MODES as readonly string[]).includes(value);
}

/** Validation error listing every accepted value, derived from {@link CLI_BRIDGE_MODES}. */
export const CLI_BRIDGE_MODE_ERROR =
  `cliBridgeMode must be one of: ${CLI_BRIDGE_MODES.map((m) => `'${m}'`).join(", ")}`;
