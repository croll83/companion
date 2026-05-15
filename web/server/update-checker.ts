import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, type UpdateChannel } from "./settings-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read current version from package.json
const packageJsonPath = resolve(__dirname, "..", "package.json");
const currentVersion: string = JSON.parse(
  readFileSync(packageJsonPath, "utf-8"),
).version;

// Fork repo for GitHub Releases. Override with COMPANION_FORK_REPO env to make
// the auto-updater follow a different fork (e.g. for staging or testing).
export const FORK_REPO = process.env.COMPANION_FORK_REPO || "croll83/companion";
const GH_RELEASES_API = `https://api.github.com/repos/${FORK_REPO}/releases`;

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 10_000; // 10 seconds after boot

interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  lastChecked: number;
  isServiceMode: boolean;
  checking: boolean;
  updateInProgress: boolean;
  channel: UpdateChannel;
}

const state: UpdateState = {
  currentVersion,
  latestVersion: null,
  lastChecked: 0,
  isServiceMode: false,
  checking: false,
  updateInProgress: false,
  channel: "stable",
};

export function getUpdateState(): Readonly<UpdateState> {
  return { ...state };
}

export function getCurrentVersion(): string {
  return currentVersion;
}

/**
 * Minimal GitHub Release shape — only the fields the updater actually uses.
 * Documented at https://docs.github.com/en/rest/releases/releases
 */
interface GitHubRelease {
  tag_name: string;
  name?: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at?: string | null;
}

/**
 * Parse a release tag into a semver-ish version string.
 *
 * Expected tag format: `the-companion-v<semver>` (this is the convention used
 * by release-please for the npm package name "the-companion"). Anything else
 * returns null so callers can skip it.
 *
 * Examples:
 *   parseVersionFromTag("the-companion-v1.2.3")                → "1.2.3"
 *   parseVersionFromTag("the-companion-v1.2.3-preview.123")    → "1.2.3-preview.123"
 *   parseVersionFromTag("v1.2.3")                              → null
 *   parseVersionFromTag("")                                    → null
 */
export function parseVersionFromTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const match = /^the-companion-v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(tag);
  return match ? match[1] : null;
}

/** Build the GitHub Releases API URL (exported for tests). */
export function getReleasesUrl(): string {
  return `${GH_RELEASES_API}?per_page=20`;
}

export async function checkForUpdate(): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  try {
    // Read channel from settings on each check so switching is immediate.
    const channel = getSettings().updateChannel;
    if (channel !== state.channel) {
      state.latestVersion = null; // avoid cross-channel stale comparison
    }
    state.channel = channel;

    const url = getReleasesUrl();
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "the-companion-update-checker",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(
        `[update-checker] GitHub releases API returned ${res.status} for ${FORK_REPO}`,
      );
      return;
    }

    const releases = (await res.json()) as GitHubRelease[];
    if (!Array.isArray(releases)) {
      console.warn(
        "[update-checker] GitHub releases API returned a non-array payload",
      );
      return;
    }

    // Find the most recent (releases are returned by GitHub in created order,
    // newest first) release matching the current channel that has a parsable
    // tag. Drafts are always skipped.
    const wantPrerelease = channel === "prerelease";
    let pick: { version: string; release: GitHubRelease } | null = null;
    for (const r of releases) {
      if (r.draft) continue;
      if (Boolean(r.prerelease) !== wantPrerelease) continue;
      const version = parseVersionFromTag(r.tag_name);
      if (!version) continue;
      pick = { version, release: r };
      break;
    }

    if (pick) {
      state.latestVersion = pick.version;
      state.lastChecked = Date.now();
      if (isUpdateAvailable()) {
        console.log(
          `[update-checker] Update available (${channel}): ${currentVersion} -> ${state.latestVersion}`,
        );
      }
    } else {
      state.lastChecked = Date.now();
    }
  } catch (err) {
    console.warn(
      "[update-checker] Failed to check for updates:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    state.checking = false;
  }
}

export function setServiceMode(isService: boolean): void {
  state.isServiceMode = isService;
}

export function setUpdateInProgress(inProgress: boolean): void {
  state.updateInProgress = inProgress;
}

export function isUpdateAvailable(): boolean {
  if (!state.latestVersion) return false;
  return isNewerVersion(state.latestVersion, currentVersion);
}

/**
 * Parse a semver string into its components.
 * Handles versions like "1.2.3", "1.2.3-preview.20260228120000.abc1234"
 */
function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease: string[] } {
  const [corePart, ...prereleaseParts] = v.split("-");
  const prerelease = prereleaseParts.length > 0 ? prereleaseParts.join("-").split(".") : [];
  const parts = corePart.split(".").map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    prerelease,
  };
}

/**
 * Compare two semver prerelease identifier arrays.
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 * A version with no prerelease identifiers has higher precedence than one with.
 */
function comparePrereleaseArrays(a: string[], b: string[]): number {
  // No prerelease on both = equal
  if (a.length === 0 && b.length === 0) return 0;
  // No prerelease > has prerelease (stable is newer than prerelease of same core version)
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    // Fewer fields = lower precedence
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const aNum = Number(a[i]);
    const bNum = Number(b[i]);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);

    if (aIsNum && bIsNum) {
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
    } else if (aIsNum) {
      // Numeric identifiers have lower precedence than alphanumeric
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      // Both alphanumeric: compare lexically
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
  }
  return 0;
}

/**
 * Prerelease-aware semver comparison: returns true if a > b.
 * Handles both stable versions (1.2.3) and prerelease versions
 * (1.2.3-preview.20260228120000.abc1234).
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  // Compare major.minor.patch
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;

  // Core versions are equal — compare prerelease
  return comparePrereleaseArrays(pa.prerelease, pb.prerelease) > 0;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startPeriodicCheck(): void {
  // Initial check after a short delay
  setTimeout(() => {
    checkForUpdate();
  }, INITIAL_DELAY_MS);

  // Periodic checks
  intervalId = setInterval(() => {
    checkForUpdate();
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
