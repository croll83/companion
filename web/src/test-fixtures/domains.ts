import type { DomainSummary, DomainsResponse, PluginInfo, SkillGroupInfo } from "../api.js";

/**
 * Domains page fixtures shared by its component tests: GLOBAL and Herd, an
 * account server, a plugin and two skill groups, shaped like GET /domains.
 */

export const skillGroups: SkillGroupInfo[] = [
  { id: "user", label: "Your skills", description: "In ~/.claude/skills", skills: ["foundry-poc", "ton-audit"], descriptions: { "foundry-poc": "Write a Foundry PoC" }, codex: "linked" },
  { id: "claude-ai", label: "claude.ai skills", description: "Synced", skills: ["pdf"], descriptions: {}, codex: "unsupported" },
];

export const plugins: PluginInfo[] = [{
  id: "hercle-brain@hercle-lab",
  name: "hercle-brain",
  marketplace: "hercle-lab",
  version: "0.1.4",
  description: "Hercle AI Brain",
  skills: ["hercle-brain"],
  mcpServers: [{ name: "hercle-brain", type: "http", target: "http://127.0.0.1:7420/mcp" }],
  enabledByUser: false,
}];

const base = {
  createdAt: 0,
  mcp: {},
  chrome: false,
  chromeBrowser: "local",
  memoryNotes: 0,
  skills: [],
  ownSkills: [],
  mcpServers: [],
  pluginStates: {},
  skillStates: {},
  skillGroupStates: {},
};

export function globalDomain(over: Partial<DomainSummary> = {}): DomainSummary {
  return {
    ...base,
    slug: "global",
    name: "GLOBAL",
    path: "/home/u/companion_domain_global",
    sessionCount: 4,
    totalSessions: 5,
    mcpServers: [
      { name: "github", source: "account", enabled: true, own: false, type: "stdio", target: "npx gh", health: "connected" },
    ],
    pluginStates: { "hercle-brain@hercle-lab": { on: false, own: false } },
    skillGroupStates: { user: { on: true, own: false, onCount: 2 }, "claude-ai": { on: true, own: false, onCount: 1 } },
    skillStates: { "user:foundry-poc": { on: true, own: false }, "user:ton-audit": { on: true, own: false }, "claude-ai:pdf": { on: true, own: false } },
    ...over,
  };
}

export function herdDomain(over: Partial<DomainSummary> = {}): DomainSummary {
  return {
    ...base,
    slug: "herd",
    name: "Herd",
    description: "The herd project",
    path: "/home/u/companion_domain_herd",
    sessionCount: 2,
    totalSessions: 2,
    memoryNotes: 3,
    mcp: { github: false },
    mcpServers: [
      { name: "ping", source: "domain", enabled: true, own: false, type: "http", target: "http://ping/mcp" },
      { name: "noisy", source: "global", enabled: false, own: false, disabledGlobally: true, type: "stdio", target: "n" },
      { name: "github", source: "account", enabled: false, own: true, type: "stdio", target: "npx gh", health: "connected" },
      { name: "claude.ai Gmail", source: "account", enabled: true, own: false, type: "claude.ai", target: "https://gmail/mcp", health: "needs-auth" },
    ],
    pluginStates: { "hercle-brain@hercle-lab": { on: true, own: true } },
    ownSkills: [{ name: "herd-hello", description: "Say hello to the herd" }],
    skills: ["herd-hello"],
    skillGroupStates: { user: { on: true, own: false, onCount: 1 }, "claude-ai": { on: false, own: true, onCount: 0 } },
    skillStates: { "user:foundry-poc": { on: true, own: false }, "user:ton-audit": { on: false, own: true }, "claude-ai:pdf": { on: false, own: false } },
    ...over,
  };
}

export function domainsResponse(over: Partial<DomainsResponse> = {}): DomainsResponse {
  return {
    root: "/home/u",
    skillGroups,
    plugins,
    accountMcp: { at: Date.now() - 5 * 60_000, stale: false },
    domains: [globalDomain(), herdDomain()],
    ...over,
  };
}
