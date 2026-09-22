import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { MarkdownContent } from "./MessageBubble.js";
import { api } from "../api.js";
import { fileKind, type FileKind } from "../utils/local-file-link.js";

/**
 * Shows a file that lives on the machine running Companion.
 *
 * Reached by clicking a link the model wrote as an absolute path — those
 * resolve against Companion's origin and would otherwise 404. Text and
 * Markdown come from /fs/read, images from /fs/raw; anything else is offered
 * as a download, since the browser can't render it anyway.
 */
export function FileViewerModal() {
  const path = useStore((s) => s.viewerFilePath);
  const close = useStore((s) => s.closeFileViewer);

  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const kind: FileKind | null = path ? fileKind(path) : null;
  const name = path ? path.split("/").pop() : "";

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setContent(null); setBlobUrl(null); setError(null); setLoading(true);

    (async () => {
      try {
        if (kind === "image") {
          const url = await api.getFileBlob(path);
          createdUrl = url;
          if (!cancelled) setBlobUrl(url); else URL.revokeObjectURL(url);
        } else if (kind === "markdown" || kind === "text") {
          const res = await api.readFile(path);
          if (!cancelled) setContent(res.content);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Cannot open file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // Revoke on unmount too: the object URL would otherwise leak the blob.
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [path, kind]);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path, close]);

  if (!path) return null;

  // Download through the authenticated fetch rather than a plain href: a bare
  // <a href="/api/fs/raw?..."> carries no auth header and would 401 unless the
  // cookie happens to be set.
  async function download() {
    if (!path) return;
    try {
      const url = blobUrl ?? await api.getFileBlob(path);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (!blobUrl) setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cannot download file");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6"
      onClick={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className="flex flex-col w-full max-w-3xl max-h-[85vh] bg-cc-card border border-cc-border rounded-[14px] shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-cc-border shrink-0">
          <span className="text-[12px] font-mono-code text-cc-fg truncate" title={path}>{name}</span>
          <span className="text-[11px] text-cc-muted truncate hidden sm:inline">{path}</span>
          <div className="flex-1" />
          <button
            onClick={download}
            className="text-[11px] text-cc-primary hover:underline px-1.5 py-0.5 shrink-0 cursor-pointer"
          >
            Download
          </button>
          <button
            onClick={close}
            aria-label="Close"
            className="text-[13px] text-cc-muted hover:text-cc-fg px-1.5 py-0.5 cursor-pointer shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="overflow-auto p-3 min-h-0">
          {loading && <div className="text-[12px] text-cc-muted">Loading…</div>}

          {error && (
            <div role="alert" className="text-[12px] text-cc-error font-mono-code break-words">
              {error}
            </div>
          )}

          {!loading && !error && kind === "image" && blobUrl && (
            <img src={blobUrl} alt={name} className="max-w-full h-auto mx-auto rounded" />
          )}

          {!loading && !error && kind === "markdown" && content !== null && (
            <MarkdownContent text={content} />
          )}

          {!loading && !error && kind === "text" && content !== null && (
            <pre className="text-[12px] text-cc-fg font-mono-code whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}

          {!loading && !error && kind === "binary" && (
            <div className="text-[12px] text-cc-muted">
              This file type can't be previewed. Use Download to open it locally.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
