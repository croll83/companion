import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The domain registry (COMPANION_HOME/domains.json) and the domain folders
 * (`<COMPANION_DOMAINS_ROOT>/companion_domain_<slug>`). Everything runs in a
 * temp dir: tests must never touch the real home.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import {
  GLOBAL_DOMAIN,
  countMemoryNotes,
  createDomain,
  deleteDomain,
  domainDir,
  domainMemoryDir,
  domainsRoot,
  ensureDomainLayout,
  ensureGlobalDomain,
  getDomain,
  isDirectory,
  isValidSlug,
  listDomainSkills,
  listDomains,
  readDomainMcp,
  readMemoryIndex,
  setDomainMcpServer,
  slugify,
  updateDomain,
} from "./domain-store.js";

let tmp: string;
const savedRoot = process.env.COMPANION_DOMAINS_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "domain-store-"));
  h.home = join(tmp, "companion");
  process.env.COMPANION_DOMAINS_ROOT = join(tmp, "home");
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.COMPANION_DOMAINS_ROOT;
  else process.env.COMPANION_DOMAINS_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe("slugs", () => {
  // Domain names become folder names: only [a-z0-9-], accents folded.
  it("slugifies names into folder-safe slugs", () => {
    expect(slugify("My Herd project!")).toBe("my-herd-project");
    expect(slugify("Città  di Napoli")).toBe("citta-di-napoli");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(80))).toHaveLength(48);
  });

  it("validates slugs", () => {
    expect(isValidSlug("herd")).toBe(true);
    expect(isValidSlug("my-herd-2")).toBe(true);
    expect(isValidSlug("-herd")).toBe(false);
    expect(isValidSlug("Herd")).toBe(false);
    expect(isValidSlug("../x")).toBe(false);
    expect(isValidSlug(3)).toBe(false);
  });
});

describe("paths", () => {
  // COMPANION_DOMAINS_ROOT relocates every domain folder (used by tests and
  // isolated instances); it is read at each call.
  it("puts domain folders under the domains root", () => {
    expect(domainsRoot()).toBe(join(tmp, "home"));
    expect(domainDir("herd")).toBe(join(tmp, "home", "companion_domain_herd"));
    expect(domainMemoryDir("herd")).toBe(join(tmp, "home", "companion_domain_herd", "memory"));
  });

  it("falls back to the user's home without COMPANION_DOMAINS_ROOT", () => {
    delete process.env.COMPANION_DOMAINS_ROOT;
    expect(domainsRoot()).toBe(require("node:os").homedir());
  });
});

