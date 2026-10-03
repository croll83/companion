/**
 * Links to files on the machine running Companion.
 *
 * Models routinely mention files they just wrote as absolute paths. Markdown
 * renderers turn `/home/u/notes.md` into an href, which the browser resolves
 * against Companion's own origin — producing
 * `https://companion.example/home/u/notes.md`, a link that 404s because no such
 * route exists. The file is right there on disk, reachable through /fs/read
 * and /fs/raw, so these links are worth intercepting and showing in place.
 */

/** Paths that belong to Companion itself and must never be treated as files. */
const APP_PREFIXES = ["/api/", "/assets/", "/ws/", "/static/", "/icons/"];

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "tiff", "tif",
]);
/** Rendered as monospace text. Anything not listed falls back to a download. */
const TEXT_EXT = new Set([
  "txt", "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "csv", "tsv", "sql", "sh", "bash", "zsh", "fish", "ps1",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "swift", "scala", "lua", "pl", "r",
  "html", "htm", "css", "scss", "less", "xml", "svelte", "vue",
  "diff", "patch", "lock", "gitignore", "dockerfile", "makefile",
]);

export type FileKind = "markdown" | "image" | "text" | "binary";

/** Lowercased extension, or "" when the name has none. */
export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  // A leading dot means a dotfile (".gitignore"), not an empty extension.
  if (dot <= 0) return name.startsWith(".") ? name.slice(1).toLowerCase() : "";
  return name.slice(dot + 1).toLowerCase();
}

/** How the viewer should present this file. */
export function fileKind(path: string): FileKind {
  const ext = fileExtension(path);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

/**
 * The absolute filesystem path a link points at, or null when the link is an
 * ordinary one (external site, in-app route, anchor…) and must be left alone.
 */
export function parseLocalFileLink(href: string | undefined, origin: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;          // someone else's site
  if (url.hash || url.search) return null;         // in-app route or query link
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith("/") || path === "/") return null;
  if (APP_PREFIXES.some((p) => path.startsWith(p))) return null;
  if (path.endsWith("/")) return null;             // a directory, not a file
  // Require a real filename: a dot in the last segment. Without this, every
  // single-word in-app route would be mistaken for a file.
  const last = path.split("/").pop() ?? "";
  if (!last.includes(".") || last === "." || last === "..") return null;
  return path;
}
