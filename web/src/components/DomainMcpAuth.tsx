import { useEffect, useId, useState } from "react";
import { api, type McpAuthAction, type McpAuthView } from "../api.js";

/** Short label of a server's access, for its row. */
export function mcpAuthLabel(a: McpAuthView): string {
  switch (a.state) {
    case "unchecked": return "access not checked";
    case "open": return "open";
    case "manual": return "credentials in mcp.json";
    case "needs-client": return "OAuth · needs a client ID";
    case "needs-sign-in": return "OAuth · sign-in needed";
    case "signed-in": return a.account ? `OAuth · ${a.account}` : "OAuth · signed in";
    case "needs-key": return "API key needed";
    case "key-set": return "API key set";
  }
}

/** Whether the server cannot work until the user acts (its panel opens by itself). */
export function mcpAuthNeedsAction(a: McpAuthView | undefined): boolean {
  return !!a && (a.state === "needs-client" || a.state === "needs-sign-in" || a.state === "needs-key");
}

const field = "w-full px-2 py-1 rounded-md bg-cc-input-bg border border-cc-border text-cc-fg text-xs focus:outline-none focus:ring-1 focus:ring-cc-primary";
const primary = "px-2 py-0.5 rounded-md bg-cc-primary text-white hover:bg-cc-primary-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
const quiet = "px-2 py-0.5 rounded-md border border-cc-border hover:bg-cc-hover cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Access of one HTTP server of a mcp.json, managed by Companion (the server
 * side is server/mcp-auth/): check whether it is open or private, set the
 * OAuth client or the API key, sign in and out. Sessions reach private
 * servers through Companion, which adds the credentials: one sign-in serves
 * every Claude and Codex session, of every domain for GLOBAL's servers.
 * With the browser on another device, the sign-in page ends on an address
 * that does not load (localhost): the user pastes it here.
 */
