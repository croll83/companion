import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  brainDir,
  brainPluginDir,
  brainSkillDir,
  brainSkillMarkdown,
  brainUrls,
  createRemoteBrain,
  deleteBrain,
  ensureBrainPlugin,
  getBrain,
  hasBrainToken,
  listBrains,
  normalizeHttpUrl,
  readBrainToken,
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

  it("derives mcp, health and api URLs from the base, with overrides", () => {
    expect(brainUrls({ remote: { baseUrl: "http://b:1", auth: { mode: "none" } } })).toEqual({
      mcpUrl: "http://b:1/mcp",
      healthUrl: "http://b:1/healthz",
      apiUrl: "http://b:1/api/v1",
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
    [{ name: "x", baseUrl: "http://x", auth: { mode: "oauth" } }, 400, "auth must be"],
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
