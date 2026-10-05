import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * resolveSessionEnv layers the request env and the settings/Linear tokens on
 * top of the env profiles. Profile selection itself is tested in
 * env-manager.test.ts; here resolveEnvProfiles is stubbed.
 */

const mocks = vi.hoisted(() => ({
  resolveEnvProfiles: vi.fn(),
  getSettings: vi.fn(),
  getConnection: vi.fn(),
}));
vi.mock("./env-manager.js", () => ({ resolveEnvProfiles: mocks.resolveEnvProfiles }));
vi.mock("./settings-manager.js", () => ({ getSettings: mocks.getSettings }));
vi.mock("./linear-connections.js", () => ({ getConnection: mocks.getConnection }));

import { resolveSessionEnv } from "./session-env.js";

function profiles(list: { name: string; variables: Record<string, string> }[], missingExplicit = false) {
  const variables: Record<string, string> = {};
  for (const p of list) Object.assign(variables, p.variables);
  return { profiles: list, variables, missingExplicit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveEnvProfiles.mockReturnValue(profiles([]));
  mocks.getSettings.mockReturnValue({ claudeCodeOAuthToken: "", openaiApiKey: "" });
  mocks.getConnection.mockReturnValue(null);
});

describe("resolveSessionEnv", () => {
  // The cwd and the worktree repo root are both candidate paths for project
  // profiles, and the explicit slug is forwarded.
  it("asks for profiles matching the cwd and the repo root", () => {
    resolveSessionEnv({ cwd: "/wt/feat", repoRoot: "/repo", envSlug: "pick" });
    expect(mocks.resolveEnvProfiles).toHaveBeenCalledWith({ paths: ["/wt/feat", "/repo"], explicitSlug: "pick" });
  });

  // The request/agent env is the highest-precedence layer.
  it("puts the request env over the profiles and reports profile names only", () => {
    mocks.resolveEnvProfiles.mockReturnValue(profiles([
      { name: "Glob", variables: { A: "global", B: "global" } },
      { name: "Proj", variables: { B: "project" } },
    ]));
    const r = resolveSessionEnv({ cwd: "/repo", requestEnv: { A: "request" } });
    expect(r.env).toEqual({ A: "request", B: "project" });
    expect(r.profileNames).toEqual(["Glob", "Proj"]);
  });

  it("injects the Claude OAuth token from settings for Claude sessions only", () => {
    mocks.getSettings.mockReturnValue({ claudeCodeOAuthToken: "oauth", openaiApiKey: "sk" });
    expect(resolveSessionEnv({ cwd: "/x" }).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect(resolveSessionEnv({ cwd: "/x", backendType: "claude" }).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  });

  it("injects the OpenAI key from settings for Codex sessions only", () => {
    mocks.getSettings.mockReturnValue({ claudeCodeOAuthToken: "oauth", openaiApiKey: "sk" });
    expect(resolveSessionEnv({ cwd: "/x", backendType: "codex" }).env).toEqual({ OPENAI_API_KEY: "sk" });
  });

  // A token set by a profile or the request wins over the settings one.
  it("does not overwrite tokens already set by a profile or the request", () => {
    mocks.getSettings.mockReturnValue({ claudeCodeOAuthToken: "settings", openaiApiKey: "settings" });
    mocks.resolveEnvProfiles.mockReturnValue(profiles([{ name: "P", variables: { CLAUDE_CODE_OAUTH_TOKEN: "profile" } }]));
    expect(resolveSessionEnv({ cwd: "/x" }).env.CLAUDE_CODE_OAUTH_TOKEN).toBe("profile");
    expect(resolveSessionEnv({ cwd: "/x", backendType: "codex", requestEnv: { OPENAI_API_KEY: "req" } }).env.OPENAI_API_KEY).toBe("req");
  });

  it("sets LINEAR_API_KEY from the Linear connection, over everything else", () => {
    mocks.getConnection.mockReturnValue({ id: "c1", apiKey: "lin" });
    const r = resolveSessionEnv({ cwd: "/x", linearConnectionId: "c1", requestEnv: { LINEAR_API_KEY: "old" } });
    expect(mocks.getConnection).toHaveBeenCalledWith("c1");
    expect(r.env.LINEAR_API_KEY).toBe("lin");
  });

  it("ignores a Linear connection that no longer exists", () => {
    const r = resolveSessionEnv({ cwd: "/x", linearConnectionId: "gone" });
    expect(r.env).toEqual({});
  });

  it("warns when the explicit profile is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.resolveEnvProfiles.mockReturnValue(profiles([], true));
    resolveSessionEnv({ cwd: "/x", envSlug: "gone" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"gone" not found'));
    warn.mockRestore();
  });

  // Logs must name profiles and keys, never values.
  it("logs profile names and variable keys but no values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.resolveEnvProfiles.mockReturnValue(profiles([{ name: "Proj", variables: { API_KEY: "super-secret" } }]));
    resolveSessionEnv({ cwd: "/x" });
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('"Proj"');
    expect(line).toContain("API_KEY");
    expect(line).not.toContain("super-secret");
    log.mockRestore();
  });
});