describe("GLOBAL domain", () => {
  // Created at server start: registry entry + full folder layout.
  it("is created once with its folder layout", () => {
    const global = ensureGlobalDomain();
    expect(global).toMatchObject({ slug: GLOBAL_DOMAIN, name: "GLOBAL", mcpDisabled: [], chrome: false });
    const dir = domainDir(GLOBAL_DOMAIN);
    for (const f of ["CLAUDE.md", "memory/MEMORY.md", ".claude-plugin/plugin.json", "mcp.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    for (const d of ["skills", "commands", "agents"]) expect(isDirectory(join(dir, d))).toBe(true);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("GLOBAL domain");
    // Idempotent: a second call does not duplicate the registry entry.
    ensureGlobalDomain();
    expect(listDomains().filter((d) => d.slug === GLOBAL_DOMAIN)).toHaveLength(1);
  });

  it("cannot be deleted", () => {
    ensureGlobalDomain();
    expect(deleteDomain(GLOBAL_DOMAIN)).toMatchObject({ ok: false, status: 400 });
  });

  // The registry holds no secrets but is private like the rest of COMPANION_HOME state.
  it("writes the registry owner-only", () => {
    ensureGlobalDomain();
    expect(statSync(join(h.home, "domains.json")).mode & 0o777).toBe(0o600);
  });
});

describe("createDomain", () => {
  it("creates the registry entry and the plugin layout", () => {
    const res = createDomain({ name: "Herd", description: "The herd project" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.domain).toMatchObject({ slug: "herd", name: "Herd", description: "The herd project", chrome: false, mcpDisabled: [] });
    const dir = domainDir("herd");
    // The domain is a Claude Code plugin named domain-<slug>.
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"))).toEqual({
      name: "domain-herd",
      version: "1.0.0",
      description: "The herd project",
    });
    // mcp.json, NOT .mcp.json: the plugin must not load the servers itself.
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf-8"))).toEqual({ mcpServers: {} });
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(readFileSync(join(dir, "memory", "MEMORY.md"), "utf-8")).toBe("");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("# Domain: Herd");
    expect(getDomain("herd")?.name).toBe("Herd");
  });

  // An existing folder (created by hand, or a domain deleted from the
  // registry and created again) keeps every file the user edited.
  it("never overwrites existing files", () => {
    const dir = domainDir("herd");
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "mine");
    writeFileSync(join(dir, "memory", "MEMORY.md"), "- [x](x.md) — kept");
    writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{"a":{"command":"x"}}}');
    expect(createDomain({ name: "Herd" }).ok).toBe(true);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("mine");
    expect(readFileSync(join(dir, "memory", "MEMORY.md"), "utf-8")).toBe("- [x](x.md) — kept");
    expect(readFileSync(join(dir, "mcp.json"), "utf-8")).toContain('"a"');
    // Missing parts are still added.
    expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("rejects empty names, unusable names and duplicates", () => {
    expect(createDomain({ name: "" })).toMatchObject({ ok: false, status: 400 });
    expect(createDomain({ name: "!!!" })).toMatchObject({ ok: false, status: 400 });
    expect(createDomain({ name: "Herd" }).ok).toBe(true);
    expect(createDomain({ name: "herd" })).toMatchObject({ ok: false, status: 409 });
  });

  it("lists GLOBAL first, then by name", () => {
    ensureGlobalDomain();
    createDomain({ name: "Zeta" });
    createDomain({ name: "Alpha" });
    expect(listDomains().map((d) => d.slug)).toEqual(["global", "alpha", "zeta"]);
  });
});

describe("updateDomain", () => {
  it("updates toggles and text fields", () => {
    createDomain({ name: "Herd" });
    const res = updateDomain("herd", {
      name: "Herd 2",
      description: "  new  ",
      mcpDisabled: ["a", "a", "b"],
      chrome: true,
      plugins: { "p@m": true, bad: "x" },
      skillGroups: { user: false },
    });
    expect(res).toMatchObject({
      ok: true,
      domain: { name: "Herd 2", description: "new", mcpDisabled: ["a", "b"], chrome: true, plugins: { "p@m": true }, skillGroups: { user: false } },
    });
    // skillGroups merge: setting one group keeps the others.
    const res2 = updateDomain("herd", { skillGroups: { design: false }, description: "" });
    expect(res2).toMatchObject({ ok: true, domain: { skillGroups: { user: false, design: false } } });
    expect(getDomain("herd")?.description).toBeUndefined();
  });

  // Which Chrome browser the domain's sessions drive: "local" by default, a
  // trimmed deviceId otherwise, persisted across reads.
  it("defaults chromeBrowser to \"local\" and stores a chosen deviceId", () => {
    createDomain({ name: "Herd" });
    expect(getDomain("herd")?.chromeBrowser).toBe("local");
    expect(updateDomain("herd", { chromeBrowser: "  dev-mac  " })).toMatchObject({ ok: true, domain: { chromeBrowser: "dev-mac" } });
    expect(getDomain("herd")?.chromeBrowser).toBe("dev-mac");
    expect(updateDomain("herd", { chromeBrowser: "local" })).toMatchObject({ ok: true, domain: { chromeBrowser: "local" } });
  });

  it("validates every field", () => {
    createDomain({ name: "Herd" });
    expect(updateDomain("nope", {})).toMatchObject({ ok: false, status: 404 });
    expect(updateDomain("herd", { name: " " })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { description: 3 })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { mcpDisabled: "a" })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { chrome: "yes" })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { chromeBrowser: 7 })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { chromeBrowser: "  " })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { plugins: null })).toMatchObject({ ok: false, status: 400 });
    expect(updateDomain("herd", { skillGroups: 1 })).toMatchObject({ ok: false, status: 400 });
  });

  // The Domains page sends one plugin at a time: the others keep their choice.
  it("merges plugin choices instead of replacing them", () => {
    createDomain({ name: "Herd" });
    updateDomain("herd", { plugins: { "a@m": true } });
    updateDomain("herd", { plugins: { "b@m": false } });
    expect(getDomain("herd")?.plugins).toEqual({ "a@m": true, "b@m": false });
    updateDomain("herd", { plugins: { "a@m": false } });
    expect(getDomain("herd")?.plugins).toEqual({ "a@m": false, "b@m": false });
  });
});

