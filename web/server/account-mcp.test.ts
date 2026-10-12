import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The MCP servers every Claude session loads by itself (user config,
 * claude.ai connectors), read with `claude mcp list` and cached on disk so
 * the Domains page never waits for the CLI. The spawn is always injected:
 * no real CLI runs here.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { cachedAccountMcpServers, isAccountMcpStale, parseMcpList, refreshAccountMcpServers } from "./account-mcp.js";
import type { ProbeDeps, ProbeOutput } from "./chrome-browser-probe.js";

// Real output of `claude mcp list` on CLI 2.1.293 (trimmed).
const SAMPLE = [
  "Checking MCP server health…",
  "",
  "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected",
  "claude.ai Blockscout: https://mcp.blockscout.com/mcp - ! Needs authentication",
  "github: npx -y @modelcontextprotocol/server-github - ✔ Connected",
  "broken: node broken.js - ✗ Failed to connect",
  "odd: https://x/mcp - ? Pending",
  "companion: bun companion-mcp.ts - ✔ Connected",
  "plugin:hercle-brain:hercle-brain: http://127.0.0.1:7420/mcp - ✔ Connected",
].join("\n");

function deps(out: Partial<ProbeOutput> | Error, binary: string | null = "/bin/claude"): ProbeDeps & { calls: string[][]; cleaned: number } {
  const d = {
    binary,
    env: {},
    cwd: "/tmp/x",
    calls: [] as string[][],
    cleaned: 0,
    cleanup: () => { d.cleaned++; },
    spawn: async (cmd: string[]) => {
      d.calls.push(cmd);
      if (out instanceof Error) throw out;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...out };
    },
  };
  return d;
}

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), "account-mcp-"));
});
afterEach(() => rmSync(h.home, { recursive: true, force: true }));

describe("parseMcpList", () => {
  it("reads servers with their target and health, leaving out Companion's own and plugin servers", () => {
    expect(parseMcpList(SAMPLE)).toEqual([
      { name: "broken", target: "node broken.js", health: "failed", connector: false },
      { name: "claude.ai Blockscout", target: "https://mcp.blockscout.com/mcp", health: "needs-auth", connector: true },
      { name: "claude.ai Gmail", target: "https://gmailmcp.googleapis.com/mcp/v1", health: "connected", connector: true },
      { name: "github", target: "npx -y @modelcontextprotocol/server-github", health: "connected", connector: false },
      { name: "odd", target: "https://x/mcp", health: "Pending", connector: false },
    ]);
  });
});

describe("refreshAccountMcpServers / cachedAccountMcpServers", () => {
  it("runs `claude mcp list`, caches the result on disk (0600) and cleans up", async () => {
    expect(cachedAccountMcpServers()).toEqual({ servers: [], at: 0 });
    const d = deps({ stdout: SAMPLE });
    const list = await refreshAccountMcpServers(d);
    expect(d.calls).toEqual([["/bin/claude", "mcp", "list"]]);
    expect(d.cleaned).toBe(1);
    expect(list.servers).toHaveLength(5);
    expect(list.at).toBeGreaterThan(0);
    expect(cachedAccountMcpServers()).toEqual(list);
    expect(statSync(join(h.home, "account-mcp-servers.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps the previous servers and records why when a read fails", async () => {
    const first = await refreshAccountMcpServers(deps({ stdout: SAMPLE }));
    const timedOut = await refreshAccountMcpServers(deps({ timedOut: true }));
    expect(timedOut.servers).toEqual(first.servers);
    expect(timedOut.error).toBe("claude mcp list failed: timed out");
    const exit = await refreshAccountMcpServers(deps({ exitCode: 1, stderr: "warn\nnot logged in" }));
    expect(exit.error).toBe("claude mcp list failed: not logged in");
    const exitNoStderr = await refreshAccountMcpServers(deps({ exitCode: 2 }));
    expect(exitNoStderr.error).toBe("claude mcp list failed: exit 2");
    const thrown = await refreshAccountMcpServers(deps(new Error("spawn ENOENT")));
    expect(thrown.error).toBe("claude mcp list failed: spawn ENOENT");
    const noCli = await refreshAccountMcpServers(deps({ stdout: SAMPLE }, null));
    expect(noCli.error).toBe("claude mcp list failed: the claude CLI was not found");
    expect(cachedAccountMcpServers().servers).toEqual(first.servers);
  });

  it("accepts a non-zero exit when servers were listed (one server failing its health check)", async () => {
    const list = await refreshAccountMcpServers(deps({ stdout: SAMPLE, exitCode: 1 }));
    expect(list.error).toBeUndefined();
    expect(list.servers).toHaveLength(5);
  });

  it("shares one run between concurrent refreshes", async () => {
    const d = deps({ stdout: SAMPLE });
    const [a, b] = await Promise.all([refreshAccountMcpServers(d), refreshAccountMcpServers(d)]);
    expect(a).toBe(b);
    expect(d.calls).toHaveLength(1);
  });

  it("tolerates a corrupt or partial cache file", () => {
    writeFileSync(join(h.home, "account-mcp-servers.json"), "{");
    expect(cachedAccountMcpServers()).toEqual({ servers: [], at: 0 });
    writeFileSync(join(h.home, "account-mcp-servers.json"), JSON.stringify({ servers: [{ name: "a" }, null, { x: 1 }], error: "e" }));
    expect(cachedAccountMcpServers()).toEqual({ servers: [{ name: "a" }], at: 0, error: "e" });
    expect(readFileSync(join(h.home, "account-mcp-servers.json"), "utf-8")).toContain("error");
  });

  it("is stale after 30 minutes", () => {
    expect(isAccountMcpStale({ servers: [], at: 0 })).toBe(true);
    expect(isAccountMcpStale({ servers: [], at: 1_000 }, 1_000 + 29 * 60_000)).toBe(false);
    expect(isAccountMcpStale({ servers: [], at: 1_000 }, 1_000 + 31 * 60_000)).toBe(true);
  });
});
