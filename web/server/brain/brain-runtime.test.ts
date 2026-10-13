import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Which brain a domain uses (own choice > GLOBAL's > none), the server
 * definitions each CLI gets (Claude: literal header; Codex: an env var
 * name), the token env, colliding plugins (by URL) and "Adopt plugin as
 * brain". Temp dirs only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { createDomain, ensureGlobalDomain, getDomain, updateDomain, type DomainInfo } from "../domain-store.js";
import { createRemoteBrain } from "./brain-store.js";
import {
  adoptPluginAsBrain,
  brainForDomain,
  brainTokenEnvVar,
  claudeBrainServer,
  codexBrainAgentsLine,
  codexBrainEnv,
  codexShellExcludeOverride,
  codexBrainServer,
  collidingPlugins,
} from "./brain-runtime.js";
import type { InstalledPlugin } from "../claude-plugins.js";
import { codexMcpTable } from "../domain-runtime.js";

let tmp: string;
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-runtime-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
  ensureGlobalDomain();
  createDomain({ name: "Herd" });
  createDomain({ name: "Ops" });
  createRemoteBrain({ name: "Jarvis", about: "Infra wiki", baseUrl: "http://100.116.99.9:7421" });
  createRemoteBrain({ name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "tok-123" });
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(slug: string) {
  const global = getDomain("global")!;
  const domain = slug === "global" ? global : getDomain(slug)!;
  return { domain, global, isGlobal: slug === "global" };
}

function plugin(id: string, url: string, enabledByUser = false): InstalledPlugin {
  return { id, name: id.split("@")[0], marketplace: "lab", installPath: "/p", skills: [], mcpServers: { s: { type: "http", url } }, enabledByUser };
}

describe("brainForDomain", () => {
  // Off by default: a new brain reaches no session.
  it("is none until a brain is assigned", () => {
    expect(brainForDomain(ctx("herd"))).toBeNull();
    expect(brainForDomain(ctx("global"))).toBeNull();
  });

  // Domain choice > GLOBAL's default > none; null opts out of GLOBAL's.
  it("applies domain > GLOBAL > none", () => {
    updateDomain("global", { brain: "jarvis" });
    updateDomain("ops", { brain: null });
    updateDomain("herd", { brain: "team" });
    expect(brainForDomain(ctx("global"))).toMatchObject({ serverName: "jarvis-brain", own: true });
    expect(brainForDomain(ctx("herd"))).toMatchObject({ serverName: "team-brain", own: true, token: "tok-123" });
    expect(brainForDomain(ctx("ops"))).toBeNull();
    updateDomain("ops", { brain: "inherit" });
    expect(brainForDomain(ctx("ops"))).toMatchObject({ serverName: "jarvis-brain", own: false, mcpUrl: "http://100.116.99.9:7421/mcp" });
  });

  // A brain that vanished (hand-edited registry) is skipped, never a crash.
  it("skips a brain that does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const domain = { ...getDomain("herd")!, brain: "gone" } as DomainInfo;
    expect(brainForDomain({ domain, global: getDomain("global")!, isGlobal: false })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // A bearer brain whose secret file was removed still connects (without a header), with a warning.
  it("warns when a bearer token is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rmSync(join(h.home, "brains", "team", "secret"));
    updateDomain("herd", { brain: "team" });
    const b = brainForDomain(ctx("herd"))!;
    expect(b.token).toBeUndefined();
    expect(claudeBrainServer(b)).toEqual({ type: "http", url: "https://team.example/mcp" });
    expect(codexBrainEnv(b)).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("server definitions", () => {
  // Parity: same server name and URL for both CLIs; Claude gets the literal
  // token (its per-session config is 0600), Codex only the env var name.
  it("gives Claude a literal header and Codex an env var reference", () => {
    updateDomain("herd", { brain: "team" });
    const b = brainForDomain(ctx("herd"))!;
    expect(claudeBrainServer(b)).toEqual({ type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer tok-123" } });
    expect(codexBrainServer(b)).toEqual({ type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer ${COMPANION_BRAIN_TEAM_TOKEN}" } });
    expect(JSON.stringify(codexBrainServer(b))).not.toContain("tok-123");
    expect(codexBrainEnv(b)).toEqual({ COMPANION_BRAIN_TEAM_TOKEN: "tok-123" });
    expect(codexBrainEnv(null)).toEqual({});
  });

  // OAuth (pre-registered client): Claude gets `oauth {clientId, callbackPort}`
  // in its --mcp-config, Codex the client id (codexMcpTable writes the
  // `[mcp_servers.<name>.oauth]` table); no token anywhere, no env.
  it("gives both CLIs the pre-registered OAuth client and no token", () => {
    createRemoteBrain({ name: "Entra", baseUrl: "https://brain.example", auth: { mode: "oauth", clientId: "app-123", callbackPort: 8765 } });
    updateDomain("herd", { brain: "entra" });
    const b = brainForDomain(ctx("herd"))!;
    expect(b).toMatchObject({ oauth: { clientId: "app-123", callbackPort: 8765 } });
    expect(b.token).toBeUndefined();
    expect(claudeBrainServer(b)).toEqual({ type: "http", url: "https://brain.example/mcp", oauth: { clientId: "app-123", callbackPort: 8765 } });
    expect(codexBrainServer(b)).toEqual({ type: "http", url: "https://brain.example/mcp", oauth: { clientId: "app-123" } });
    expect(codexMcpTable(b.serverName, codexBrainServer(b), "herd", { brain: "entra" })).toEqual([
      "# Managed by Companion: MCP server of domain herd (brain entra). Rewritten at every launch.",
      "[mcp_servers.entra-brain]",
      'url = "https://brain.example/mcp"',
      "",
      "[mcp_servers.entra-brain.oauth]",
      'client_id = "app-123"',
    ]);
    expect(codexBrainEnv(b)).toEqual({});
    createRemoteBrain({ name: "Entra2", baseUrl: "https://b2.example", auth: { mode: "oauth", clientId: "app-9" } });
    updateDomain("ops", { brain: "entra2" });
    expect(claudeBrainServer(brainForDomain(ctx("ops"))!)).toEqual({ type: "http", url: "https://b2.example/mcp", oauth: { clientId: "app-9" } });
  });

  it("names the token variable from the slug", () => {
    expect(brainTokenEnvVar("my-brain-2")).toBe("COMPANION_BRAIN_MY_BRAIN_2_TOKEN");
  });

  it("writes the AGENTS.md line Codex needs (it does not see MCP instructions)", () => {
    updateDomain("herd", { brain: "jarvis" });
    expect(codexBrainAgentsLine(brainForDomain(ctx("herd"))!)).toBe(
      "This domain's knowledge base is the brain Jarvis: use its `jarvis-brain` MCP tools; see the jarvis-brain skill.",
    );
  });
});

describe("collisions and adoption", () => {
  // By URL, not by name: Claude namespaces plugin tools, so names never clash.
  it("finds plugins serving the brain's MCP URL", () => {
    const plugins = [plugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp/"), plugin("other@lab", "http://other/mcp")];
    expect(collidingPlugins({ remote: { baseUrl: "http://100.116.99.9:7421", auth: { mode: "none" } } }, plugins).map((p) => p.id))
      .toEqual(["jarvis-brain@jarvis-lab"]);
  });

  // Where the plugin is on (own choice), the brain replaces it; elsewhere nothing changes.
  it("adopts in the domains where the plugin is on", () => {
    const p = plugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp");
    updateDomain("herd", { plugins: { [p.id]: true }, brain: "team" });
    expect(adoptPluginAsBrain("jarvis", p)).toEqual({ adoptedIn: ["herd"] });
    expect(getDomain("herd")).toMatchObject({ brain: "jarvis", plugins: { [p.id]: false } });
    expect(getDomain("ops")?.brain).toBeUndefined();
    expect(getDomain("global")?.brain).toBeUndefined();
  });

  // Plugin on for the user (so everywhere): GLOBAL and every domain adopt.
  // A domain that turned the plugin off keeps its brain, even though
  // GLOBAL's default brain changes under it.
  it("adopts on GLOBAL and pins the old brain where the plugin was off", () => {
    const p = plugin("jarvis-brain@jarvis-lab", "http://100.116.99.9:7421/mcp", true);
    updateDomain("ops", { plugins: { [p.id]: false } });
    expect(adoptPluginAsBrain("jarvis", p).adoptedIn).toEqual(["global", "herd"]);
    expect(getDomain("global")).toMatchObject({ brain: "jarvis", plugins: { [p.id]: false } });
    expect(getDomain("herd")).toMatchObject({ brain: "jarvis", plugins: { [p.id]: false } });
    // Ops had no brain (GLOBAL had none): it is pinned to none.
    expect(getDomain("ops")?.brain).toBeNull();
    expect(brainForDomain(ctx("ops"))).toBeNull();
  });
});

// Brain tokens reach Codex as env vars; the override keeps them out of the
// shell commands Codex runs, keeping the user's own excludes (a -c replaces
// the whole array).
describe("codexShellExcludeOverride", () => {
  it("adds the brain pattern alone when the config has no excludes", () => {
    expect(codexShellExcludeOverride("")).toBe('shell_environment_policy.exclude=["COMPANION_BRAIN_*"]');
    expect(codexShellExcludeOverride('model = "gpt"\n[shell_environment_policy]\ninherit = "all"\n')).toBe('shell_environment_policy.exclude=["COMPANION_BRAIN_*"]');
  });

  it("keeps the excludes already in the session's config, without duplicates", () => {
    const toml = [
      'model = "gpt"',
      "[shell_environment_policy]",
      "exclude = [\"AWS_*\", 'MY_SECRET', \"COMPANION_BRAIN_*\"]",
      "[mcp_servers.x]",
      'exclude = ["not-this-one"]',
    ].join("\n");
    expect(codexShellExcludeOverride(toml)).toBe('shell_environment_policy.exclude=["AWS_*", "MY_SECRET", "COMPANION_BRAIN_*"]');
  });
});