// Add/remove one server from the Domains page form, without touching the
// rest of mcp.json (other servers, env, extra keys).
describe("setDomainMcpServer", () => {
  const mcpPath = () => join(domainDir("herd"), "mcp.json");

  it("adds HTTP and stdio servers, creating mcp.json, written 0600", () => {
    createDomain({ name: "Herd" });
    expect(setDomainMcpServer("herd", "brain", { url: " http://100.1.2.3:7421/mcp " })).toEqual({ ok: true, servers: ["brain"] });
    expect(setDomainMcpServer("herd", "tool", { command: "npx", args: ["-y", "", "srv"] })).toEqual({ ok: true, servers: ["brain", "tool"] });
    expect(setDomainMcpServer("herd", "bare", { command: "srv" })).toMatchObject({ ok: true });
    expect(readDomainMcp("herd").servers).toEqual({
      brain: { type: "http", url: "http://100.1.2.3:7421/mcp" },
      tool: { type: "stdio", command: "npx", args: ["-y", "srv"] },
      bare: { type: "stdio", command: "srv" },
    });
    expect(statSync(mcpPath()).mode & 0o777).toBe(0o600);
  });

  it("replaces a server and keeps the others, their env and any extra key", () => {
    createDomain({ name: "Herd" });
    writeFileSync(mcpPath(), JSON.stringify({ note: "keep", mcpServers: { a: { command: "a", env: { TOKEN: "t" } }, b: { command: "b" } } }));
    expect(setDomainMcpServer("herd", "b", { url: "https://b/mcp" })).toEqual({ ok: true, servers: ["a", "b"] });
    const doc = JSON.parse(readFileSync(mcpPath(), "utf-8"));
    expect(doc).toEqual({ note: "keep", mcpServers: { a: { command: "a", env: { TOKEN: "t" } }, b: { type: "http", url: "https://b/mcp" } } });
  });

  it("removes a server, and reports one that is not there", () => {
    createDomain({ name: "Herd" });
    setDomainMcpServer("herd", "a", { command: "a" });
    expect(setDomainMcpServer("herd", "a", null)).toEqual({ ok: true, servers: [] });
    expect(setDomainMcpServer("herd", "a", null)).toMatchObject({ ok: false, status: 404 });
  });

  it("works for GLOBAL", () => {
    ensureGlobalDomain();
    expect(setDomainMcpServer(GLOBAL_DOMAIN, "g", { url: "http://g/mcp" })).toEqual({ ok: true, servers: ["g"] });
  });

  it("validates the domain, the name and the server", () => {
    createDomain({ name: "Herd" });
    const before = readFileSync(mcpPath(), "utf-8");
    expect(setDomainMcpServer("nope", "a", { command: "a" })).toMatchObject({ ok: false, status: 404 });
    expect(setDomainMcpServer("herd", "bad.name", { command: "a" })).toMatchObject({ ok: false, status: 400 });
    expect(setDomainMcpServer("herd", 3, { command: "a" })).toMatchObject({ ok: false, status: 400 });
    expect(setDomainMcpServer("herd", "a", {})).toMatchObject({ ok: false, status: 400, error: "Give either a URL or a command" });
    expect(setDomainMcpServer("herd", "a", { url: "http://x", command: "c" })).toMatchObject({ ok: false, status: 400 });
    expect(setDomainMcpServer("herd", "a", { url: "ftp://x" })).toMatchObject({ ok: false, status: 400 });
    expect(setDomainMcpServer("herd", "a", { command: "c", args: "x y" })).toMatchObject({ ok: false, status: 400 });
    expect(setDomainMcpServer("herd", "a", { command: "c", args: [1] })).toMatchObject({ ok: false, status: 400 });
    // A refused change leaves the file as it was.
    expect(readFileSync(mcpPath(), "utf-8")).toBe(before);
  });

  // A hand-edited file with a syntax error is never overwritten from the form.
  it("refuses to touch an mcp.json that is not valid JSON", () => {
    createDomain({ name: "Herd" });
    writeFileSync(mcpPath(), "{ broken");
    expect(setDomainMcpServer("herd", "a", { command: "a" })).toMatchObject({ ok: false, status: 409 });
    expect(readFileSync(mcpPath(), "utf-8")).toBe("{ broken");
  });
});

