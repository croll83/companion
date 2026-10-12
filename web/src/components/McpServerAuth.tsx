import { useId, useState } from "react";
import { useStore } from "../store.js";
import { sendMcpAuthenticate, sendMcpOAuthCallback } from "../ws.js";

/**
 * OAuth login of one MCP server of a session (status "needs-auth"), for
 * Claude Code and Codex. "Sign in" asks the CLI for the sign-in URL. With the
 * browser on Companion's machine the login completes by itself; otherwise
 * the sign-in page ends on an address that does not load (localhost), which
 * the user pastes here. One login serves every session of the same CLI.
 */
export function McpServerAuth({ sessionId, serverName }: { sessionId: string; serverName: string }) {
  const auth = useStore((s) => s.mcpAuth.get(sessionId)?.[serverName]);
  const [pasted, setPasted] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const inputId = useId();

  if (!auth) {
    return (
      <button
        type="button"
        onClick={() => { setPasted(""); setSubmitted(false); sendMcpAuthenticate(sessionId, serverName); }}
        className="text-[11px] px-2 py-0.5 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover cursor-pointer"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="space-y-1.5 text-[11px]" role="group" aria-label={`Sign in to ${serverName}`}>
      {auth.pending && !auth.authUrl && !auth.error && <p className="text-cc-muted">Starting the sign-in...</p>}
      {auth.authUrl && (
        <>
          <a
            href={auth.authUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block px-2 py-0.5 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover"
          >
            Open the sign-in page
          </a>
          <p className="text-cc-muted">
            After signing in, the server connects by itself. If the last page does not load (browser on another device),
            copy its address and paste it here.
          </p>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pasted.trim()) return;
              setSubmitted(true);
              sendMcpOAuthCallback(sessionId, serverName, pasted.trim());
            }}
          >
            <label htmlFor={inputId} className="sr-only">Address the sign-in page ended on</label>
            <input
              id={inputId}
              value={pasted}
              onChange={(e) => { setPasted(e.target.value); setSubmitted(false); }}
              placeholder="http://localhost:…/callback?code=…"
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg font-mono-code text-[10px] focus:outline-none focus:ring-1 focus:ring-cc-primary"
            />
            <button
              type="submit"
              disabled={!pasted.trim() || submitted}
              className="px-2 py-1 rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitted ? "Sent" : "Finish"}
            </button>
          </form>
        </>
      )}
      {auth.error && <p role="alert" className="text-cc-error">{auth.error}</p>}
      <button
        type="button"
        onClick={() => useStore.getState().setMcpAuth(sessionId, serverName, null)}
        className="text-cc-muted hover:text-cc-fg cursor-pointer"
      >
        {auth.error ? "Try again" : "Cancel"}
      </button>
    </div>
  );
}
