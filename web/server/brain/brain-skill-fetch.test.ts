import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Skill from the server" against a fake brain: a node http server on an
 * ephemeral 127.0.0.1 port (never PORT from env, never the network) that
 * serves `/skill` the way jarvis-brain and hercle-brain do. It checks the
 * contract (skill_api, frontmatter), the fallbacks (404, invalid, oversize,
 * unreachable), ETag/304 reuse, the refetch on a new wiki version, which auth
 * goes along (bearer to its own origin only, nothing for OAuth), and that the
 * token never reaches a log line or an error text.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { brainDir, brainSkillDir, brainSkillMarkdown, createRemoteBrain, getBrain, updateBrain, type BrainConfig } from "./brain-store.js";
import {
  MAX_SKILL_BYTES,
  fetchServerSkill,
  installedSkillText,
  refreshBrainSkill,
  refreshSkillOnNewContent,
  validateServerSkill,
  type ServerSkillDoc,
} from "./brain-skill-fetch.js";

const TOKEN = "tok-never-logged-123";
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handler: Handler;
const seen: { url?: string; auth?: string; inm?: string }[] = [];
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "brain-skill-"));
  h.home = join(tmp, "companion");
  seen.length = 0;
  server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, inm: req.headers["if-none-match"] as string | undefined });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function brain(over: Record<string, unknown> = {}): BrainConfig {
  const r = createRemoteBrain({ name: "Lab", baseUrl: base, ...over });
  if (!r.ok) throw new Error(r.error);
  return r.brain;
}

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill_api: 1,
    name: "jarvis-brain",
    description: "Use the lab wiki for hosts and ports.",
    skill_md: "---\nname: jarvis-brain\ndescription: Use the lab wiki for hosts and ports.\n---\n\n# Lab brain\n\nSearch, then read.\n",
    server_version: "0.2.0",
    content_hash: "hash-1",
    tools: ["brain_search"],
    ...over,
  };
}

