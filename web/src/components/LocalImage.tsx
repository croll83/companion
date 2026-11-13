import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";

/**
 * An image file on the machine running Companion, shown inline (an image the
 * model wrote and put in its answer, an attachment the user sent). The bytes
 * come from /fs/raw with the auth header, once per path: the object URL is
 * kept for the life of the page, so a re-render or a remount of the message
 * shows it at once instead of loading it again (which made the chat jump).
 * A file that cannot be read shows its name instead of a broken icon, and is
 * not asked again for a while. A click opens it in the file viewer.
 */

const loaded = new Map<string, string>();
const loading = new Map<string, Promise<string>>();
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30_000;

function load(path: string): Promise<string> {
  let p = loading.get(path);
  if (!p) {
    p = api.getFileBlob(path).then(
      (url) => {
        loaded.set(path, url);
        failedAt.delete(path);
        loading.delete(path);
        return url;
      },
      (err: unknown) => {
        failedAt.set(path, Date.now());
        loading.delete(path);
        throw err;
      },
    );
    loading.set(path, p);
  }
  return p;
}

const recentlyFailed = (path: string) => Date.now() - (failedAt.get(path) ?? -Infinity) < RETRY_AFTER_MS;

/** Forget what was loaded (tests). */
export function resetLocalImageCache(): void {
  loaded.clear();
  loading.clear();
  failedAt.clear();
}

export function LocalImage({ path, alt, className = "" }: { path: string; alt?: string; className?: string }) {
  const openFileViewer = useStore((s) => s.openFileViewer);
  const [url, setUrl] = useState(() => loaded.get(path) ?? null);
  const [failed, setFailed] = useState(() => !loaded.has(path) && recentlyFailed(path));
  const name = path.split("/").pop() || path;
  const label = alt || name;

  useEffect(() => {
    const cached = loaded.get(path);
    if (cached) {
      setUrl(cached);
      setFailed(false);
      return;
    }
    if (recentlyFailed(path)) {
      setFailed(true);
      return;
    }
    let live = true;
    setUrl(null);
    setFailed(false);
    load(path).then((u) => { if (live) setUrl(u); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [path]);

  const open = () => openFileViewer(path);
  if (url) {
    return (
      <button type="button" onClick={open} title={path} aria-label={`Open ${label}`} className="inline-block p-0 align-top cursor-zoom-in">
        <img src={url} alt={label} className={className} />
      </button>
    );
  }
  if (failed) {
    return (
      <button type="button" onClick={open} title={path} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-cc-border text-[12px] text-cc-muted hover:bg-cc-hover cursor-pointer">
        Image not available: {name}
      </button>
    );
  }
  return <span role="img" aria-label={`Loading ${label}`} title={path} className="inline-block w-40 h-28 rounded-lg bg-cc-hover animate-pulse align-top" />;
}
