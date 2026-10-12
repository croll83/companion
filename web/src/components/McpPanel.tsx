import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { sendMcpGetStatus, sendMcpToggle, sendMcpReconnect } from "../ws.js";
import type { McpServerDetail } from "../types.js";
import { domainsHash } from "../utils/routing.js";
import { McpServerAuth } from "./McpServerAuth.js";

const EMPTY_SERVERS: McpServerDetail[] = [];
const EMPTY_MCP_INIT: { name: string; status: string }[] = [];

const STATUS_STYLES: Record<string, { label: string; badge: string; dot: string }> = {
  connected:  { label: "Connected",  badge: "text-cc-success bg-cc-success/10", dot: "bg-cc-success" },
  connecting: { label: "Connecting", badge: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning animate-pulse" },
  failed:     { label: "Failed",     badge: "text-cc-error bg-cc-error/10",     dot: "bg-cc-error" },
  "needs-auth": { label: "Sign-in needed", badge: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning" },
  disabled:   { label: "Disabled",   badge: "text-cc-muted bg-cc-hover",        dot: "bg-cc-muted opacity-40" },
};
const DEFAULT_STATUS = { label: "Unknown", badge: "text-cc-muted bg-cc-hover", dot: "bg-cc-muted opacity-40" };

function McpServerRow({
  server,
  sessionId,
}: {
  server: McpServerDetail;
  sessionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[server.status] || DEFAULT_STATUS;
  const isEnabled = server.status !== "disabled";
  const toolCount = server.tools?.length ?? 0;
  const hasAuth = useStore((s) => !!s.mcpAuth.get(sessionId)?.[server.name]);

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      {/* Header row */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />

        {/* Name + expand toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <span className="text-[12px] font-medium text-cc-fg truncate block">
            {server.name}
          </span>
        </button>

        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${style.badge}`}>
          {style.label}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Reconnect */}
          {(server.status === "failed" || server.status === "connected") && (
            <button
              onClick={() => sendMcpReconnect(sessionId, server.name)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
              title="Reconnect server"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                <path d="M2.5 8a5.5 5.5 0 019.78-3.5M13.5 8a5.5 5.5 0 01-9.78 3.5" strokeLinecap="round" />
                <path d="M12.5 2v3h-3M3.5 14v-3h3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* OAuth sign-in (Claude Code and Codex) */}
      {(server.status === "needs-auth" || hasAuth) && (
        <div className="px-2.5 pb-2">
          <McpServerAuth sessionId={sessionId} serverName={server.name} />
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 pt-2">
          {/* Config info */}
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}
                  {server.config.args?.length ? ` ${server.config.args.join(" ")}` : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">{server.config.url}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>

          {/* For this session only: the domain decides what every session gets. */}
          <button
            type="button"
            onClick={() => sendMcpToggle(sessionId, server.name, !isEnabled)}
            className="text-[11px] text-cc-muted hover:text-cc-fg underline-offset-2 hover:underline cursor-pointer"
          >
            {isEnabled ? "Turn off for this session (until reload)" : "Turn on for this session"}
          </button>

          {/* Error */}
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">
              {server.error}
            </div>
          )}

          {/* Tools */}
          {toolCount > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">
                Tools ({toolCount})
              </span>
              <div className="flex flex-wrap gap-1">
                {server.tools!.map((tool) => (
                  <span
                    key={tool.name}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg"
                    title={
                      tool.annotations
                        ? Object.entries(tool.annotations)
                            .filter(([, v]) => v)
                            .map(([k]) => k)
                            .join(", ") || undefined
                        : undefined
                    }
                  >
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The MCP servers of one session, as its CLI sees them right now: a one-line
 * summary that opens by itself when a server failed or waits for a sign-in.
 * Rows show the live status, sign-in, reconnect, tools and errors; what every
 * session of the domain gets is managed on the Domains page (link). A server
 * can still be turned off for this session only, until it reloads.
 */
export function McpSection({ sessionId }: { sessionId: string }) {
  const servers = useStore((s) => s.mcpServers.get(sessionId) || EMPTY_SERVERS);
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const domainSlug = sdk && !sdk.legacyMemory ? sdk.domain || "global" : undefined;

  // The session_init mcp_servers gives us basic info (name + status).
  // We can detect if MCP servers exist from session state to show the section.
  const sessionMcpServers = useStore(
    (s) => s.sessions.get(sessionId)?.mcp_servers ?? EMPTY_MCP_INIT,
  );

  // Auto-fetch detailed status when connected.
  // For Codex sessions, session_init may not include MCP server hints, so
  // we must fetch even when no MCP server hints are currently present.
  useEffect(() => {
    if (cliConnected) {
      sendMcpGetStatus(sessionId);
    }
  }, [sessionId, cliConnected]);

  // If we have detailed servers, use those; otherwise fall back to basic info
  const displayServers: McpServerDetail[] =
    servers.length > 0
      ? servers
      : sessionMcpServers.map((s) => ({
          name: s.name,
          status: s.status as McpServerDetail["status"],
          config: { type: "unknown" },
          scope: "",
        }));

  const count = (status: string) => displayServers.filter((s) => s.status === status).length;
  const problems = count("failed") + count("needs-auth");
  const [expanded, setExpanded] = useState(false);
  // Open by itself when a problem appears (not again once the user closed it for that problem).
  const seenProblems = useRef(0);
  useEffect(() => {
    if (problems > seenProblems.current) setExpanded(true);
    seenProblems.current = problems;
  }, [problems]);

  const summary = [
    `${count("connected")} connected`,
    count("needs-auth") ? `${count("needs-auth")} need sign-in` : "",
    count("failed") ? `${count("failed")} failed` : "",
    count("disabled") ? `${count("disabled")} off` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      {/* MCP section header */}
      <div className="shrink-0 px-4 py-2.5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left cursor-pointer"
        >
          <span className="text-[13px] font-semibold text-cc-fg flex items-center gap-1.5">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-muted" aria-hidden="true">
              <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v1A1.5 1.5 0 0113 5.5H3A1.5 1.5 0 011.5 4V3zm0 5A1.5 1.5 0 013 6.5h10A1.5 1.5 0 0114.5 8v1A1.5 1.5 0 0113 10.5H3A1.5 1.5 0 011.5 9V8zm0 5A1.5 1.5 0 013 11.5h10a1.5 1.5 0 011.5 1.5v1a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14v-1z" />
            </svg>
            MCP Servers
          </span>
          {displayServers.length > 0 && (
            <span className={`block text-[11px] ${problems ? "text-cc-warning" : "text-cc-muted"}`}>{summary}</span>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {domainSlug && (
            <a href={domainsHash(domainSlug, "mcp")} className="text-[11px] text-cc-primary hover:underline">
              Manage in domain ›
            </a>
          )}
          {/* Refresh button */}
          <button
            onClick={() => sendMcpGetStatus(sessionId)}
            disabled={!cliConnected}
            className={`text-[11px] font-medium transition-colors ${
              cliConnected
                ? "text-cc-muted hover:text-cc-fg cursor-pointer"
                : "text-cc-muted/30 cursor-not-allowed"
            }`}
            title="Refresh MCP server status"
            aria-label="Refresh MCP server status"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M2.5 8a5.5 5.5 0 019.78-3.5M13.5 8a5.5 5.5 0 01-9.78 3.5" strokeLinecap="round" />
              <path d="M12.5 2v3h-3M3.5 14v-3h3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Server list */}
      {expanded && displayServers.length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          {displayServers.map((server) => (
            <McpServerRow
              key={server.name}
              server={server}
              sessionId={sessionId}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {displayServers.length === 0 && (
        <div className="px-3 py-3">
          <p className="text-[11px] text-cc-muted text-center">No MCP servers in this session.</p>
        </div>
      )}
    </>
  );
}
