import type { BrainInfo } from "../api.js";

/**
 * Brains page fixtures shared by its component tests, shaped like GET
 * /brains: jarvis (no auth, on GLOBAL, with a colliding plugin) and a team
 * brain with a bearer token, used by no domain.
 */

export function jarvisBrain(over: Partial<BrainInfo> = {}): BrainInfo {
  return {
    slug: "jarvis",
    name: "Jarvis",
    kind: "remote",
    createdAt: 0,
    about: "Marco's infrastructure wiki",
    remote: { baseUrl: "http://100.116.99.9:7421", auth: { mode: "none" } },
    skill: { source: "generated" },
    urls: { mcpUrl: "http://100.116.99.9:7421/mcp", healthUrl: "http://100.116.99.9:7421/healthz", apiUrl: "http://100.116.99.9:7421/api/v1" },
    hasToken: false,
    serverName: "jarvis-brain",
    tokenEnvVar: "COMPANION_BRAIN_JARVIS_TOKEN",
    skillText: "---\nname: jarvis-brain\ndescription: \"Marco's infrastructure wiki\"\n---\n\n# Jarvis brain\n",
    domains: [{ slug: "global", name: "GLOBAL", own: true }, { slug: "herd", name: "Herd", own: false }],
    collisions: [{ pluginId: "jarvis-brain@jarvis-lab", pluginName: "jarvis-brain", servers: ["jarvis-brain"], domains: ["herd"] }],
    ...over,
  };
}

export function teamBrain(over: Partial<BrainInfo> = {}): BrainInfo {
  return {
    ...jarvisBrain(),
    slug: "team",
    name: "Team",
    about: "",
    remote: { baseUrl: "https://team.example", auth: { mode: "bearer" } },
    urls: { mcpUrl: "https://team.example/mcp", healthUrl: "https://team.example/healthz", apiUrl: "https://team.example/api/v1" },
    hasToken: true,
    serverName: "team-brain",
    tokenEnvVar: "COMPANION_BRAIN_TEAM_TOKEN",
    domains: [],
    collisions: [],
    ...over,
  };
}