export function DomainMcpAuth({
  slug,
  name,
  auth,
  onChanged,
}: {
  /** The domain the page shows (the API finds the server's owner). */
  slug: string;
  name: string;
  auth: McpAuthView;
  /** Reload the domains after a change. */
  onChanged: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [signIn, setSignIn] = useState<{ authUrl: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [editClient, setEditClient] = useState(false);
  const [editKey, setEditKey] = useState(false);
  const ids = { clientId: useId(), secret: useId(), header: useId(), key: useId(), pasted: useId() };
  const [clientId, setClientId] = useState(auth.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [header, setHeader] = useState(auth.header ?? "Authorization");
  const [key, setKey] = useState("");

  // A sign-in finished in a browser on this machine lands on Companion's
  // callback by itself: poll until the state says so.
  useEffect(() => {
    if (!signIn) return;
    if (auth.state === "signed-in") {
      setSignIn(null);
      setPasted("");
      return;
    }
    const t = setInterval(onChanged, 3000);
    return () => clearInterval(t);
  }, [signIn, auth.state, onChanged]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setWorking(true);
    setError("");
    try {
      await action();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setWorking(false);
    }
  };
  const act = (a: McpAuthAction) => run(() => api.mcpAuth(slug, name, a));
  const startSignIn = () => run(async () => setSignIn(await api.mcpSignIn(slug, name)));
  const shared = auth.owner === "global" ? " Shared by every domain (GLOBAL's server)." : "";

  const clientForm = (
    <form
      aria-label={`OAuth client of ${name}`}
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act({ action: "client", clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) })
          .then((ok) => { if (ok) { setSecret(""); setEditClient(false); } });
      }}
    >
      <p className="text-cc-muted">
        Register an OAuth client with the provider (type "Web application") with this redirect URI, then enter its ID and secret:
      </p>
      {auth.redirectUri && <p className="font-mono-code break-all select-all">{auth.redirectUri}</p>}
      <div>
        <label htmlFor={ids.clientId} className="block text-cc-muted">Client ID</label>
        <input id={ids.clientId} value={clientId} onChange={(e) => setClientId(e.target.value)} className={`${field} font-mono-code`} />
      </div>
      <div>
        <label htmlFor={ids.secret} className="block text-cc-muted">
          Client secret{auth.hasClientSecret ? " (saved: leave empty to keep it)" : ""}
        </label>
        <input id={ids.secret} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} className={`${field} font-mono-code`} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={working || !clientId.trim()} className={primary}>Save client</button>
        {editClient && <button type="button" onClick={() => setEditClient(false)} className={quiet}>Cancel</button>}
      </div>
    </form>
  );

  const keyForm = (
    <form
      aria-label={`API key of ${name}`}
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void act({ action: "key", header: header.trim(), value: key.trim() }).then((ok) => { if (ok) { setKey(""); setEditKey(false); } });
      }}
    >
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <div>
          <label htmlFor={ids.header} className="block text-cc-muted">Header</label>
          <input id={ids.header} value={header} onChange={(e) => setHeader(e.target.value)} className={`${field} font-mono-code`} />
        </div>
        <div>
          <label htmlFor={ids.key} className="block text-cc-muted">Key or token</label>
          <input id={ids.key} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={`${field} font-mono-code`} />
        </div>
      </div>
      <p className="text-cc-muted">For Authorization, a bare token is sent as "Bearer &lt;token&gt;".</p>
      <div className="flex gap-2">
        <button type="submit" disabled={working || !key.trim()} className={primary}>Save key</button>
        {editKey && <button type="button" onClick={() => setEditKey(false)} className={quiet}>Cancel</button>}
      </div>
    </form>
  );

  return (
    <div role="group" aria-label={`Access to ${name}`} className="space-y-1.5 text-[11px]">
      {auth.state === "unchecked" && (
        <div className="flex items-center gap-2">
          <span className="text-cc-muted">Companion has not checked whether this server needs a sign-in.</span>
          <button type="button" onClick={() => void act({ action: "check" })} disabled={working} className={quiet}>Check access</button>
        </div>
      )}
      {auth.state === "manual" && (
        <div className="flex items-center gap-2">
          <span className="text-cc-muted">Its credentials are headers in mcp.json. Companion can manage them instead.</span>
          <button type="button" onClick={() => void act({ action: "check" })} disabled={working} className={quiet}>Check access</button>
        </div>
      )}
      {auth.state === "open" && (
        <div className="flex items-center gap-2">
          <span className="text-cc-muted">Open: no sign-in needed.</span>
          <button type="button" onClick={() => void act({ action: "check" })} disabled={working} className={quiet}>Check again</button>
          <button type="button" onClick={() => setEditKey(true)} disabled={working} className={quiet}>Use an API key</button>
        </div>
      )}

      {auth.state === "needs-client" && clientForm}

      {(auth.state === "needs-sign-in" || auth.state === "signed-in") && (
        <>
          <p>
            {auth.state === "signed-in" ? `Signed in${auth.account ? ` as ${auth.account}` : ""}.` : "Sign in to use this server in every session."}
            <span className="text-cc-muted">
              {auth.sharedWith?.length ? ` Same sign-in: ${auth.sharedWith.join(", ")}.` : ""}{shared}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void startSignIn()} disabled={working} className={auth.state === "signed-in" ? quiet : primary}>
              {auth.state === "signed-in" ? "Sign in again" : "Sign in"}
            </button>
            {auth.state === "signed-in" && (
              <button type="button" onClick={() => void act({ action: "sign-out" })} disabled={working} className={quiet}>Sign out</button>
            )}
            {!auth.dynamicClient && !editClient && (
              <button type="button" onClick={() => setEditClient(true)} className="text-cc-muted hover:text-cc-fg cursor-pointer">
                Client {auth.clientId ? `${auth.clientId.slice(0, 12)}…` : ""} · Change
              </button>
            )}
          </div>
          {editClient && clientForm}
          {signIn && (
            <form
              aria-label={`Finish the sign-in to ${name}`}
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!pasted.trim()) return;
                void act({ action: "finish", url: pasted.trim() }).then((ok) => { if (ok) { setSignIn(null); setPasted(""); } });
              }}
            >
              <a href={signIn.authUrl} target="_blank" rel="noreferrer" className={`inline-block ${primary}`}>Open the sign-in page</a>
              <p className="text-cc-muted">
                On this computer the sign-in completes by itself. From another device the last page does not load: copy its address
                and paste it here.
              </p>
              <label htmlFor={ids.pasted} className="sr-only">Address the sign-in page ended on</label>
              <div className="flex gap-1.5">
                <input
                  id={ids.pasted}
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="http://localhost:…/api/mcp-auth/callback?…"
                  className={`${field} flex-1 min-w-0 font-mono-code text-[10px]`}
                />
                <button type="submit" disabled={working || !pasted.trim()} className={quiet}>Finish</button>
                <button type="button" onClick={() => setSignIn(null)} className={quiet}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}

      {(auth.state === "needs-key" || editKey) && keyForm}
      {auth.state === "key-set" && !editKey && (
        <div className="flex items-center gap-2">
          <span className="text-cc-muted">Key set (header {auth.header}).{shared}</span>
          <button type="button" onClick={() => setEditKey(true)} disabled={working} className={quiet}>Change</button>
          <button type="button" onClick={() => void act({ action: "key", header: auth.header ?? "Authorization", value: "" })} disabled={working} className={quiet}>
            Remove
          </button>
        </div>
      )}

      {(error || auth.error) && <p role="alert" className="text-cc-error">{error || auth.error}</p>}
    </div>
  );
}
