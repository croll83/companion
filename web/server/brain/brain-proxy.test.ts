import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The proxy `ALL /brains/<slug>/mcp` that sessions use to reach an embedded
 * brain. It sits before Companion's auth, so its own checks are the
 * security boundary: loopback only, a `brn_` token signed for THIS brain,
 * then a wait (bounded) for a child that is still starting, and a 503 when
 * it does not come. The answer, JSON or a streamed SSE body, is passed
 * through without hop-by-hop headers. The child is a fake fetch here.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { curatorPassUrl, handleBrainProxy, isLoopbackAddress, issueCuratorPass, revokeCuratorPass } from "./brain-proxy.js";
import { embeddedKeys } from "./brain-token.js";
import { createEmbeddedBrain, createRemoteBrain, brainUrls, getBrain } from "./brain-store.js";
import { mintBrainToken } from "./brain-token.js";
import { embeddedProxyUrl, getCompanionPort, setChildPort, setCompanionPort } from "./brain-endpoints.js";

let tmp: string;
const URL_ = "http://127.0.0.1:3456/brains/work/mcp";

function req(token: string | null, init: RequestInit = {}, url = URL_): Request {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("host", "127.0.0.1:3456");
  return new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ...init, headers });
}

const running = { waitRunning: vi.fn(async () => true) };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-proxy-"));
  h.home = join(tmp, "companion");
  const wiki = join(tmp, "wiki");
  mkdirSync(wiki, { recursive: true });
  writeFileSync(join(wiki, "SCHEMA.md"), "# s\n");
  writeFileSync(join(wiki, "index.md"), "# i\n");
  const r = createEmbeddedBrain({ name: "Work", wikiDir: wiki });
  if (!r.ok) throw new Error(r.error);
  setChildPort("work", 45678);
  running.waitRunning.mockClear();
});

afterEach(() => {
  setChildPort("work", null);
  rmSync(tmp, { recursive: true, force: true });
});