describe("deleteDomain", () => {
  // Only the registry entry goes: files on disk are never deleted.
  it("removes the registry entry and keeps the folder", () => {
    createDomain({ name: "Herd" });
    expect(deleteDomain("herd")).toMatchObject({ ok: true });
    expect(getDomain("herd")).toBeUndefined();
    expect(existsSync(join(domainDir("herd"), "CLAUDE.md"))).toBe(true);
    expect(deleteDomain("herd")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("registry robustness", () => {
  it("ignores a corrupt registry and invalid entries", () => {
    mkdirSync(h.home, { recursive: true });
    writeFileSync(join(h.home, "domains.json"), "{not json");
    expect(listDomains()).toEqual([]);
    writeFileSync(join(h.home, "domains.json"), JSON.stringify({ domains: [{ slug: "../x" }, { slug: "ok", mcpDisabled: [1, "a"] }, null] }));
    expect(listDomains()).toEqual([expect.objectContaining({ slug: "ok", name: "ok", mcpDisabled: ["a"], chrome: false })]);
    writeFileSync(join(h.home, "domains.json"), JSON.stringify({ domains: "x" }));
    expect(listDomains()).toEqual([]);
  });
});

describe("domain contents", () => {
  it("reads mcp.json servers and reports a broken file", () => {
    ensureDomainLayout({ slug: "herd", name: "Herd" });
    const path = join(domainDir("herd"), "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: "x" }, bad: "nope" } }));
    expect(readDomainMcp("herd")).toEqual({ servers: { a: { command: "x" } } });
    writeFileSync(path, "{");
    expect(readDomainMcp("herd").error).toMatch(/Invalid JSON/);
    writeFileSync(path, JSON.stringify({ mcpServers: [] }));
    expect(readDomainMcp("herd").error).toMatch(/must be an object/);
    writeFileSync(path, JSON.stringify({}));
    expect(readDomainMcp("herd")).toEqual({ servers: {} });
    expect(readDomainMcp("missing")).toEqual({ servers: {} });
  });

  it("lists skills that have a SKILL.md", () => {
    const dir = ensureDomainLayout({ slug: "herd", name: "Herd" });
    mkdirSync(join(dir, "skills", "b-skill"), { recursive: true });
    writeFileSync(join(dir, "skills", "b-skill", "SKILL.md"), "---\nname: b\n---\n");
    mkdirSync(join(dir, "skills", "a-skill"), { recursive: true });
    writeFileSync(join(dir, "skills", "a-skill", "SKILL.md"), "x");
    mkdirSync(join(dir, "skills", "empty"), { recursive: true });
    expect(listDomainSkills("herd")).toEqual(["a-skill", "b-skill"]);
    expect(listDomainSkills("missing")).toEqual([]);
  });

  it("counts memory notes and reads the index (capped)", () => {
    const mem = join(ensureDomainLayout({ slug: "herd", name: "Herd" }), "memory");
    writeFileSync(join(mem, "fact-a.md"), "a");
    writeFileSync(join(mem, "fact-b.md"), "b");
    writeFileSync(join(mem, "notes.txt"), "c");
    expect(countMemoryNotes(mem)).toBe(2);
    expect(countMemoryNotes(join(tmp, "none"))).toBe(0);
    writeFileSync(join(mem, "MEMORY.md"), "x".repeat(50));
    expect(readMemoryIndex(mem)).toBe("x".repeat(50));
    expect(readMemoryIndex(mem, 10)).toContain("index truncated");
    expect(readMemoryIndex(join(tmp, "none"))).toBe("");
  });
});
