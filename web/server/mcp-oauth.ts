/**
 * MCP OAuth logins started from Companion. The sign-in page redirects to a
 * listener the CLI opened on Companion's machine (localhost). When the
 * browser runs elsewhere (a phone, another computer) that redirect cannot
 * load, so the user pastes the URL and Companion delivers it.
 */

/** Whether `raw` is an OAuth redirect to a loopback listener, the only URL Companion fetches for the user. */
export function isLoopbackCallback(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(host)
    && url.pathname.startsWith("/callback")
    && (url.searchParams.has("code") || url.searchParams.has("error"));
}

/**
 * Deliver a pasted redirect to the CLI's loopback listener, as the browser
 * would have. Codex has no command to submit it, so Companion (on the same
 * machine as the CLI) requests the URL itself. Resolves to an error message,
 * or null when the listener answered.
 */
export async function deliverLoopbackCallback(raw: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (!isLoopbackCallback(raw)) {
    return "Paste the full address the sign-in page redirected to (http://localhost:…/callback?code=…)";
  }
  try {
    const res = await fetchImpl(raw, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.status < 500 ? null : `The login listener answered ${res.status}`;
  } catch (err) {
    return `The login listener did not answer: ${err instanceof Error ? err.message : String(err)}. Start the login again.`;
  }
}
