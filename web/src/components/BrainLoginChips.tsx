import { useMemo } from "react";
import type { BrainInfo } from "../api.js";
import type { McpServerDetail, SdkSessionInfo } from "../types.js";
import { useStore } from "../store.js";

export type LoginState = "signed-in" | "needed" | "unknown";

const EMPTY_SESSIONS: SdkSessionInfo[] = [];

const STATE_TEXT: Record<LoginState, string> = { "signed-in": "signed in", needed: "sign-in needed", unknown: "unknown" };
const STATE_TONE: Record<LoginState, string> = {
  "signed-in": "border-cc-success/40 text-cc-success",
  needed: "border-cc-warning/50 text-cc-warning",
  unknown: "border-cc-border text-cc-muted",
};

/**
 * The sign-in state of an OAuth brain for one CLI, from the MCP status of
 * its active sessions in the domains using the brain: any session waiting
 * for a login ("needs-auth"; Codex's notLoggedIn is mapped to it) means
 * "needed", else a connected one means "signed in", else "unknown" (no
 * active session of that CLI uses the brain, or its status was not read).
 * Legacy sessions (no domain) never get a brain and are ignored.
 */
export function loginState(
  brain: Pick<BrainInfo, "serverName" | "domains">,
  backend: "claude" | "codex",
  sessions: SdkSessionInfo[],
  mcpServers: Map<string, McpServerDetail[]>,
): LoginState {
  const domains = new Set(brain.domains.map((d) => d.slug));
  let connected = false;
  for (const s of sessions) {
    if (s.archived || s.state === "exited" || !s.domain || !domains.has(s.domain)) continue;
    if ((s.backendType ?? "claude") !== backend) continue;
    for (const srv of mcpServers.get(s.sessionId) ?? []) {
      // Claude reports plugin servers as plugin:<plugin>:<name>.
      const name = srv.name.split(":").pop();
      if (name !== brain.serverName) continue;
      if (srv.status === "needs-auth") return "needed";
      if (srv.status === "connected") connected = true;
    }
  }
  return connected ? "signed-in" : "unknown";
}

/**
 * Two chips for an OAuth brain: "Claude Code: signed in / sign-in needed /
 * unknown" and the same for Codex. Each CLI signs in once and keeps its own
 * tokens, so the two can differ. When a state is not "signed in", a hint
 * says where to sign in.
 */
export function BrainLoginChips({ brain }: { brain: BrainInfo }) {
  const sessions = useStore((s) => s.sdkSessions) ?? EMPTY_SESSIONS;
  const mcpServers = useStore((s) => s.mcpServers);
  const states = useMemo(() => ({
    claude: loginState(brain, "claude", sessions, mcpServers),
    codex: loginState(brain, "codex", sessions, mcpServers),
  }), [brain, sessions, mcpServers]);
  const domain = brain.domains.find((d) => d.slug !== "global") ?? brain.domains[0];
  const domainName = domain ? (domain.slug === "global" ? "GLOBAL" : domain.name) : null;
  const unresolved = states.claude !== "signed-in" || states.codex !== "signed-in";

  return (
    <div className="space-y-1">
      <ul aria-label="Sign-in state" className="flex flex-wrap gap-1.5">
        {([["claude", "Claude Code"], ["codex", "Codex"]] as const).map(([key, label]) => (
          <li key={key} className={`px-2 py-0.5 rounded-full border text-[11px] ${STATE_TONE[states[key]]}`}>
            {label}: {STATE_TEXT[states[key]]}
          </li>
        ))}
      </ul>
      {unresolved && (
        <p className="text-[11px] text-cc-muted">
          {domainName ? (
            <>
              Open a session in <strong>{domainName}</strong> and sign in from its MCP panel (one sign-in per CLI). "Unknown" means no
              active session of that CLI uses this brain, or its MCP panel was not opened yet.
            </>
          ) : (
            "Choose this brain in a domain, then open a session there and sign in from its MCP panel."
          )}
        </p>
      )}
    </div>
  );
}
