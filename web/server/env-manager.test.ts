import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let envManager: typeof import("./env-manager.js");

const mockHomedir = vi.hoisted(() => {
  let dir = "";
  return {
    get: () => dir,
    set: (d: string) => {
      dir = d;
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomedir.get(),
  };
});

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "env-test-"));
  mockHomedir.set(tempDir);
  vi.resetModules();
  envManager = await import("./env-manager.js");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to get the envs directory path used by the module
// ---------------------------------------------------------------------------
function envsDir(): string {
  return join(tempDir, ".companion", "envs");
}

// ===========================================================================
// Slugification (tested indirectly via createEnv)
// ===========================================================================
describe("slugification via createEnv", () => {
  it("converts spaces to hyphens and lowercases", async () => {
    const env = envManager.createEnv("My App");
    expect(env.slug).toBe("my-app");
  });

  it("strips special characters", async () => {
    const env = envManager.createEnv("Hello World! @#$%");
    expect(env.slug).toBe("hello-world");
  });

  it("collapses consecutive hyphens", async () => {
    const env = envManager.createEnv("a   ---  b");
    expect(env.slug).toBe("a-b");
  });

  it("trims leading and trailing hyphens", async () => {
    const env = envManager.createEnv(" -cool env- ");
    expect(env.slug).toBe("cool-env");
  });

  it("throws when name is empty string", () => {
    expect(() => envManager.createEnv("")).toThrow("Environment name is required");
  });

  it("throws when name is only whitespace", () => {
    expect(() => envManager.createEnv("   ")).toThrow("Environment name is required");
  });

  it("throws when name contains no alphanumeric characters", () => {
    expect(() => envManager.createEnv("@#$%^&")).toThrow(
      "Environment name must contain alphanumeric characters",
    );
  });
});

// ===========================================================================
// listEnvs
// ===========================================================================
describe("listEnvs", () => {
  it("returns empty array when no envs exist", () => {
    const result = envManager.listEnvs();
    expect(result).toEqual([]);
  });

  it("returns envs sorted alphabetically by name", () => {
    envManager.createEnv("Zebra");
    envManager.createEnv("Alpha");
    envManager.createEnv("Mango");

    const result = envManager.listEnvs();
    expect(result.map((e) => e.name)).toEqual(["Alpha", "Mango", "Zebra"]);
  });

  it("skips corrupt JSON files", () => {
    // Create a valid env first
    envManager.createEnv("Valid");

    // Write a corrupt file directly into the envs directory
    writeFileSync(join(envsDir(), "corrupt.json"), "NOT VALID JSON{{{", "utf-8");

    const result = envManager.listEnvs();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Valid");
  });
});

// ===========================================================================
// getEnv
// ===========================================================================
describe("getEnv", () => {
  it("returns the env when it exists", () => {
    envManager.createEnv("My Service", { PORT: "3000" });

    const result = envManager.getEnv("my-service");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("My Service");
    expect(result!.slug).toBe("my-service");
    expect(result!.variables).toEqual({ PORT: "3000" });
  });

  it("returns null when the env does not exist", () => {
    const result = envManager.getEnv("nonexistent");
    expect(result).toBeNull();
  });
});

