import type { BrainInfo } from "../api.js";

/**
 * Brains page fixtures shared by its component tests, shaped like GET
 * /brains: jarvis (no auth, on GLOBAL, with a colliding plugin), a team
 * brain with a bearer token, used by no domain, an OAuth brain (a
 * pre-registered client) whose skill comes from its server, and an embedded
 * brain run by Companion on a wiki folder.
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
    urls: { mcpUrl: "http://100.116.99.9:7421/mcp", healthUrl: "http://100.116.99.9:7421/healthz", apiUrl: "http://100.116.99.9:7421/api/v1", skillUrl: "http://100.116.99.9:7421/skill" },
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
    urls: { mcpUrl: "https://team.example/mcp", healthUrl: "https://team.example/healthz", apiUrl: "https://team.example/api/v1", skillUrl: "https://team.example/skill" },
    hasToken: true,
    serverName: "team-brain",
    tokenEnvVar: "COMPANION_BRAIN_TEAM_TOKEN",
    domains: [],
    collisions: [],
    ...over,
  };
}

export function oauthBrain(over: Partial<BrainInfo> = {}): BrainInfo {
  return {
    ...jarvisBrain(),
    slug: "hercle",
    name: "Hercle",
    about: "",
    remote: { baseUrl: "https://brain.example", auth: { mode: "oauth", clientId: "11111111-2222-3333-4444-555555555555", callbackPort: 8765 } },
    urls: { mcpUrl: "https://brain.example/mcp", healthUrl: "https://brain.example/healthz", apiUrl: "https://brain.example/api/v1", skillUrl: "https://brain.example/skill" },
    skill: { source: "server", server: { fetchedAt: Date.UTC(2026, 9, 13, 18, 0), etag: '"skill-a"', contentHash: null, serverVersion: "0.2.0", name: "hercle-brain" } },
    skillText: "---\nname: hercle-brain\ndescription: \"Use the knowledge base.\"\n---\n\n# Hercle brain\n\n<script>alert(1)</script>\n",
    serverName: "hercle-brain",
    tokenEnvVar: "COMPANION_BRAIN_HERCLE_TOKEN",
    domains: [{ slug: "work", name: "Work", own: true }],
    collisions: [],
    ...over,
  };
}

export function embeddedBrain(over: Partial<BrainInfo> = {}): BrainInfo {
  return {
    ...jarvisBrain(),
    slug: "work",
    name: "Work",
    kind: "embedded",
    about: "Team wiki",
    remote: undefined,
    embedded: { wikiDir: "/home/me/wiki", autostart: true, redactSecrets: true, language: "auto" },
    runtime: { state: "running", pid: 4242, port: 45999, startedAt: 0, crashes: 0 },
    urls: { mcpUrl: "http://127.0.0.1:3456/brains/work/mcp", healthUrl: "http://127.0.0.1:45999/healthz", apiUrl: "http://127.0.0.1:45999/api/v1", skillUrl: "http://127.0.0.1:45999/skill" },
    skill: { source: "server", server: { fetchedAt: 0, contentHash: "h1", name: "work-brain" } },
    serverName: "work-brain",
    tokenEnvVar: "COMPANION_BRAIN_WORK_TOKEN",
    domains: [],
    collisions: [],
    ...over,
  };
}