/** Serve one JSON skill with an ETag, honouring If-None-Match like the brain servers. */
function serveSkill(body: Record<string, unknown>, etag = '"skill-a"') {
  handler = (req, res) => {
    if (req.url !== "/skill") { res.statusCode = 404; res.end(); return; }
    res.setHeader("etag", etag);
    if (req.headers["if-none-match"] === etag) { res.statusCode = 304; res.end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

describe("validateServerSkill", () => {
  // The contract both brain servers implement; anything else is refused with a reason.
  it.each([
    [null, "not a JSON object"],
    [doc({ skill_api: 2 }), "unsupported skill_api 2"],
    [doc({ name: "Bad Name" }), "lowercase skill name"],
    [doc({ description: "" }), "description is missing"],
    [doc({ description: "two\nlines" }), "one line"],
    [doc({ description: "x".repeat(1001) }), "one line"],
    [doc({ skill_md: "" }), "skill_md is missing"],
    [doc({ skill_md: "# no frontmatter" }), "no frontmatter"],
    [doc({ skill_md: "---\ndescription: d\n---\nbody" }), "has no name"],
    [doc({ skill_md: "---\nname: n\n---\nbody" }), "has no description"],
    [doc({ skill_md: "---\nname: n\ndescription: d\n---\n  \n" }), "no body"],
    [doc({ content_hash: 5 }), "content_hash"],
    [doc({ tools: [1] }), "tools"],
  ])("refuses %#", (value, error) => {
    expect(validateServerSkill(value)).toContain(error);
  });

  it("accepts the contract and keeps only known fields", () => {
    const v = validateServerSkill({ ...doc({ content_hash: null }), extra: "x" });
    expect(v).toMatchObject({ skill_api: 1, name: "jarvis-brain", content_hash: null, tools: ["brain_search"] });
    expect(v).not.toHaveProperty("extra");
  });
});

describe("installedSkillText", () => {
  // Companion's skill is always `<slug>-brain` (the folder and MCP server
  // name); the description is the validated one-line JSON field.
  it("renames the skill and rebuilds the frontmatter", () => {
    const v = validateServerSkill(doc({ description: 'Says "hi": ok' })) as ServerSkillDoc;
    const text = installedSkillText(v, "jarvis2");
    expect(text).toBe('---\nname: jarvis2-brain\ndescription: "Says \\"hi\\": ok"\n---\n\n# Lab brain\n\nSearch, then read.\n');
  });
});

describe("fetchServerSkill", () => {
  it("fetches and validates the skill", async () => {
    serveSkill(doc());
    const r = await fetchServerSkill(brain());
    expect(r).toMatchObject({ kind: "fetched", etag: '"skill-a"', doc: { name: "jarvis-brain", content_hash: "hash-1" } });
    expect(seen[0]).toMatchObject({ url: "/skill", auth: undefined });
  });

  it("reports a missing endpoint, an HTTP error and a non-JSON answer", async () => {
    handler = (_req, res) => { res.statusCode = 404; res.end("no"); };
    expect(await fetchServerSkill(brain())).toMatchObject({ kind: "failed", reason: "missing", status: 404 });
    handler = (_req, res) => { res.statusCode = 500; res.end(); };
    expect(await fetchServerSkill(getBrain("lab")!)).toMatchObject({ kind: "failed", reason: "http", status: 500 });
    handler = (_req, res) => { res.end("<html>"); };
    expect(await fetchServerSkill(getBrain("lab")!)).toMatchObject({ kind: "failed", reason: "invalid", error: expect.stringContaining("not JSON") });
  });

  // 64 KB cap, whether the size is announced or the body is streamed.
  it("refuses an oversize skill", async () => {
    serveSkill(doc({ skill_md: `---\nname: x\ndescription: d\n---\n${"x".repeat(MAX_SKILL_BYTES)}` }));
    expect(await fetchServerSkill(brain())).toMatchObject({ kind: "failed", reason: "too-large" });
    handler = (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write("{\"pad\":\"");
      res.write("y".repeat(MAX_SKILL_BYTES));
      res.end("\"}");
    };
    expect(await fetchServerSkill(getBrain("lab")!)).toMatchObject({ kind: "failed", reason: "too-large" });
  });

  it("reports a timeout and a refused connection", async () => {
    handler = () => { /* never answers */ };
    expect(await fetchServerSkill(brain(), { timeoutMs: 100 })).toMatchObject({ kind: "failed", reason: "unreachable", error: expect.stringMatching(/no answer within/i) });
    const r = await fetchServerSkill({ ...getBrain("lab")!, remote: { baseUrl: "http://127.0.0.1:1", auth: { mode: "none" } } });
    expect(r).toMatchObject({ kind: "failed", reason: "unreachable" });
  });

  // Bearer: the token goes to the MCP server's own origin only. OAuth: no
  // header at all (the endpoint is public, Companion holds no OAuth token).
  it("sends the bearer token to its own origin only, and nothing for OAuth", async () => {
    serveSkill(doc());
    await fetchServerSkill(brain({ auth: { mode: "bearer" }, token: TOKEN }));
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    updateBrain("lab", { mcpUrl: "http://elsewhere.example/mcp" });
    await fetchServerSkill(getBrain("lab")!);
    expect(seen[1].auth).toBeUndefined();
    updateBrain("lab", { mcpUrl: null, auth: { mode: "oauth", clientId: "app-1" } });
    await fetchServerSkill(getBrain("lab")!);
    expect(seen[2].auth).toBeUndefined();
  });
});

describe("refreshBrainSkill", () => {
  it("stores the server's skill as the brain's skill", async () => {
    serveSkill(doc());
    brain();
    const r = await refreshBrainSkill("lab");
    expect(r.outcome).toBe("updated");
    const b = getBrain("lab")!;
    expect(b.skill).toMatchObject({ source: "server", server: { etag: '"skill-a"', contentHash: "hash-1", serverVersion: "0.2.0", name: "jarvis-brain" } });
    expect(b.skill.note).toBeUndefined();
    const written = readFileSync(join(brainSkillDir("lab"), "SKILL.md"), "utf-8");
    expect(written).toMatch(/^---\nname: lab-brain\ndescription: "Use the lab wiki for hosts and ports."\n---\n\n# Lab brain/);
    expect(brainSkillMarkdown(b)).toBe(written);
  });

  // A 404 (no /skill) on a new brain: the generated skill, with a note saying why.
  it("falls back to the generated skill with a note when the endpoint is missing", async () => {
    handler = (_req, res) => { res.statusCode = 404; res.end(); };
    brain({ about: "Lab wiki" });
    const r = await refreshBrainSkill("lab");
    expect(r.outcome).toBe("failed");
    const b = getBrain("lab")!;
    expect(b.skill.source).toBe("generated");
    expect(b.skill.note).toMatch(/does not publish a skill.*using the generated skill/);
    expect(readFileSync(join(brainSkillDir("lab"), "SKILL.md"), "utf-8")).toContain('description: "Lab wiki"');
  });

  it("keeps a custom skill when the server's cannot be used", async () => {
    serveSkill(doc({ skill_api: 9 }));
    brain({ skill: { source: "custom", custom: "Mine" } });
    await refreshBrainSkill("lab");
    expect(getBrain("lab")!.skill).toMatchObject({ source: "custom", custom: "Mine", note: expect.stringContaining("unsupported skill_api 9") });
  });

  // ETag reuse: the second refresh sends If-None-Match and a 304 keeps the
  // stored skill; a failed refresh keeps it too, with a note.
  it("reuses the ETag and keeps the last good skill when a refresh fails", async () => {
    serveSkill(doc());
    brain();
    await refreshBrainSkill("lab");
    const r = await refreshBrainSkill("lab");
    expect(r.outcome).toBe("unchanged");
    expect(seen[1].inm).toBe('"skill-a"');
    expect(getBrain("lab")!.skill).toMatchObject({ source: "server", server: { contentHash: "hash-1" } });
    handler = (_req, res) => { res.statusCode = 503; res.end(); };
    await refreshBrainSkill("lab");
    expect(getBrain("lab")!.skill).toMatchObject({ source: "server", note: expect.stringContaining("the last fetched skill stays in use") });
    expect(brainSkillMarkdown(getBrain("lab")!)).toContain("# Lab brain");
  });

  // Without a stored copy a 304 cannot be honoured: no If-None-Match is sent then.
  it("fetches unconditionally when nothing is stored, or when asked to", async () => {
    serveSkill(doc());
    brain();
    await refreshBrainSkill("lab");
    rmSync(join(brainDir("lab"), "server-skill.md"));
    await refreshBrainSkill("lab");
    expect(seen[1].inm).toBeUndefined();
    await refreshBrainSkill("lab", { conditional: false });
    expect(seen[2].inm).toBeUndefined();
  });

  it("reports an unknown brain", async () => {
    expect(await refreshBrainSkill("nope")).toEqual({ outcome: "failed", error: "Brain not found" });
  });

  // The token must never reach a log line, an error text or the stored note.
  it("never logs the bearer token", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    brain({ auth: { mode: "bearer" }, token: TOKEN });
    for (const answer of [404, 500, 200]) {
      handler = (_req, res) => { res.statusCode = answer; res.end(answer === 200 ? "not json" : ""); };
      const r = await refreshBrainSkill("lab");
      expect(r.error ?? "").not.toContain(TOKEN);
    }
    expect(JSON.stringify(getBrain("lab"))).not.toContain(TOKEN);
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
  });
});

describe("refreshSkillOnNewContent", () => {
  // The health check reports another wiki version: the skill is fetched
  // again; a 304 just records the new version.
  it("refetches a server skill when the wiki version changes", async () => {
    serveSkill(doc());
    brain();
    await refreshBrainSkill("lab");
    expect(await refreshSkillOnNewContent(getBrain("lab")!, "hash-1")).toBeNull();
    expect(await refreshSkillOnNewContent(getBrain("lab")!, undefined)).toBeNull();

    const r304 = await refreshSkillOnNewContent(getBrain("lab")!, "hash-2");
    expect(r304?.outcome).toBe("unchanged");
    expect(getBrain("lab")!.skill.server?.contentHash).toBe("hash-2");

    serveSkill(doc({ content_hash: "hash-3", skill_md: "---\nname: x\ndescription: d\n---\n\n# New topics\n" }), '"skill-b"');
    const r = await refreshSkillOnNewContent(getBrain("lab")!, "hash-3");
    expect(r?.outcome).toBe("updated");
    expect(getBrain("lab")!.skill.server).toMatchObject({ contentHash: "hash-3", etag: '"skill-b"' });
    expect(brainSkillMarkdown(getBrain("lab")!)).toContain("# New topics");
  });

  // Only "server" skills that depend on the wiki (content_hash not null) are refetched.
  it("does nothing for other skills or a wiki-independent server skill", async () => {
    serveSkill(doc({ content_hash: null }));
    brain();
    expect(await refreshSkillOnNewContent(getBrain("lab")!, "h")).toBeNull();
    await refreshBrainSkill("lab");
    expect(await refreshSkillOnNewContent(getBrain("lab")!, "h")).toBeNull();
    expect(seen).toHaveLength(1);
    expect(existsSync(join(brainDir("lab"), "server-skill.md"))).toBe(true);
  });
});
