import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The client of an embedded brain's curator API. Validates that it sends
 * the curator key derived from the brain's secret (and nothing else of it),
 * refuses while the brain is not running instead of calling port 0, and
 * turns every failure (the child's errors, garbage, a dead socket) into a
 * CuratorError with a status the routes can return as is.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("../paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));

import { CuratorError, curatorFetch, type CuratorFetch } from "./brain-curator.js";
import { setChildPort } from "./brain-endpoints.js";
import { embeddedKeys } from "./brain-token.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "brain-curator-"));
  h.home = join(tmp, "companion");
  mkdirSync(join(h.home, "brains", "work"), { recursive: true });
  writeFileSync(join(h.home, "brains", "work", "secret"), `${"ab".repeat(32)}\n`);
});

afterEach(() => {
  setChildPort("work", null);
  rmSync(tmp, { recursive: true, force: true });
});

const fail = (status: number) => (e: unknown) => {
  expect(e).toBeInstanceOf(CuratorError);
  expect((e as CuratorError).status).toBe(status);
  return (e as CuratorError).message;
};

describe("curatorFetch", () => {
  it("refuses while the brain is not running", async () => {
    expect(await curatorFetch("work", "/lint").catch(fail(409))).toMatch(/not running/);
  });

  it("calls the child's /api/v1 with the curator key and a JSON body", async () => {
    setChildPort("work", 45999);
    const fetch = vi.fn<CuratorFetch>(async () => new Response(JSON.stringify({ ok: 1 })));
    expect(await curatorFetch("work", "/sources", { method: "POST", body: { a: 1 }, fetch })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:45999/api/v1/sources");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"a":1}');
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Brain-Key"]).toBe(embeddedKeys("work")!.curatorKey);
    expect(headers["Content-Type"]).toBe("application/json");
    await curatorFetch("work", "/lint", { fetch });
    expect((fetch.mock.calls[1][1]?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("passes the child's 400/404/409/413 through with its message, and maps the rest to 502", async () => {
    setChildPort("work", 45999);
    const answer = (status: number, body: string): CuratorFetch => async () => new Response(body, { status });
    expect(await curatorFetch("work", "/x", { fetch: answer(404, '{"error":"no page x"}') }).catch(fail(404))).toBe("no page x");
    expect(await curatorFetch("work", "/x", { fetch: answer(413, '{"error":"too large"}') }).catch(fail(413))).toBe("too large");
    expect(await curatorFetch("work", "/x", { fetch: answer(500, '{"error":"boom"}') }).catch(fail(502))).toBe("boom");
    expect(await curatorFetch("work", "/x", { fetch: answer(401, "{}") }).catch(fail(502))).toBe("HTTP 401");
    expect(await curatorFetch("work", "/x", { fetch: answer(200, "<html>") }).catch(fail(502))).toMatch(/without JSON/);
    expect(await curatorFetch("work", "/x", { fetch: async () => { throw new Error("ECONNREFUSED"); } }).catch(fail(502))).toMatch(/did not answer: ECONNREFUSED/);
  });
});
