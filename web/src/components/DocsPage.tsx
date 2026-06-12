import { useMemo, type ComponentProps } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getDoc, navGroups, defaultDocPath } from "../docs/registry.js";
import { navigateHome } from "../utils/routing.js";

interface DocsPageProps {
  /** Doc path from the route (everything after "#/docs/"). Empty → default doc. */
  docPath: string;
}

/**
 * Markdown renderers styled to match the app's chat markdown conventions
 * (cc-fg / cc-muted / cc-border tokens). Internal hash links (#/docs/...,
 * #anchors) render as plain anchors so the SPA hash router handles them;
 * external links open in a new tab.
 */
const markdownComponents: ComponentProps<typeof Markdown>["components"] = {
  h1: ({ children }) => <h1 className="text-2xl font-bold text-cc-fg mt-6 mb-3 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-bold text-cc-fg mt-6 mb-2 border-b border-cc-border pb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-semibold text-cc-fg mt-5 mb-2">{children}</h3>,
  h4: ({ children }) => <h4 className="text-base font-semibold text-cc-fg mt-4 mb-1">{children}</h4>,
  p: ({ children }) => <p className="mb-3 leading-relaxed text-cc-fg">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-cc-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => <ul className="list-disc pl-6 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6 mb-3 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="text-cc-fg leading-relaxed">{children}</li>,
  a: ({ href, children }) => {
    const isInternal = !!href && (href.startsWith("#") || href.startsWith("/"));
    if (isInternal) {
      return (
        <a href={href} className="text-cc-primary hover:underline">
          {children}
        </a>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-cc-primary hover:underline">
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-cc-primary/40 pl-3 my-3 text-cc-muted">{children}</blockquote>
  ),
  hr: () => <hr className="border-cc-border my-6" />,
  code: (props: ComponentProps<"code">) => {
    const { children, className } = props;
    const match = /language-(\w+)/.exec(className || "");
    const isBlock = match || (typeof children === "string" && children.includes("\n"));
    if (isBlock) {
      return (
        <pre className="my-3 px-4 py-3 rounded-lg bg-cc-code-bg text-cc-code-fg text-[13px] font-mono-code leading-relaxed overflow-x-auto border border-cc-border">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="px-1.5 py-0.5 rounded-md bg-cc-fg/[0.06] text-[12.5px] font-mono-code text-cc-fg/80 border border-cc-border/40">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full text-sm border border-cc-border rounded-lg overflow-hidden">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-cc-code-bg/50">{children}</thead>,
  th: ({ children }) => (
    <th className="px-3 py-1.5 text-left text-xs font-semibold text-cc-fg border-b border-cc-border">{children}</th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-1.5 text-xs text-cc-fg border-b border-cc-border align-top">{children}</td>
  ),
  img: ({ src, alt }) => (
    <img src={typeof src === "string" ? src : undefined} alt={alt} className="max-w-full rounded-lg border border-cc-border my-3" />
  ),
};

/**
 * In-app documentation page rendered at `#/docs` and `#/docs/<path>`.
 * Left nav lists the doc groups; the main area renders the active doc's
 * markdown body. Replaces the former external Mintlify site.
 */
export function DocsPage({ docPath }: DocsPageProps) {
  const activePath = docPath || defaultDocPath;
  const doc = useMemo(() => getDoc(activePath), [activePath]);

  return (
    <div className="absolute inset-0 flex bg-cc-bg text-cc-fg overflow-hidden">
      {/* Left navigation */}
      <nav
        aria-label="Documentation"
        className="hidden md:flex flex-col w-[240px] shrink-0 border-r border-cc-border overflow-y-auto py-4 px-3"
      >
        <a
          href="#/"
          onClick={(e) => {
            e.preventDefault();
            navigateHome();
          }}
          className="flex items-center gap-1.5 text-[13px] text-cc-muted hover:text-cc-fg mb-4 px-2"
        >
          <span aria-hidden="true">←</span> Back to app
        </a>
        {navGroups.map((group) => (
          <div key={group.group} className="mb-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-cc-muted px-2 mb-1">
              {group.group}
            </div>
            <ul className="space-y-0.5">
              {group.entries.map((entry) => {
                const isActive = entry.path === activePath;
                return (
                  <li key={entry.path}>
                    <a
                      href={`#/docs/${entry.path}`}
                      aria-current={isActive ? "page" : undefined}
                      className={`block rounded-md px-2 py-1 text-[13px] transition-colors ${
                        isActive
                          ? "bg-cc-primary/10 text-cc-primary font-medium"
                          : "text-cc-fg/80 hover:bg-cc-hover hover:text-cc-fg"
                      }`}
                    >
                      {entry.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Main content */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {/* Mobile back link (nav is hidden on small screens) */}
        <div className="md:hidden border-b border-cc-border px-4 py-2">
          <a
            href="#/"
            onClick={(e) => {
              e.preventDefault();
              navigateHome();
            }}
            className="text-[13px] text-cc-muted hover:text-cc-fg"
          >
            ← Back to app
          </a>
        </div>
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-8 markdown-body">
          {doc ? (
            <article>
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {doc.body}
              </Markdown>
            </article>
          ) : (
            <div>
              <h1 className="text-2xl font-bold text-cc-fg mb-2">Page not found</h1>
              <p className="text-cc-muted">
                No documentation page exists at <code className="font-mono-code">{activePath}</code>. Pick a page
                from the navigation.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
