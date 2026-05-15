import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock settings-manager to control updateChannel
const mockGetSettings = vi.fn(() => ({
  updateChannel: "stable" as "stable" | "prerelease",
}));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => mockGetSettings(),
}));

let checker: typeof import("./update-checker.js");

// Helper: build a minimal GitHub Release object that satisfies the updater.
function release(opts: {
  tag: string;
  prerelease?: boolean;
  draft?: boolean;
  name?: string | null;
}): {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  published_at: string;
} {
  return {
    tag_name: opts.tag,
    name: opts.name ?? opts.tag,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    published_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  vi.resetModules();
  mockFetch.mockReset();
  mockGetSettings.mockReturnValue({ updateChannel: "stable" });
  checker = await import("./update-checker.js");
});

afterEach(() => {
  checker.stopPeriodicCheck();
});

// ===========================================================================
// parseVersionFromTag — extracts the semver portion of release-please tags
// ===========================================================================
describe("parseVersionFromTag", () => {
  it("parses stable version tag", () => {
    // release-please prefixes the npm package name to disambiguate when there
    // are multiple release lines in a monorepo.
    expect(checker.parseVersionFromTag("the-companion-v1.2.3")).toBe("1.2.3");
  });

  it("parses prerelease/preview version tag", () => {
    expect(
      checker.parseVersionFromTag("the-companion-v1.2.3-preview.123"),
    ).toBe("1.2.3-preview.123");
  });

  it("parses preview tag with timestamp + sha", () => {
    expect(
      checker.parseVersionFromTag(
        "the-companion-v0.66.0-preview.20260228140000.abc1234",
      ),
    ).toBe("0.66.0-preview.20260228140000.abc1234");
  });

  it("returns null for tags without the package prefix", () => {
    // Plain "v1.2.3" tags (created manually or by other tools) should not be
    // confused for releases of this package.
    expect(checker.parseVersionFromTag("v1.2.3")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(checker.parseVersionFromTag("")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(checker.parseVersionFromTag(null)).toBeNull();
    expect(checker.parseVersionFromTag(undefined)).toBeNull();
  });

  it("returns null for tags missing the v prefix", () => {
    expect(checker.parseVersionFromTag("the-companion-1.2.3")).toBeNull();
  });
});

// ===========================================================================
// isNewerVersion — stable versions
// ===========================================================================
describe("isNewerVersion", () => {
  it("returns true when major version is higher", () => {
    expect(checker.isNewerVersion("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns true when minor version is higher", () => {
    expect(checker.isNewerVersion("1.1.0", "1.0.0")).toBe(true);
  });

  it("returns true when patch version is higher", () => {
    expect(checker.isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when version is lower", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.1")).toBe(false);
    expect(checker.isNewerVersion("0.9.0", "1.0.0")).toBe(false);
  });
});

// ===========================================================================
// isNewerVersion — prerelease versions
// ===========================================================================
describe("isNewerVersion (prerelease)", () => {
  // Stable release is newer than prerelease of the same core version
  it("stable is newer than prerelease of same core version", () => {
    expect(checker.isNewerVersion("1.0.0", "1.0.0-preview.1")).toBe(true);
  });

  // Prerelease is older than stable of the same core version
  it("prerelease is older than stable of same core version", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0")).toBe(false);
  });

  // Higher core version prerelease is newer than lower core stable
  it("higher core prerelease is newer than lower core stable", () => {
    expect(checker.isNewerVersion("1.1.0-preview.1", "1.0.0")).toBe(true);
  });

  // Later prerelease of same core is newer
  it("later prerelease of same core is newer", () => {
    expect(checker.isNewerVersion("1.0.0-preview.2", "1.0.0-preview.1")).toBe(true);
  });

  // Earlier prerelease of same core is older
  it("earlier prerelease of same core is older", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0-preview.2")).toBe(false);
  });

  // Handles timestamp-based prerelease identifiers
  it("compares timestamp-based prerelease identifiers correctly", () => {
    expect(checker.isNewerVersion(
      "0.66.0-preview.20260228140000.abc1234",
      "0.66.0-preview.20260228120000.def5678",
    )).toBe(true);
  });

  // Equal prerelease versions
  it("returns false for equal prerelease versions", () => {
    expect(checker.isNewerVersion("1.0.0-preview.1", "1.0.0-preview.1")).toBe(false);
  });

  // Alphanumeric prerelease identifiers compared lexically
  it("compares alphanumeric prerelease identifiers lexically", () => {
    expect(checker.isNewerVersion("1.0.0-beta.1", "1.0.0-alpha.1")).toBe(true);
    expect(checker.isNewerVersion("1.0.0-alpha.1", "1.0.0-beta.1")).toBe(false);
  });
});

// ===========================================================================
// Prerelease update-channel regression tests (THE-216)
//
// The preview workflow publishes versions with a patch-core bump so that
// prerelease builds are always semver-ahead of the current stable line.
// These tests lock in the intended behavior to prevent regressions.
// ===========================================================================
describe("isNewerVersion — prerelease channel regressions (THE-216)", () => {
  // A same-core prerelease (the old, broken format) must NOT be considered
  // newer than the stable release it was derived from.
  it("same-core prerelease is NOT newer than stable (old broken format)", () => {
    // e.g. stable 0.68.0, preview publishes 0.68.0-preview.20260301120000.abc1234
    expect(checker.isNewerVersion("0.68.0-preview.20260301120000.abc1234", "0.68.0")).toBe(false);
  });

  // A patch-bumped prerelease (the fixed format) IS newer than the stable
  // release it was derived from.
  it("patch-bumped prerelease IS newer than stable (fixed format)", () => {
    // e.g. stable 0.68.0, preview publishes 0.68.1-preview.20260301120000.abc1234
    expect(checker.isNewerVersion("0.68.1-preview.20260301120000.abc1234", "0.68.0")).toBe(true);
  });

  // Successive preview builds (same core, increasing timestamps) stay
  // monotonically ordered.
  it("later timestamp preview is newer than earlier timestamp preview", () => {
    expect(checker.isNewerVersion(
      "0.68.1-preview.20260301140000.abc1234",
      "0.68.1-preview.20260301120000.def5678",
    )).toBe(true);
  });

  // After a new stable release that matches or exceeds the preview core,
  // the old preview is no longer considered newer.
  it("stable release at preview core supersedes the preview", () => {
    // When 0.68.1 stable is released, the preview 0.68.1-preview.* is older
    expect(checker.isNewerVersion("0.68.1-preview.20260301120000.abc1234", "0.68.1")).toBe(false);
  });

  // A new stable that leapfrogs past the preview core is newer.
  it("higher stable is newer than older-core preview", () => {
    expect(checker.isNewerVersion("0.69.0", "0.68.1-preview.20260301120000.abc1234")).toBe(true);
  });
});

// ===========================================================================
// getCurrentVersion
// ===========================================================================
describe("getCurrentVersion", () => {
  it("returns a semver string", () => {
    const version = checker.getCurrentVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ===========================================================================
// getUpdateState
// ===========================================================================
describe("getUpdateState", () => {
  it("returns initial state with current version and no latest version", () => {
    const state = checker.getUpdateState();
    expect(state.currentVersion).toBe(checker.getCurrentVersion());
    expect(state.latestVersion).toBeNull();
    expect(state.isServiceMode).toBe(false);
    expect(state.checking).toBe(false);
    expect(state.updateInProgress).toBe(false);
    expect(state.channel).toBe("stable");
  });
});

// ===========================================================================
// checkForUpdate
//
// The updater reads from the fork's GitHub Releases API rather than npm,
// because the fork cannot publish to the `the-companion` npm package (it
// belongs to the upstream project). We verify the request shape, channel
// selection (stable vs prerelease), and graceful handling of failures.
// ===========================================================================
describe("checkForUpdate", () => {
  it("fetches from the fork's GitHub releases endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([release({ tag: "the-companion-v99.0.0" })]),
    });

    await checker.checkForUpdate();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toMatch(
      /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\?per_page=20$/,
    );
    // GitHub API requires a User-Agent header and the vendor-specific Accept.
    expect(call[1].headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "User-Agent": expect.stringContaining("the-companion"),
    });

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBe("99.0.0");
    expect(state.lastChecked).toBeGreaterThan(0);
    expect(state.channel).toBe("stable");
  });

  // The stable channel must skip prerelease entries even if they appear first
  // in the releases array (GitHub orders by creation time, not stability).
  it("picks the latest non-prerelease release for the stable channel", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        release({ tag: "the-companion-v99.1.0-preview.1", prerelease: true }),
        release({ tag: "the-companion-v99.0.0" }),
        release({ tag: "the-companion-v98.0.0" }),
      ]),
    });

    await checker.checkForUpdate();
    expect(checker.getUpdateState().latestVersion).toBe("99.0.0");
  });

  it("picks the latest prerelease for the prerelease channel", async () => {
    mockGetSettings.mockReturnValue({ updateChannel: "prerelease" });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        release({ tag: "the-companion-v99.1.0-preview.2", prerelease: true }),
        release({ tag: "the-companion-v99.0.0" }),
        release({ tag: "the-companion-v99.1.0-preview.1", prerelease: true }),
      ]),
    });

    await checker.checkForUpdate();
    const state = checker.getUpdateState();
    expect(state.latestVersion).toBe("99.1.0-preview.2");
    expect(state.channel).toBe("prerelease");
  });

  // Draft releases are not yet published to the public — even if they match
  // the channel they must be skipped so users never get a half-baked update.
  it("skips draft releases", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        release({ tag: "the-companion-v99.2.0", draft: true }),
        release({ tag: "the-companion-v99.0.0" }),
      ]),
    });

    await checker.checkForUpdate();
    expect(checker.getUpdateState().latestVersion).toBe("99.0.0");
  });

  // Tags created by other tools (e.g. plain "v1.2.3", or arbitrary names)
  // should be ignored so the updater never picks an unrelated tag.
  it("skips releases whose tag does not match the the-companion-vX.Y.Z format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        release({ tag: "v99.5.0" }),
        release({ tag: "random-tag" }),
        release({ tag: "the-companion-v99.0.0" }),
      ]),
    });

    await checker.checkForUpdate();
    expect(checker.getUpdateState().latestVersion).toBe("99.0.0");
  });

  // When switching channels, the previous channel's latestVersion must be
  // cleared to avoid cross-channel stale comparisons.
  it("clears latestVersion when channel changes to avoid stale comparison", async () => {
    // First check on stable channel sets a latestVersion
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([release({ tag: "the-companion-v99.0.0" })]),
    });
    await checker.checkForUpdate();
    expect(checker.getUpdateState().latestVersion).toBe("99.0.0");

    // Switch to prerelease but fetch fails
    mockGetSettings.mockReturnValue({ updateChannel: "prerelease" });
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await checker.checkForUpdate();

    // latestVersion should be null (not the stale stable version)
    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
    expect(state.channel).toBe("prerelease");
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
  });

  it("handles non-ok response gracefully", async () => {
    // Simulates a GitHub rate-limit response. We must not crash, and we must
    // not set a latestVersion.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
  });

  it("handles non-array response payload gracefully", async () => {
    // Defensive: if GitHub ever returns an error envelope instead of an array,
    // the updater must not blow up.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ message: "Bad credentials" }),
    });

    await checker.checkForUpdate();

    const state = checker.getUpdateState();
    expect(state.latestVersion).toBeNull();
  });
});

