// In-app documentation registry.
//
// Markdown docs live under `./content/**/*.md` and are bundled at build time via
// Vite's import.meta.glob (eager + ?raw). Each file may carry a leading YAML
// frontmatter block (`title`, `description`) that we parse at runtime to drive
// the page title and navigation label. The frontmatter is stripped from the
// rendered body.

const files = import.meta.glob("./content/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export interface Doc {
  /** Doc path used in routing, e.g. "guides/agents" or "index". */
  path: string;
  /** Title from frontmatter (falls back to the path). */
  title: string;
  /** Description from frontmatter (may be empty). */
  description: string;
  /** Markdown body with frontmatter stripped. */
  body: string;
}

/** Strip the leading `./content/` prefix and `.md` suffix to get a doc path. */
function keyToPath(key: string): string {
  return key.replace(/^\.\/content\//, "").replace(/\.md$/, "");
}

/**
 * Parse a leading YAML frontmatter block delimited by `---` lines.
 * Only the simple `key: value` form is supported (sufficient for our docs).
 * Returns the extracted fields plus the body with the block removed.
 */
function parseFrontmatter(raw: string): { title: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) {
    return { title: "", description: "", body: raw };
  }
  const block = match[1];
  const body = raw.slice(match[0].length);
  let title = "";
  let description = "";
  for (const line of block.split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    // Strip surrounding quotes if present.
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (key === "title") title = value;
    else if (key === "description") description = value;
  }
  return { title, description, body };
}

const docsByPath: Record<string, Doc> = {};
for (const [key, raw] of Object.entries(files)) {
  const path = keyToPath(key);
  const { title, description, body } = parseFrontmatter(raw);
  docsByPath[path] = { path, title: title || path, description, body };
}

/** Return the doc at a given path, or null if it doesn't exist. */
export function getDoc(path: string): Doc | null {
  return docsByPath[path] ?? null;
}

/** All docs, keyed by path. */
export const docs = docsByPath;

// ─── Navigation structure ────────────────────────────────────────────────────
// Mirrors the groups/order from the former Mintlify docs.json.

export interface NavEntry {
  /** Doc path, e.g. "guides/agents". */
  path: string;
  /** Display label (resolved from frontmatter title, falling back to path). */
  label: string;
}

export interface NavGroup {
  group: string;
  entries: NavEntry[];
}

const NAV_PATHS: { group: string; paths: string[] }[] = [
  { group: "Get Started", paths: ["index", "get-started/installation"] },
  {
    group: "Guides",
    paths: [
      "guides/sessions-and-permissions",
      "guides/docker-and-environments",
      "guides/git-worktrees",
      "guides/agents",
      "guides/chat-webhooks",
      "guides/saved-prompts",
      "guides/linear-integration",
    ],
  },
  { group: "Deploy", paths: ["deploy/cloud-vm"] },
  { group: "Reference", paths: ["reference/cli-and-api", "reference/troubleshooting"] },
];

/** Navigation groups with resolved labels. Only includes docs that exist. */
export const navGroups: NavGroup[] = NAV_PATHS.map(({ group, paths }) => ({
  group,
  entries: paths
    .filter((path) => path in docsByPath)
    .map((path) => ({ path, label: docsByPath[path].title })),
}));

/** The default doc path shown at `#/docs` (the index, or the first nav entry). */
export const defaultDocPath: string =
  "index" in docsByPath ? "index" : navGroups[0]?.entries[0]?.path ?? "";