// ===========================================================================
// createEnv
// ===========================================================================
describe("createEnv", () => {
  it("returns an env with correct structure and timestamps", () => {
    const before = Date.now();
    const env = envManager.createEnv("Production", { NODE_ENV: "production" });
    const after = Date.now();

    expect(env.name).toBe("Production");
    expect(env.slug).toBe("production");
    expect(env.variables).toEqual({ NODE_ENV: "production" });
    expect(env.createdAt).toBeGreaterThanOrEqual(before);
    expect(env.createdAt).toBeLessThanOrEqual(after);
    expect(env.updatedAt).toBe(env.createdAt);
  });

  it("persists the env to disk as JSON", () => {
    envManager.createEnv("Disk Check");

    const raw = readFileSync(join(envsDir(), "disk-check.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("Disk Check");
    expect(parsed.slug).toBe("disk-check");
  });

  it("defaults variables to empty object", () => {
    const env = envManager.createEnv("No Vars");
    expect(env.variables).toEqual({});
  });

  it("throws when creating a duplicate slug", () => {
    envManager.createEnv("My App");
    expect(() => envManager.createEnv("My App")).toThrow(
      'An environment with a similar name already exists ("my-app")',
    );
  });

  it("trims the name before saving", () => {
    const env = envManager.createEnv("  Spaced Out  ");
    expect(env.name).toBe("Spaced Out");
    expect(env.slug).toBe("spaced-out");
  });
});

// ===========================================================================
// updateEnv
// ===========================================================================
describe("updateEnv", () => {
  it("updates name and variables", () => {
    envManager.createEnv("Original", { KEY: "old" });

    const updated = envManager.updateEnv("original", {
      name: "Renamed",
      variables: { KEY: "new" },
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Renamed");
    expect(updated!.slug).toBe("renamed");
    expect(updated!.variables).toEqual({ KEY: "new" });
  });

  it("renames the file on disk when slug changes", () => {
    envManager.createEnv("Old Name");

    envManager.updateEnv("old-name", { name: "New Name" });

    // Old file should be gone, new file should exist
    const oldPath = join(envsDir(), "old-name.json");
    const newPath = join(envsDir(), "new-name.json");

    expect(() => readFileSync(oldPath, "utf-8")).toThrow();
    const parsed = JSON.parse(readFileSync(newPath, "utf-8"));
    expect(parsed.name).toBe("New Name");
    expect(parsed.slug).toBe("new-name");
  });

  it("throws on slug collision during rename", () => {
    envManager.createEnv("Alpha");
    envManager.createEnv("Beta");

    expect(() => envManager.updateEnv("alpha", { name: "Beta" })).toThrow(
      'An environment with a similar name already exists ("beta")',
    );
  });

  it("returns null for a non-existent slug", () => {
    const result = envManager.updateEnv("ghost", { name: "New" });
    expect(result).toBeNull();
  });

  it("preserves createdAt and advances updatedAt", async () => {
    const env = envManager.createEnv("Timestamps");
    const originalCreatedAt = env.createdAt;

    // Small delay to ensure Date.now() advances
    await new Promise((r) => setTimeout(r, 10));

    const updated = envManager.updateEnv("timestamps", { variables: { A: "1" } });

    expect(updated).not.toBeNull();
    expect(updated!.createdAt).toBe(originalCreatedAt);
    expect(updated!.updatedAt).toBeGreaterThan(originalCreatedAt);
  });

  it("keeps existing variables when only name is updated", () => {
    envManager.createEnv("Keep Vars", { SECRET: "abc" });

    const updated = envManager.updateEnv("keep-vars", { name: "Kept Vars" });
    expect(updated!.variables).toEqual({ SECRET: "abc" });
  });
});

// ===========================================================================
// deleteEnv
// ===========================================================================
describe("deleteEnv", () => {
  it("deletes an existing env and returns true", () => {
    envManager.createEnv("To Delete");
    const result = envManager.deleteEnv("to-delete");
    expect(result).toBe(true);

    // Confirm it is gone
    expect(envManager.getEnv("to-delete")).toBeNull();
  });

  it("returns false when the env does not exist", () => {
    const result = envManager.deleteEnv("missing");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// Scopes (global / project folders / unassigned)
// ===========================================================================
describe("scopes", () => {
  // Without a scope a profile is "unassigned" (legacy shape), so old API
  // clients can never create a profile that silently applies everywhere.
  it("creates an unassigned profile when no scope is given", () => {
    const env = envManager.createEnv("Legacy", { A: "1" });
    expect(env.scope).toBeUndefined();
    expect(env.folders).toBeUndefined();
  });

  it("stores normalized, deduplicated folders for project profiles", () => {
    const env = envManager.createEnv("Proj", {}, { scope: "project", folders: ["/repo/", "/repo", " ", "/other"] });
    expect(env.scope).toBe("project");
    expect(env.folders).toEqual(["/repo", "/other"]);
  });

  it("drops folders from global profiles", () => {
    const env = envManager.createEnv("Glob", {}, { scope: "global", folders: ["/repo"] });
    expect(env.scope).toBe("global");
    expect(env.folders).toBeUndefined();
  });

  it("rejects a project profile without folders and an unknown scope", () => {
    expect(() => envManager.createEnv("P", {}, { scope: "project", folders: [] })).toThrow(/folder/);
    expect(() => envManager.createEnv("X", {}, { scope: "bogus" as never })).toThrow(/scope/);
  });

  // Assigning a legacy profile is the main use of scope updates.
  it("assigns an unassigned profile and keeps its variables", () => {
    envManager.createEnv("Jarvis", { J: "1" });
    const updated = envManager.updateEnv("jarvis", { scope: "project", folders: ["/home/me/jarvis"] });
    expect(updated).toMatchObject({ scope: "project", folders: ["/home/me/jarvis"], variables: { J: "1" } });
    expect(envManager.getEnv("jarvis")).toMatchObject({ scope: "project" });
  });

  it("keeps the stored scope when an update does not touch it", () => {
    envManager.createEnv("Proj", {}, { scope: "project", folders: ["/repo"] });
    const updated = envManager.updateEnv("proj", { variables: { A: "1" } });
    expect(updated).toMatchObject({ scope: "project", folders: ["/repo"] });
  });

  it("updates folders alone on a project profile and clears them when made global", () => {
    envManager.createEnv("Proj", {}, { scope: "project", folders: ["/repo"] });
    expect(envManager.updateEnv("proj", { folders: ["/a", "/b"] })!.folders).toEqual(["/a", "/b"]);
    const global = envManager.updateEnv("proj", { scope: "global" })!;
    expect(global.scope).toBe("global");
    expect(global.folders).toBeUndefined();
  });

  it("rejects switching to project scope without folders", () => {
    envManager.createEnv("Glob", {}, { scope: "global" });
    expect(() => envManager.updateEnv("glob", { scope: "project" })).toThrow(/folder/);
  });
});

// ===========================================================================
// File modes — profiles hold secrets
// ===========================================================================
describe("file modes", () => {
  it("writes profiles 0600 inside a 0700 directory", () => {
    envManager.createEnv("Secret", { K: "v" });
    expect(statSync(envsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(envsDir(), "secret.json")).mode & 0o777).toBe(0o600);
  });

  // Profiles written by older versions used the default umask; any write
  // must repair them (and the directory).
  it("fixes the modes of existing files on write", () => {
    mkdirSync(envsDir(), { recursive: true });
    chmodSync(envsDir(), 0o755);
    writeFileSync(join(envsDir(), "old.json"), JSON.stringify({ name: "Old", slug: "old", variables: {}, createdAt: 1, updatedAt: 1 }));
    chmodSync(join(envsDir(), "old.json"), 0o644);

    envManager.createEnv("New One");

    expect(statSync(envsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(envsDir(), "old.json")).mode & 0o777).toBe(0o600);

    // Updating the old profile in place keeps it 0600 too.
    chmodSync(join(envsDir(), "old.json"), 0o644);
    envManager.updateEnv("old", { variables: { A: "1" } });
    expect(statSync(join(envsDir(), "old.json")).mode & 0o777).toBe(0o600);
  });

  it("reading does not create the envs directory", () => {
    expect(envManager.listEnvs()).toEqual([]);
    expect(envManager.getEnv("nope")).toBeNull();
    expect(() => statSync(envsDir())).toThrow();
  });
});

// ===========================================================================
// resolveEnvProfiles — which profiles apply to a session, in which order
// ===========================================================================
describe("resolveEnvProfiles", () => {
  function names(r: { profiles: { name: string }[] }): string[] {
    return r.profiles.map((p) => p.name);
  }

  // Order is global, then project from least to most specific folder, then
  // the explicit profile; later profiles override earlier ones.
  it("orders global < project by specificity < explicit and merges accordingly", () => {
    envManager.createEnv("Deep", { V: "deep" }, { scope: "project", folders: ["/work/repo/pkg"] });
    envManager.createEnv("Glob", { V: "global", G: "1" }, { scope: "global" });
    envManager.createEnv("Shallow", { V: "shallow" }, { scope: "project", folders: ["/work"] });
    envManager.createEnv("Mid", { V: "mid" }, { scope: "project", folders: ["/work/repo"] });
    envManager.createEnv("Pick", { P: "1" });

    const r = envManager.resolveEnvProfiles({ paths: ["/work/repo/pkg/src"], explicitSlug: "pick" });
    expect(names(r)).toEqual(["Glob", "Shallow", "Mid", "Deep", "Pick"]);
    expect(r.variables).toEqual({ V: "deep", G: "1", P: "1" });
    expect(r.missingExplicit).toBe(false);
  });

  it("lets the explicit profile override every automatic one", () => {
    envManager.createEnv("Glob", { V: "global" }, { scope: "global" });
    envManager.createEnv("Proj", { V: "project" }, { scope: "project", folders: ["/repo"] });
    envManager.createEnv("Pick", { V: "explicit" });
    expect(envManager.resolveEnvProfiles({ paths: ["/repo"], explicitSlug: "pick" }).variables.V).toBe("explicit");
  });

  // A profile both automatic and explicit is applied once, at the explicit
  // (highest) position.
  it("does not apply an explicitly chosen automatic profile twice", () => {
    envManager.createEnv("Glob", { V: "global" }, { scope: "global" });
    envManager.createEnv("Proj", { V: "project" }, { scope: "project", folders: ["/repo"] });
    const r = envManager.resolveEnvProfiles({ paths: ["/repo"], explicitSlug: "glob" });
    expect(names(r)).toEqual(["Proj", "Glob"]);
    expect(r.variables.V).toBe("global");
  });

  it("never applies unassigned profiles automatically", () => {
    envManager.createEnv("Legacy", { L: "1" });
    const r = envManager.resolveEnvProfiles({ paths: ["/anywhere"] });
    expect(r.profiles).toEqual([]);
    expect(r.variables).toEqual({});
  });

  // Folder matching is by path segment: /repo must not match /repository.
  it("matches only the folder itself and its subfolders", () => {
    envManager.createEnv("Proj", { P: "1" }, { scope: "project", folders: ["/repo"] });
    expect(names(envManager.resolveEnvProfiles({ paths: ["/repo"] }))).toEqual(["Proj"]);
    expect(names(envManager.resolveEnvProfiles({ paths: ["/repo/a/b"] }))).toEqual(["Proj"]);
    expect(names(envManager.resolveEnvProfiles({ paths: ["/repository"] }))).toEqual([]);
    expect(names(envManager.resolveEnvProfiles({ paths: ["/"] }))).toEqual([]);
  });

  // A profile with several folders ranks by its deepest matching folder; any
  // of the session paths (cwd, worktree repo root) can match.
  it("ranks multi-folder profiles by their deepest match and accepts any session path", () => {
    envManager.createEnv("Multi", { V: "multi" }, { scope: "project", folders: ["/a", "/work/repo/pkg"] });
    envManager.createEnv("Mid", { V: "mid" }, { scope: "project", folders: ["/work/repo"] });
    const r = envManager.resolveEnvProfiles({ paths: ["/wt/feat", "/work/repo/pkg"] });
    expect(names(r)).toEqual(["Mid", "Multi"]);
  });

  it("reports a missing explicit profile", () => {
    const r = envManager.resolveEnvProfiles({ paths: ["/x"], explicitSlug: "gone" });
    expect(r.missingExplicit).toBe(true);
    expect(r.profiles).toEqual([]);
  });
});
