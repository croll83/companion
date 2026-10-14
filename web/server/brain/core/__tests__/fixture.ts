// A generic, synthetic wiki for the brain tests and the bundle smoke script
// (scripts/brain-smoke.ts): the team wiki of a fictional company, written to
// a temporary folder. It follows the wiki conventions the brain expects
// (SCHEMA.md with a domain and a tag taxonomy, index.md, log.md, page
// folders, raw/ sources) and lints clean, plus a few edge cases: a sub-wiki,
// an Italian page, fake secrets for the redaction tests, a binary source,
// folders and files that must not load.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Fake secrets planted in entities/office-network.md (never real values). */
export const FIXTURE_SECRETS = { assigned: "Sup3rSecretValue99", cli: "Fixture_2026x" };

const FILLER =
  "This paragraph exists so the page reads like a real one: it explains the context, the owners, the usual failure modes " +
  "and where to look first when something breaks. Keep it short, cite the sources and link the related pages.";

function page(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n\n${FILLER}\n`;
}

const FILES: Record<string, string> = {
  "SCHEMA.md": [
    "# Northwind team wiki: schema",
    "",
    "## Domain",
    "Northwind's engineering knowledge (a test fixture): the billing service, the deploy pipeline, the office network and the backup procedure.",
    "",
    "## Page Types",
    "- entity (entities/), concept (concepts/), comparison (comparisons/), query (queries/)",
    "",
    "## Tag Taxonomy",
    "**Systems:**",
    "- billing, deploy, network, backup",
    "- `queue`",
    "**Meta:**",
    "- comparison, capacity, procedure",
    "",
    "## Conventions",
    "Frontmatter with title, created, updated, type, tags, sources. Link with [[slug]]. Sources live in raw/.",
    "",
  ].join("\n"),
  "index.md": [
    "# Index",
    "",
    "## Start Here",
    "- [[deploy-pipeline]] — how code reaches production",
    "- [[billing-service]] — the billing service",
    "",
    "## Systems",
    "- [[office-network]] — office network",
    "- [[procedura-backup]] — procedura di backup",
    "",
    "## Analyses",
    "- [[queue-a-vs-queue-b]] — queue comparison",
    "- [[capacity-2026-10-01]] — capacity check",
    "",
  ].join("\n"),
  "log.md": [
    "# Log",
    "",
    "Format example:",
    "```",
    "## [YYYY-MM-DD HH:MM] action",
    "```",
    "",
    "## [2026-09-01 10:00] create",
    "- Wiki created.",
    "",
    "## [2026-09-15 12:00] ingest",
    "- Billing design notes ingested.",
    "",
    "## [2026-10-01 09:30] update",
    "- Capacity check added.",
    "",
  ].join("\n"),
  "entities/billing-service.md": page(
    { title: "Billing Service", created: "2026-09-01", updated: "2026-09-15", type: "entity", tags: "[billing, queue]", sources: "[raw/articles/billing-design-notes.md]" },
    "# Billing Service\n\nThe billing service listens on port 8000 and reads invoices from the queue. It is deployed by the [[deploy-pipeline]] and runs in the [[office-network]].\n\nDesign notes: ^[raw/articles/billing-design-notes.md]",
  ),
  "entities/office-network.md": page(
    { title: "Office Network", created: "2026-09-01", updated: "2026-09-20", type: "entity", tags: "[network]", sources: "[raw/notes/components.md]" },
    `# Office Network\n\nThe router is reached with \`sshpass -p '${FIXTURE_SECRETS.cli}' ssh admin@router\` and its API uses password: ${FIXTURE_SECRETS.assigned} for now. The [[billing-service]] and the [[deploy-pipeline]] runners live here.`,
  ),
  "concepts/deploy-pipeline.md": page(
    { title: "Deploy Pipeline", created: "2026-09-01", updated: "2026-09-10", type: "concept", tags: "[deploy]", sources: "[raw/notes/components.md]" },
    "# Deploy Pipeline\n\nEvery merge to main is built, tested and deployed by the pipeline. Deploying the [[billing-service]] needs a green build; the runners sit in the [[office-network]].\n\n```\n[[not-a-link-inside-code]]\n```",
  ),
  "concepts/procedura-backup.md": page(
    { title: "Procedura di backup", created: "2026-09-02", updated: "2026-09-12", type: "concept", tags: "[backup, procedure]", sources: "[raw/notes/components.md]" },
    "# Procedura di backup\n\nI backup dei server partono ogni notte alle 02:00 e le copie restano trenta giorni. Riguardano il [[billing-service]] e la [[office-network]].",
  ),
  "comparisons/queue-a-vs-queue-b.md": page(
    { title: "Queue A vs Queue B", created: "2026-09-05", updated: "2026-09-05", type: "comparison", tags: "[queue, comparison]", sources: "[raw/articles/billing-design-notes.md]" },
    "# Queue A vs Queue B\n\nQueue A keeps ordering, Queue B is cheaper. The [[billing-service]] uses Queue A; see [[capacity-2026-10-01]].",
  ),
  "queries/capacity-2026-10-01.md": page(
    { title: "Capacity check 2026-10-01", created: "2026-10-01", updated: "2026-10-01", type: "query", tags: "[capacity]", sources: "[raw/notes/components.md]" },
    "# Capacity check 2026-10-01\n\nThe [[billing-service]] peaks at 40 requests per second; the [[queue-a-vs-queue-b]] analysis still holds.",
  ),
  "handbook/SCHEMA.md": "# Handbook schema\n\nPages here follow their own rules.\n",
  "handbook/index.md": "# Handbook\n\n- [[Onboarding]]\n",
  "handbook/guides/Onboarding.md": "# Onboarding\n\nRead [[deploy-pipeline]] first.\n",
  "raw/articles/billing-design-notes.md": [
    "# Billing design notes",
    "",
    "Invoices are canonicalized before they enter the queue.",
    "Each invoice carries an idempotency key.",
    "Retries use exponential backoff.",
    "The ledger is append-only.",
    "",
  ].join("\n"),
  "raw/notes/components.md": "# Components\n\nRouter, runners, billing service, backup server.\n",
  "_archive/old.md": "# Old architecture\n",
  "archive/plan.md": "# Plan\n",
  ".trash/deleted.md": "# Deleted\n",
  "Untitled.md": "loose file at the root\n",
};

/** Write the fixture wiki into `dir` (created when missing). */
export function writeFixtureWiki(dir: string): string {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  mkdirSync(join(dir, "raw", "assets"), { recursive: true });
  writeFileSync(join(dir, "raw", "assets", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
  return dir;
}

export function tmp(prefix = "brain-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** A fresh fixture wiki in a temp folder, optionally its own git repository with one commit. */
export function makeWiki(withGit = false): string {
  const dir = writeFixtureWiki(tmp("brain-wiki-"));
  if (withGit) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
  }
  return dir;
}
