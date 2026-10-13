import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Brain configs under COMPANION_HOME/brains/<slug>/: brain.json, the 0600
 * token file, and the generated plugin (plugin.json + SKILL.md). Also the
 * URL rules (base URL → /mcp, /healthz, /api/v1) and deletion clearing the
 * brain from every domain. Temp dirs only: never the real ~/.companion.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import {
  applyServerSkill,
  brainDir,
  brainPluginDir,
  brainSkillDir,
  brainSkillMarkdown,
  brainUrls,
  brainDataDir,
  brainLogPath,
  checkWikiDir,
  createEmbeddedBrain,
  createRemoteBrain,
  deleteBrain,
  ensureBrainPlugin,
  getBrain,
  hasBrainToken,
  listBrains,
  normalizeHttpUrl,
  readBrainToken,
  readServerSkill,
  sameUrl,
  updateBrain,
  type BrainConfig,
} from "./brain-store.js";
import { createDomain, ensureGlobalDomain, getDomain, updateDomain } from "../domain-store.js";

let tmp: string;
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-store-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function created(input: Parameters<typeof createRemoteBrain>[0]): BrainConfig {
  const r = createRemoteBrain(input);
  if (!r.ok) throw new Error(r.error);
  return r.brain;
}

describe("URLs", () => {
  // Only http(s) URLs are accepted, without the trailing slash, so derived
  // URLs never get a double "//".
  it("normalizes http(s) URLs and rejects anything else", () => {
    expect(normalizeHttpUrl(" http://100.116.99.9:7421/ ")).toBe("http://100.116.99.9:7421");
    expect(normalizeHttpUrl("https://brain.example/x//")).toBe("https://brain.example/x");
    expect(normalizeHttpUrl("ftp://x")).toBeNull();
    expect(normalizeHttpUrl("http://")).toBeNull();
    expect(normalizeHttpUrl("http://a b")).toBeNull();
    expect(normalizeHttpUrl(42)).toBeNull();
  });

  // Collisions are found by URL: host case, trailing slash and the default
  // port must not hide a match.
  it("compares URLs ignoring host case, trailing slash and default port", () => {
    expect(sameUrl("http://Host:80/mcp/", "http://host/mcp")).toBe(true);
    expect(sameUrl("http://host/mcp", "http://host/mcp2")).toBe(false);
    expect(sameUrl(undefined, "http://host/mcp")).toBe(false);
    expect(sameUrl("not a url/", "not a url")).toBe(true);
  });

  it("derives mcp, health, api and skill URLs from the base, with overrides", () => {
    expect(brainUrls({ remote: { baseUrl: "http://b:1", auth: { mode: "none" } } })).toEqual({
      mcpUrl: "http://b:1/mcp",
      healthUrl: "http://b:1/healthz",
      apiUrl: "http://b:1/api/v1",
      skillUrl: "http://b:1/skill",
    });
    expect(brainUrls({ remote: { baseUrl: "http://b", mcpUrl: "http://m/x", healthUrl: "http://h/ok", auth: { mode: "none" } } }))
      .toMatchObject({ mcpUrl: "http://m/x", healthUrl: "http://h/ok" });
  });
});

