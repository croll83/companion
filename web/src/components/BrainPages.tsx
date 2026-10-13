import { useCallback, useEffect, useId, useState, type MouseEvent } from "react";
import { api, type BrainPageDoc, type BrainPageSummary } from "../api.js";
import { MarkdownContent } from "./MessageBubble.js";
import { FIELD } from "./BrainForm.js";

const BUTTON = "px-2.5 py-1 rounded-md text-[12px] bg-cc-hover hover:bg-cc-active disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed";
/** Wiki links become links to this fragment; a click on one opens the page in the tab. */
const PAGE_LINK = "#brain-page=";

/** The page without its YAML frontmatter (shown apart as metadata). */
export function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

/**
 * `[[target]]` and `[[target|alias]]` as markdown links the tab can open,
 * outside fenced code blocks. The text is data: react-markdown renders no
 * raw HTML, and the link target is only ever a fragment of this page.
 */
export function linkWikiLinks(md: string): string {
  return md
    .split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (m, bang: string, inner: string) => {
      if (bang) return m;
      const [target, alias] = inner.split(/\\?\|/);
      const page = target.split("#")[0].trim();
      const label = (alias ?? target).trim().replace(/[[\]]/g, "");
      return page ? `[${label}](${PAGE_LINK}${encodeURIComponent(page)})` : m;
    })))
    .join("");
}

/** One page: its metadata and its text rendered as markdown (no raw HTML). */
function PageView({ page, onOpen, onBack }: { page: BrainPageDoc; onOpen: (slug: string) => void; onBack: () => void }) {
  // Clicks on wiki links open the page here instead of following the fragment.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!href.startsWith(PAGE_LINK)) return;
    e.preventDefault();
    e.stopPropagation();
    onOpen(decodeURIComponent(href.slice(PAGE_LINK.length)));
  };
  return (
    <article aria-label={`Page ${page.title}`} className="space-y-2">
      <button type="button" onClick={onBack} className="text-[12px] text-cc-primary hover:underline cursor-pointer">‹ All pages</button>
      <header>
        <h4 className="text-[14px] font-semibold">{page.title}</h4>
        <p className="text-[11px] text-cc-muted">
          <span className="font-mono-code">{page.path}</span>
          {page.type ? ` · ${page.type}` : ""}
          {page.updated ? ` · updated ${page.updated}` : ""}
          {page.tags.length ? ` · ${page.tags.join(", ")}` : ""}
        </p>
        {page.sources.length > 0 && (
          <p className="text-[11px] text-cc-muted break-all">Sources: {page.sources.join(", ")}</p>
        )}
      </header>
      <div onClickCapture={onClickCapture} className="rounded-lg border border-cc-border p-3">
        <MarkdownContent text={linkWikiLinks(stripFrontmatter(page.markdown))} />
      </div>
    </article>
  );
}

/**
 * The Pages tab of an embedded brain: every page (or the matches of a
 * search), and one page read in place, with the wiki's [[links]] followed
 * inside the tab. Secrets are hidden as sessions see them when the brain
 * hides secrets. The text comes from the wiki: it is rendered as markdown
 * only, never as HTML.
 */
export function BrainPages({ slug }: { slug: string }) {
  const [pages, setPages] = useState<BrainPageSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [shownQuery, setShownQuery] = useState("");
  const [page, setPage] = useState<BrainPageDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchId = useId();

  const load = useCallback(async (q: string) => {
    setBusy(true);
    setError("");
    try {
      setPages((await api.brainPages(slug, q)).pages);
      setShownQuery(q.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [slug]);

  useEffect(() => { void load(""); }, [load]);

  const open = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      setPage(await api.brainPage(slug, name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Pages" className="space-y-2">
      {error && <p role="alert" className="text-[12px] text-cc-error">{error}</p>}
      {page ? (
        <PageView page={page} onOpen={(s) => void open(s)} onBack={() => setPage(null)} />
      ) : (
        <>
          <form role="search" aria-label="Search pages" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void load(query); }}>
            <label htmlFor={searchId} className="sr-only">Search the pages</label>
            <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the pages" className={FIELD} />
            <button type="submit" disabled={busy} className={BUTTON}>Search</button>
          </form>
          <div className="flex gap-2 text-[12px]">
            <button type="button" onClick={() => void open("index")} className="text-cc-primary hover:underline cursor-pointer">index.md</button>
            <button type="button" onClick={() => void open("schema")} className="text-cc-primary hover:underline cursor-pointer">SCHEMA.md</button>
            <button type="button" onClick={() => void open("log")} className="text-cc-primary hover:underline cursor-pointer">log.md</button>
            {shownQuery && (
              <button type="button" onClick={() => { setQuery(""); void load(""); }} className="ml-auto text-cc-muted hover:underline cursor-pointer">
                Show all pages
              </button>
            )}
          </div>
          {!pages && busy && <p className="text-[12px] text-cc-muted">Loading pages…</p>}
          {pages && (
            pages.length === 0 ? (
              <p className="text-[12px] text-cc-muted">
                {shownQuery ? `No page matches "${shownQuery}".` : "No pages yet. Add a source in the Inbox tab: the consolidation turns sources into pages."}
              </p>
            ) : (
              <>
                <p className="text-[11px] text-cc-muted">{shownQuery ? `${pages.length} pages match "${shownQuery}"` : `${pages.length} pages`}</p>
                <ul className="divide-y divide-cc-separator rounded-lg border border-cc-border">
                  {pages.map((p) => (
                    <li key={p.slug}>
                      <button type="button" onClick={() => void open(p.slug)} className="w-full text-left px-2.5 py-1.5 hover:bg-cc-hover cursor-pointer">
                        <span className="block text-[12px] font-medium">{p.title}</span>
                        <span className="block text-[10px] text-cc-muted font-mono-code truncate">{p.path}{p.tags.length ? ` · ${p.tags.join(", ")}` : ""}</span>
                        {p.snippet && <span className="block text-[11px] text-cc-muted line-clamp-2">{p.snippet}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
        </>
      )}
    </section>
  );
}