// ===========================================================================
// isUpdateAvailable
// ===========================================================================
describe("isUpdateAvailable", () => {
  it("returns false when no latest version is set", () => {
    expect(checker.isUpdateAvailable()).toBe(false);
  });

  it("returns true when latest is newer than current", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([release({ tag: "the-companion-v99.0.0" })]),
    });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(true);
  });

  it("returns false when latest equals current", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        release({ tag: `the-companion-v${checker.getCurrentVersion()}` }),
      ]),
    });

    await checker.checkForUpdate();
    expect(checker.isUpdateAvailable()).toBe(false);
  });
});

// ===========================================================================
// setServiceMode / setUpdateInProgress
// ===========================================================================
describe("state setters", () => {
  it("setServiceMode updates isServiceMode", () => {
    checker.setServiceMode(true);
    expect(checker.getUpdateState().isServiceMode).toBe(true);
    checker.setServiceMode(false);
    expect(checker.getUpdateState().isServiceMode).toBe(false);
  });

  it("setUpdateInProgress updates updateInProgress", () => {
    checker.setUpdateInProgress(true);
    expect(checker.getUpdateState().updateInProgress).toBe(true);
    checker.setUpdateInProgress(false);
    expect(checker.getUpdateState().updateInProgress).toBe(false);
  });
});