describe("createRemoteBrain", () => {
  it("writes brain.json and the generated plugin, assigned to no domain", () => {
    ensureGlobalDomain();
    const b = created({ name: "Jarvis", about: "Marco's infrastructure wiki", baseUrl: "http://100.116.99.9:7421/" });
    expect(b).toMatchObject({ slug: "jarvis", kind: "remote", remote: { baseUrl: "http://100.116.99.9:7421", auth: { mode: "none" } }, skill: { source: "generated" } });
    expect(getBrain("jarvis")).toEqual(b);
    expect(statSync(join(brainDir("jarvis"), "brain.json")).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(join(brainPluginDir("jarvis"), ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("companion-brain-jarvis");
    const skill = readFileSync(join(brainSkillDir("jarvis"), "SKILL.md"), "utf-8");
    expect(skill).toMatch(/^---\nname: jarvis-brain\ndescription: "Marco's infrastructure wiki"\n---\n/);
    expect(skill).toContain("`jarvis-brain` MCP tools");
    // Off by default: no domain mentions it.
    expect(getDomain("global")?.brain).toBeUndefined();
  });

  // The token lives only in the 0600 secret file, never in brain.json.
  it("stores a bearer token only in the private secret file", () => {
    created({ name: "Team", baseUrl: "https://team.example", auth: { mode: "bearer" }, token: "s3cret-tok" });
    expect(readBrainToken("team")).toBe("s3cret-tok");
    expect(hasBrainToken("team")).toBe(true);
    expect(statSync(join(brainDir("team"), "secret")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(brainDir("team"), "brain.json"), "utf-8")).not.toContain("s3cret-tok");
  });

  it("keeps URL overrides and a custom skill", () => {
    const b = created({
      name: "X", baseUrl: "http://x", mcpUrl: "http://x/rpc/", healthUrl: "", skill: { source: "custom", custom: "Use the x tools." },
    });
    expect(b.remote).toEqual({ baseUrl: "http://x", mcpUrl: "http://x/rpc", auth: { mode: "none" } });
    expect(b.skill).toEqual({ source: "custom", custom: "Use the x tools." });
  });

  it.each([
    [{ baseUrl: "http://x" }, 400, "name is required"],
    [{ name: "!!!", baseUrl: "http://x" }, 400, "letters or digits"],
    [{ name: "x", baseUrl: "x.example" }, 400, "base URL"],
    [{ name: "x", baseUrl: "http://x", mcpUrl: "nope" }, 400, "MCP URL"],
    [{ name: "x", baseUrl: "http://x", healthUrl: "nope" }, 400, "health URL"],
    [{ name: "x", baseUrl: "http://x", about: 3 }, 400, "about"],
    // OAuth is supported since the pre-registered client mode: without a client id it is still refused.
    [{ name: "x", baseUrl: "http://x", auth: { mode: "oauth" } }, 400, "client id"],
    [{ name: "x", baseUrl: "http://x", auth: { mode: "kerberos" } }, 400, "auth must be"],
    [{ name: "x", baseUrl: "http://x", auth: { mode: "oauth", clientId: "a b" } }, 400, "without spaces"],
    [{ name: "x", baseUrl: "http://x", auth: { mode: "oauth", clientId: "app", callbackPort: 70000 } }, 400, "callback port"],
    [{ name: "x", baseUrl: "http://x", auth: { mode: "bearer" } }, 400, "needs a token"],
    [{ name: "x", baseUrl: "http://x", auth: { mode: "bearer" }, token: "a b" }, 400, "spaces"],
    [{ name: "x", baseUrl: "http://x", token: 5 }, 400, "non-empty"],
    [{ name: "x", baseUrl: "http://x", skill: "custom" }, 400, "skill must be"],
    [{ name: "x", baseUrl: "http://x", skill: { source: "wiki" } }, 400, "skill.source"],
    [{ name: "x", baseUrl: "http://x", skill: { source: "custom", custom: " " } }, 400, "needs its text"],
    [{ name: "x", baseUrl: "http://x", skill: { source: "custom", custom: "x".repeat(100_001) } }, 400, "too long"],
    [{ name: "x", baseUrl: "http://x", skill: { source: "custom", custom: "---\nname: x\n---\nbody" } }, 400, "needs a description"],
  ])("rejects invalid input %#", (input, status, error) => {
    const r = createRemoteBrain(input as Parameters<typeof createRemoteBrain>[0]);
    expect(r).toMatchObject({ ok: false, status });
    expect(r.ok ? "" : r.error).toContain(error);
  });

  it("refuses a second brain with the same slug", () => {
    created({ name: "Jarvis", baseUrl: "http://x" });
    expect(createRemoteBrain({ name: "jarvis", baseUrl: "http://y" })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("skill", () => {
  const base = { slug: "lab", name: "Lab", about: "" };

  // Without an about text the description still says what the brain is for.
  it("falls back to a generic description and caps it at 1000 characters", () => {
    expect(brainSkillMarkdown({ ...base, skill: { source: "generated" } })).toContain('description: "Knowledge base \\"Lab\\"');
    const long = brainSkillMarkdown({ ...base, about: `${"word ".repeat(400)}\nline two`, skill: { source: "generated" } });
    const desc = JSON.parse(/description: (.*)/.exec(long)![1]) as string;
    expect(desc.length).toBeLessThanOrEqual(1000);
    expect(desc).not.toContain("\n");
  });

  // An about text that tries to break out of YAML stays one quoted value.
  it("keeps a hostile about text inside the description value", () => {
    const md = brainSkillMarkdown({ ...base, about: 'x"\n---\nname: evil', skill: { source: "generated" } });
    expect(md.split("\n").slice(0, 4)).toEqual(["---", "name: lab-brain", 'description: "x\\" --- name: evil"', "---"]);
  });

  it("uses a custom body under generated frontmatter, or a full custom SKILL.md as is", () => {
    expect(brainSkillMarkdown({ ...base, about: "About", skill: { source: "custom", custom: "Body" } }))
      .toBe('---\nname: lab-brain\ndescription: "About"\n---\n\nBody\n');
    const full = "---\nname: jarvis-brain\ndescription: Use it\n---\n\n# Jarvis";
    expect(brainSkillMarkdown({ ...base, skill: { source: "custom", custom: full } })).toBe(`${full}\n`);
  });

  // A spawn re-creates a plugin folder removed by hand.
  it("regenerates a missing plugin", () => {
    const b = created({ name: "Lab", baseUrl: "http://x" });
    rmSync(brainPluginDir("lab"), { recursive: true });
    ensureBrainPlugin(b);
    expect(existsSync(join(brainSkillDir("lab"), "SKILL.md"))).toBe(true);
  });
});

describe("listBrains / getBrain", () => {
  it("lists brains by name, skipping broken folders", () => {
    created({ name: "Zeta", baseUrl: "http://z" });
    created({ name: "Alpha", baseUrl: "http://a" });
    mkdirSync(join(h.home, "brains", "broken"), { recursive: true });
    writeFileSync(join(h.home, "brains", "broken", "brain.json"), "{not json");
    mkdirSync(join(h.home, "brains", "nourl"), { recursive: true });
    writeFileSync(join(h.home, "brains", "nourl", "brain.json"), JSON.stringify({ name: "No URL", kind: "remote" }));
    expect(listBrains().map((b) => b.slug)).toEqual(["alpha", "zeta"]);
    expect(getBrain("../etc")).toBeUndefined();
  });

  it("returns nothing when there is no brains folder", () => {
    expect(listBrains()).toEqual([]);
  });

  // A hand-edited brain.json is normalized: unknown auth → none, empty custom → generated.
  it("normalizes a hand-edited config", () => {
    mkdirSync(join(h.home, "brains", "hand"), { recursive: true });
    writeFileSync(join(h.home, "brains", "hand", "brain.json"), JSON.stringify({
      kind: "remote", remote: { baseUrl: "http://h/", auth: { mode: "weird" } }, skill: { source: "custom", custom: "" }, about: 1,
    }));
    expect(getBrain("hand")).toEqual({
      slug: "hand", name: "hand", kind: "remote", createdAt: 0, about: "",
      remote: { baseUrl: "http://h", auth: { mode: "none" } }, skill: { source: "generated" },
    });
  });
});

describe("updateBrain", () => {
  it("changes text, URLs and skill, and rewrites the plugin", () => {
    created({ name: "Lab", baseUrl: "http://x", mcpUrl: "http://x/rpc" });
    const r = updateBrain("lab", {
      name: "Lab 2", about: "New about", baseUrl: "http://y/", mcpUrl: null, healthUrl: "http://y/ok", skill: { source: "custom", custom: "Custom" },
    });
    expect(r).toMatchObject({ ok: true, brain: { name: "Lab 2", about: "New about", remote: { baseUrl: "http://y", healthUrl: "http://y/ok" } } });
    expect(getBrain("lab")?.remote?.mcpUrl).toBeUndefined();
    expect(readFileSync(join(brainSkillDir("lab"), "SKILL.md"), "utf-8")).toContain("Custom");
    expect(updateBrain("lab", { skill: { source: "generated" } })).toMatchObject({ ok: true, brain: { skill: { source: "generated" } } });
  });

  // Setting, keeping and clearing the token; "none" removes it.
  it("sets, keeps and removes the token with the auth mode", () => {
    created({ name: "Lab", baseUrl: "http://x" });
    expect(updateBrain("lab", { auth: { mode: "bearer" } })).toMatchObject({ ok: false, error: expect.stringContaining("needs a token") });
    expect(updateBrain("lab", { auth: { mode: "bearer" }, token: "t1" }).ok).toBe(true);
    expect(readBrainToken("lab")).toBe("t1");
    expect(updateBrain("lab", { about: "x" }).ok).toBe(true);
    expect(readBrainToken("lab")).toBe("t1");
    expect(updateBrain("lab", { token: "t2" }).ok).toBe(true);
    expect(readBrainToken("lab")).toBe("t2");
    expect(updateBrain("lab", { token: null })).toMatchObject({ ok: false, status: 400 });
    expect(updateBrain("lab", { auth: { mode: "none" } }).ok).toBe(true);
    expect(hasBrainToken("lab")).toBe(false);
  });

  it.each([
    [{ name: " " }, "Invalid name"],
    [{ about: 3 }, "about"],
    [{ skill: { source: "nope" } }, "skill.source"],
    [{ token: "" }, "non-empty"],
    [{ baseUrl: "nope" }, "base URL"],
    [{ mcpUrl: "nope" }, "MCP URL"],
    [{ auth: null }, "auth must be"],
  ])("rejects an invalid change %#", (patch, error) => {
    created({ name: "Lab", baseUrl: "http://x" });
    const r = updateBrain("lab", patch as Parameters<typeof updateBrain>[1]);
    expect(r.ok ? "" : r.error).toContain(error);
  });

  it("reports an unknown brain", () => {
    expect(updateBrain("nope", { name: "x" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("OAuth auth", () => {
  // The client id (and Claude's optional callback port) is configuration, not
  // a secret: kept in brain.json; switching to OAuth drops a bearer token.
  it("stores the pre-registered client and drops a bearer token", () => {
    const b = created({ name: "Ent", baseUrl: "https://e.example", auth: { mode: "oauth", clientId: " app-1 ", callbackPort: "8765" } });
    expect(b.remote?.auth).toEqual({ mode: "oauth", clientId: "app-1", callbackPort: 8765 });
    expect(getBrain("ent")?.remote?.auth).toEqual({ mode: "oauth", clientId: "app-1", callbackPort: 8765 });
    created({ name: "Lab", baseUrl: "http://x", auth: { mode: "bearer" }, token: "t" });
    expect(updateBrain("lab", { auth: { mode: "oauth", clientId: "app-2" } })).toMatchObject({ ok: true, brain: { remote: { auth: { mode: "oauth", clientId: "app-2" } } } });
    expect(hasBrainToken("lab")).toBe(false);
    expect(updateBrain("lab", { auth: { mode: "oauth" } })).toMatchObject({ ok: false, error: expect.stringContaining("client id") });
  });

  // A hand-edited OAuth entry without a valid client id falls back to "none".
  it("normalizes a broken OAuth config to none", () => {
    mkdirSync(join(h.home, "brains", "bad"), { recursive: true });
    writeFileSync(join(h.home, "brains", "bad", "brain.json"), JSON.stringify({ remote: { baseUrl: "http://b", auth: { mode: "oauth", clientId: "" } } }));
    expect(getBrain("bad")?.remote?.auth).toEqual({ mode: "none" });
  });
});

describe("server skill storage", () => {
  const meta = { fetchedAt: 1, etag: '"e"', contentHash: "h1", serverVersion: "1", name: "x-brain" };

  // A fetched skill becomes the brain's skill; a 304 keeps it; a failure
  // keeps it with a note; choosing another source drops it.
  it("applies fetched, unchanged and failed outcomes", () => {
    created({ name: "Lab", baseUrl: "http://x" });
    applyServerSkill("lab", { kind: "fetched", meta, text: "---\nname: lab-brain\ndescription: d\n---\n\n# From server\n" });
    expect(getBrain("lab")?.skill).toEqual({ source: "server", server: meta });
    expect(readServerSkill("lab")).toContain("# From server");
    expect(readFileSync(join(brainSkillDir("lab"), "SKILL.md"), "utf-8")).toContain("# From server");
    expect(applyServerSkill("lab", { kind: "unchanged", fetchedAt: 2, contentHash: "h2" })?.skill).toEqual({ source: "server", server: { ...meta, fetchedAt: 2, contentHash: "h2" } });
    expect(applyServerSkill("lab", { kind: "unchanged", fetchedAt: 3 })?.skill.server?.contentHash).toBe("h2");
    expect(applyServerSkill("lab", { kind: "failed", note: "down" })?.skill).toMatchObject({ source: "server", note: "down" });
    expect(updateBrain("lab", { skill: { source: "generated" } })).toMatchObject({ ok: true, brain: { skill: { source: "generated" } } });
    expect(readServerSkill("lab")).toBeUndefined();
    expect(applyServerSkill("nope", { kind: "failed", note: "x" })).toBeUndefined();
  });

  // A "server" brain whose stored copy vanished uses the generated skill,
  // and a 304 without a copy is reported in the note.
  it("falls back to the generated skill when the stored copy is gone", () => {
    created({ name: "Lab", baseUrl: "http://x", about: "About lab" });
    applyServerSkill("lab", { kind: "fetched", meta, text: "---\nname: lab-brain\ndescription: d\n---\nbody\n" });
    rmSync(join(brainDir("lab"), "server-skill.md"));
    expect(brainSkillMarkdown(getBrain("lab")!)).toContain('description: "About lab"');
    expect(applyServerSkill("lab", { kind: "unchanged", fetchedAt: 5 })?.skill).toEqual({ source: "generated", note: expect.stringContaining("304") });
  });

  // The API cannot set "server" directly (the routes fetch first); hand-edited
  // configs keep a valid server source and drop a broken one.
  it("refuses a direct server source and normalizes stored ones", () => {
    expect(createRemoteBrain({ name: "x", baseUrl: "http://x", skill: { source: "server" } })).toMatchObject({ ok: false, error: expect.stringContaining("fetching") });
    mkdirSync(join(h.home, "brains", "srv"), { recursive: true });
    writeFileSync(join(h.home, "brains", "srv", "brain.json"), JSON.stringify({ remote: { baseUrl: "http://b" }, skill: { source: "server", server: { fetchedAt: 1, contentHash: 5 }, note: "n" } }));
    expect(getBrain("srv")?.skill).toEqual({ source: "server", server: { fetchedAt: 1, contentHash: null }, note: "n" });
    writeFileSync(join(h.home, "brains", "srv", "brain.json"), JSON.stringify({ remote: { baseUrl: "http://b" }, skill: { source: "server" } }));
    expect(getBrain("srv")?.skill).toEqual({ source: "generated" });
  });
});

describe("deleteBrain", () => {
  // Deleting clears the brain from every domain that chose it (GLOBAL
  // included) in one write, and removes the folder with the token.
  it("clears the brain from every domain and removes its folder", () => {
    ensureGlobalDomain();
    createDomain({ name: "Herd" });
    createDomain({ name: "Ops" });
    created({ name: "Lab", baseUrl: "http://x", auth: { mode: "bearer" }, token: "t" });
    created({ name: "Other", baseUrl: "http://o" });
    updateDomain("global", { brain: "lab" });
    updateDomain("herd", { brain: "lab" });
    updateDomain("ops", { brain: "other" });
    const r = deleteBrain("lab");
    expect(r).toEqual({ ok: true, clearedFrom: ["global", "herd"] });
    expect(getDomain("global")?.brain).toBeUndefined();
    expect(getDomain("herd")?.brain).toBeUndefined();
    expect(getDomain("ops")?.brain).toBe("other");
    expect(existsSync(brainDir("lab"))).toBe(false);
    expect(deleteBrain("lab")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("embedded brains", () => {
  function wiki(name = "wiki", files = ["SCHEMA.md", "index.md"]): string {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "# x\n");
    return dir;
  }

  // Only an existing wiki folder (SCHEMA.md and index.md at its root) is accepted: no scaffolding in this phase.
  it("checks the wiki folder", () => {
    expect(checkWikiDir(wiki())).toEqual({ ok: true, path: join(tmp, "wiki") });
    expect(checkWikiDir(undefined)).toMatchObject({ ok: false, error: "The wiki folder is required" });
    expect(checkWikiDir("relative/path")).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
    expect(checkWikiDir(join(tmp, "nope"))).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    writeFileSync(join(tmp, "file.md"), "x");
    expect(checkWikiDir(join(tmp, "file.md"))).toMatchObject({ ok: false, error: expect.stringMatching(/not a folder/) });
    expect(checkWikiDir(wiki("half", ["SCHEMA.md"]))).toMatchObject({ ok: false, error: expect.stringMatching(/index.md missing/) });
    // "~/" is the home folder (only stat'ed here, never written).
    expect(checkWikiDir("~/no-such-brain-wiki-xyz")).toMatchObject({ ok: false, error: `The folder ${join(homedir(), "no-such-brain-wiki-xyz")} does not exist` });
  });

  it("creates an embedded brain with defaults, a private secret and no domain", () => {
    const r = createEmbeddedBrain({ name: "Work notes", wikiDir: `${wiki()}/`, about: " Team wiki " });
    if (!r.ok) throw new Error(r.error);
    expect(r.brain).toMatchObject({
      slug: "work-notes", kind: "embedded", about: "Team wiki",
      embedded: { wikiDir: join(tmp, "wiki"), autostart: true, redactSecrets: true, language: "auto" },
      skill: { source: "generated" },
    });
    expect(r.brain.remote).toBeUndefined();
    expect(getBrain("work-notes")).toEqual(r.brain);
    expect(readBrainToken("work-notes")).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(brainDir("work-notes"), "secret")).mode & 0o777).toBe(0o600);
    expect(brainDataDir("work-notes")).toBe(join(brainDir("work-notes"), "data"));
    expect(brainLogPath("work-notes")).toBe(join(brainDir("work-notes"), "logs", "brain.log"));
    expect(existsSync(join(brainSkillDir("work-notes"), "SKILL.md"))).toBe(true);
  });

  it("validates the options and refuses duplicates", () => {
    const dir = wiki();
    expect(createEmbeddedBrain({ name: "", wikiDir: dir })).toMatchObject({ ok: false, status: 400 });
    expect(createEmbeddedBrain({ name: "!!", wikiDir: dir })).toMatchObject({ ok: false, status: 400 });
    expect(createEmbeddedBrain({ name: "W", wikiDir: dir, about: 3 })).toMatchObject({ ok: false, status: 400 });
    expect(createEmbeddedBrain({ name: "W", wikiDir: join(tmp, "missing") })).toMatchObject({ ok: false, status: 400 });
    expect(createEmbeddedBrain({ name: "W", wikiDir: dir, autostart: "yes" })).toMatchObject({ ok: false, error: "autostart must be true or false" });
    expect(createEmbeddedBrain({ name: "W", wikiDir: dir, language: "fr" })).toMatchObject({ ok: false, error: expect.stringMatching(/language must be/) });
    const r = createEmbeddedBrain({ name: "W", wikiDir: dir, autostart: false, redactSecrets: false, language: "it" });
    expect(r).toMatchObject({ ok: true, brain: { embedded: { autostart: false, redactSecrets: false, language: "it" } } });
    expect(createEmbeddedBrain({ name: "W", wikiDir: dir })).toMatchObject({ ok: false, status: 409 });
  });

  // The secret of an embedded brain is its key: an update must never delete it like a remote brain's token.
  it("updates the embedded options and keeps the secret", () => {
    createEmbeddedBrain({ name: "Work", wikiDir: wiki() });
    const secret = readBrainToken("work");
    const r = updateBrain("work", { name: "Work 2", language: "en", redactSecrets: false });
    expect(r).toMatchObject({ ok: true, brain: { name: "Work 2", embedded: { language: "en", redactSecrets: false, autostart: true } } });
    expect(readBrainToken("work")).toBe(secret);
    expect(updateBrain("work", { autostart: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(updateBrain("work", { language: "xx" })).toMatchObject({ ok: false, status: 400 });
  });

  it("normalizes a hand-edited embedded config; a broken one is skipped", () => {
    createEmbeddedBrain({ name: "Work", wikiDir: wiki() });
    const path = join(brainDir("work"), "brain.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, embedded: { wikiDir: raw.embedded.wikiDir, language: "klingon" } }));
    expect(getBrain("work")!.embedded).toEqual({ wikiDir: raw.embedded.wikiDir, autostart: true, redactSecrets: true, language: "auto" });
    writeFileSync(path, JSON.stringify({ ...raw, embedded: { wikiDir: "relative" } }));
    expect(getBrain("work")).toBeUndefined();
  });
});