describe("handleBrainProxy", () => {
  it("ignores other paths", async () => {
    expect(await handleBrainProxy(new Request("http://127.0.0.1/brains/work/other"), "127.0.0.1")).toBeNull();
    expect(await handleBrainProxy(new Request("http://127.0.0.1/api/brains"), "127.0.0.1")).toBeNull();
  });

  it("accepts loopback callers only", async () => {
    const token = mintBrainToken("work", "GLOBAL", "s1");
    const res = await handleBrainProxy(req(token), "192.168.1.20", { supervisor: running });
    expect(res!.status).toBe(403);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("100.64.1.1")).toBe(false);
  });

  it("404 for an unknown or remote brain; 401 without a token signed for this brain", async () => {
    expect((await handleBrainProxy(req(null, {}, "http://127.0.0.1:3456/brains/nope/mcp"), "127.0.0.1"))!.status).toBe(404);
    expect(createRemoteBrain({ name: "Far", baseUrl: "http://100.64.0.9:7421" }).ok).toBe(true);
    expect((await handleBrainProxy(req(null, {}, "http://127.0.0.1:3456/brains/far/mcp"), "127.0.0.1"))!.status).toBe(404);
    expect((await handleBrainProxy(req(null), "127.0.0.1", { supervisor: running }))!.status).toBe(401);
    expect((await handleBrainProxy(req("brn_forged.sig"), "127.0.0.1", { supervisor: running }))!.status).toBe(401);
    expect(running.waitRunning).not.toHaveBeenCalled();
  });

  it("503 with Retry-After when the child does not come up in time", async () => {
    const stopped = { waitRunning: vi.fn(async () => false) };
    const res = await handleBrainProxy(req(mintBrainToken("work", "GLOBAL", "s1")), "127.0.0.1", { supervisor: stopped, waitMs: 50 });
    expect(res!.status).toBe(503);
    expect(res!.headers.get("retry-after")).toBe("10");
    expect(stopped.waitRunning).toHaveBeenCalledWith("work", 50);
    expect((await res!.json()).error.message).toMatch(/not running/);
  });

  it("forwards method, body and headers (no Host) and streams the answer back", async () => {
    const token = mintBrainToken("work", "dev", "s1")!;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));
          c.close();
        },
      });
      expect(new Headers(init.headers).get("host")).toBeNull();
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", connection: "keep-alive", "mcp-session-id": "none" } });
    });
    const res = await handleBrainProxy(req(token, { headers: { "x-client-session-id": "abc12345" } }, `${URL_}?x=1`), "::1", { supervisor: running, fetch });
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("text/event-stream");
    expect(res!.headers.get("connection")).toBeNull();
    expect(await res!.text()).toContain('"result":{}');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:45678/mcp?x=1");
    expect(init.method).toBe("POST");
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${token}`);
    expect(sent.get("x-client-session-id")).toBe("abc12345");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toContain("tools/list");

    // GET carries no body; a child that dies mid-request gives 502.
    const get = await handleBrainProxy(req(token, { method: "GET", body: undefined }), "127.0.0.1", { supervisor: running, fetch: async (_u, i) => new Response(String(i.body), { status: 405 }) });
    expect(get!.status).toBe(405);
    expect(await get!.text()).toBe("undefined");
    const dead = await handleBrainProxy(req(token), "127.0.0.1", { supervisor: running, fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(dead!.status).toBe(502);
  });
});

/**
 * The curator API through a consolidation run's pass: the URL a run's agent
 * gets (BRAIN_API_URL). The pass is the only credential the agent holds, so
 * the checks matter: loopback only, a live pass for THIS brain, GET/POST
 * only, the child running; Companion adds the real X-Brain-Key, which never
 * reaches the agent. A revoked pass is dead.
 */
describe("curator pass", () => {
  const childOk = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ counts: { pending: 2 } }), { status: 200, headers: { "content-type": "application/json" } }));
  const deps = { supervisor: running, fetch: childOk };
  const passReq = (pass: string, path = "/inbox/notes?status=pending", init: RequestInit = {}) =>
    new Request(`http://127.0.0.1:3456/brains/work/curator/${pass}/api/v1${path}`, init);

  it("forwards to the child's /api/v1 with the brain's curator key while the pass lives", async () => {
    childOk.mockClear();
    const pass = issueCuratorPass("work");
    expect(curatorPassUrl("work", pass)).toBe(`http://127.0.0.1:${getCompanionPort()}/brains/work/curator/${pass}/api/v1`);
    const res = await handleBrainProxy(passReq(pass), "127.0.0.1", deps);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ counts: { pending: 2 } });
    const [url, init] = childOk.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:45678/api/v1/inbox/notes?status=pending");
    expect((init.headers as Record<string, string>)["X-Brain-Key"]).toBe(embeddedKeys("work")!.curatorKey);

    const post = await handleBrainProxy(passReq(pass, "/consolidation/runs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), "127.0.0.1", deps);
    expect(post!.status).toBe(200);
    const [, postInit] = childOk.mock.calls[1];
    expect(new TextDecoder().decode(postInit.body as ArrayBuffer)).toBe("{}");
    expect((postInit.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    revokeCuratorPass(pass);
    revokeCuratorPass(undefined);
    expect((await handleBrainProxy(passReq(pass), "127.0.0.1", deps))!.status).toBe(401);
  });

  it("refuses other machines, unknown passes, another brain's pass and other methods", async () => {
    const pass = issueCuratorPass("work");
    const other = issueCuratorPass("team");
    try {
      expect((await handleBrainProxy(passReq(pass), "100.64.0.9", deps))!.status).toBe(403);
      expect((await handleBrainProxy(passReq("x".repeat(30)), "127.0.0.1", deps))!.status).toBe(401);
      expect((await handleBrainProxy(passReq(other), "127.0.0.1", deps))!.status).toBe(401);
      expect((await handleBrainProxy(passReq(pass, "/inbox/notes", { method: "DELETE" }), "127.0.0.1", deps))!.status).toBe(405);
    } finally {
      revokeCuratorPass(pass);
      revokeCuratorPass(other);
    }
  });

  it("answers 503 when the brain is not running and 502 when the child does not answer", async () => {
    const pass = issueCuratorPass("work");
    try {
      const down = await handleBrainProxy(passReq(pass), "127.0.0.1", { supervisor: { waitRunning: vi.fn(async () => false) }, fetch: childOk, waitMs: 1 });
      expect(down!.status).toBe(503);
      const dead = await handleBrainProxy(passReq(pass), "127.0.0.1", { supervisor: running, fetch: async () => { throw new Error("ECONNREFUSED"); } });
      expect(dead!.status).toBe(502);
      expect(await dead!.json()).toEqual({ error: "The brain did not answer: ECONNREFUSED" });
    } finally {
      revokeCuratorPass(pass);
    }
  });
});

describe("brain endpoints", () => {
  it("an embedded brain's MCP URL is the proxy on Companion's port; the rest is the child's", () => {
    const before = getCompanionPort();
    setCompanionPort(4999);
    try {
      expect(embeddedProxyUrl("work")).toBe("http://127.0.0.1:4999/brains/work/mcp");
      expect(brainUrls(getBrain("work")!)).toEqual({
        mcpUrl: "http://127.0.0.1:4999/brains/work/mcp",
        healthUrl: "http://127.0.0.1:45678/healthz",
        apiUrl: "http://127.0.0.1:45678/api/v1",
        skillUrl: "http://127.0.0.1:45678/skill",
      });
      setChildPort("work", null);
      expect(brainUrls(getBrain("work")!).healthUrl).toBe("http://127.0.0.1:0/healthz");
    } finally {
      setCompanionPort(before);
    }
  });
});
