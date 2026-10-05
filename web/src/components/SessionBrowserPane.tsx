import { useCallback, useRef, useState } from "react";

interface SessionBrowserPaneProps {
  sessionId: string;
}

export function SessionBrowserPane({ sessionId }: SessionBrowserPaneProps) {
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [navUrl, setNavUrl] = useState("http://localhost:3000");
  const [navError, setNavError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Previews a dev server on this host: the URL is rewritten to the
  // companion's host-proxy route so the iframe works through a single port.
  const handleNavigate = useCallback(() => {
    if (!navUrl.trim()) return;
    setNavError(null);

    try {
      const parsed = new URL(navUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        setNavError("Only http:// and https:// URLs are supported");
        return;
      }
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        setNavError("Only localhost URLs are supported (e.g. http://localhost:3000)");
        return;
      }
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      const subPath = parsed.pathname.replace(/^\//, "");
      const proxyUrl = `/api/sessions/${encodeURIComponent(sessionId)}/browser/host-proxy/${port}/${subPath}${parsed.search}`;
      setBrowserUrl(proxyUrl);
    } catch {
      setNavError("Invalid URL");
    }
  }, [sessionId, navUrl]);

  const handleReload = useCallback(() => {
    if (iframeRef.current && browserUrl) {
      iframeRef.current.src = browserUrl;
    }
  }, [browserUrl]);

  return (
    <div className="h-full flex flex-col bg-cc-bg">
      {/* Toolbar */}
      <div className="shrink-0 px-3 py-2 border-b border-cc-border flex items-center gap-2">
        <button
          type="button"
          onClick={handleReload}
          className="flex items-center justify-center w-7 h-7 rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          aria-label="Reload browser"
          title="Reload"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M13.65 2.35a1 1 0 0 0-1.3 0L11 3.7A5.99 5.99 0 0 0 2 8a1 1 0 1 0 2 0 4 4 0 0 1 6.29-3.29L8.65 6.35a1 1 0 0 0 .7 1.7H13a1 1 0 0 0 1-1V3.4a1 1 0 0 0-.35-.7z M14 8a1 1 0 1 0-2 0 4 4 0 0 1-6.29 3.29l1.64-1.64a1 1 0 0 0-.7-1.7H3.05a1 1 0 0 0-1 1v3.65a1 1 0 0 0 1.7.7L5 11.7A5.99 5.99 0 0 0 14 8z" />
          </svg>
        </button>
        <input
          type="text"
          value={navUrl}
          onChange={(e) => setNavUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleNavigate(); }}
          placeholder="http://localhost:3000"
          className="flex-1 px-2 py-1 text-xs rounded bg-cc-bg border border-cc-border text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary"
          aria-label="Navigate URL"
        />
        <button
          type="button"
          onClick={handleNavigate}
          className="px-3 py-1 rounded text-xs font-medium bg-cc-primary text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
        >
          Go
        </button>
      </div>

      {/* Navigation error banner */}
      {navError && (
        <div className="shrink-0 px-3 py-1.5 bg-cc-error/10 border-b border-cc-error/30 text-xs text-cc-error flex items-center justify-between">
          <span>{navError}</span>
          <button type="button" onClick={() => setNavError(null)} className="ml-2 hover:underline cursor-pointer">Dismiss</button>
        </div>
      )}

      {/* Browser iframe */}
      <div className="flex-1 min-h-0">
        {browserUrl ? (
          <iframe
            ref={iframeRef}
            src={browserUrl}
            className="w-full h-full border-0"
            title="Browser preview"
            // No allow-same-origin: the proxied dev-server content stays isolated
            // from the companion's own origin.
            sandbox="allow-scripts allow-forms allow-popups"
          />
        ) : (
          <div className="h-full flex items-center justify-center p-4 text-sm text-cc-muted">
            Enter a URL and click Go to preview.
          </div>
        )}
      </div>
    </div>
  );
}
