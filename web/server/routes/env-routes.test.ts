import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock env-manager ──────────────────────────────────────────────────────
vi.mock("../env-manager.js", () => ({
  listEnvs: vi.fn(() => []),
  getEnv: vi.fn(() => null),
  createEnv: vi.fn(),
  updateEnv: vi.fn(),
  deleteEnv: vi.fn(() => false),
}));

import { Hono } from "hono";
import * as envManager from "../env-manager.js";
import { registerEnvRoutes } from "./env-routes.js";

// ─── Test setup ────────────────────────────────────────────────────────────

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();

  app = new Hono();
  const api = new Hono();
  registerEnvRoutes(api);
  app.route("/api", api);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Minimal env fixture matching the CompanionEnv shape. */
function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Env",
    slug: "test-env",
    variables: { FOO: "bar" },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/envs
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/envs", () => {
  it("returns an empty list when no environments exist", async () => {
    vi.mocked(envManager.listEnvs).mockReturnValue([]);

    const res = await app.request("/api/envs");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns a list of environments", async () => {
    const envs = [makeEnv(), makeEnv({ slug: "second", name: "Second" })];
    vi.mocked(envManager.listEnvs).mockReturnValue(envs as any);

    const res = await app.request("/api/envs");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(2);
    expect(json[0].slug).toBe("test-env");
  });

  it("returns 500 when listEnvs throws", async () => {
    vi.mocked(envManager.listEnvs).mockImplementation(() => {
      throw new Error("disk failure");
    });

    const res = await app.request("/api/envs");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("disk failure");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/envs/:slug", () => {
  it("returns the environment when it exists", async () => {
    const env = makeEnv();
    vi.mocked(envManager.getEnv).mockReturnValue(env as any);

    const res = await app.request("/api/envs/test-env");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(env);
    expect(envManager.getEnv).toHaveBeenCalledWith("test-env");
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.getEnv).mockReturnValue(null as any);

    const res = await app.request("/api/envs/missing");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/envs
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/envs", () => {
  it("creates a new environment and returns 201", async () => {
    const created = makeEnv();
    vi.mocked(envManager.createEnv).mockReturnValue(created as any);

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Env", variables: { FOO: "bar" } }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
    // Verify createEnv was called with the correct arguments: name, variables
    // and no scope (an old client creates an unassigned profile).
    expect(envManager.createEnv).toHaveBeenCalledWith(
      "Test Env",
      { FOO: "bar" },
      { scope: undefined, folders: undefined },
    );
  });

  // The scope editor sends scope + folders; both must reach the manager.
  it("passes scope and folders through to createEnv", async () => {
    vi.mocked(envManager.createEnv).mockReturnValue(makeEnv({ scope: "project", folders: ["/repo"] }) as any);

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Env", variables: {}, scope: "project", folders: ["/repo"] }),
    });

    expect(res.status).toBe(201);
    expect(envManager.createEnv).toHaveBeenCalledWith("Test Env", {}, { scope: "project", folders: ["/repo"] });
  });

  it("returns 400 when createEnv throws a validation error", async () => {
    vi.mocked(envManager.createEnv).mockImplementation(() => {
      throw new Error("Name is required");
    });

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Name is required");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("PUT /api/envs/:slug", () => {
  it("updates an existing environment", async () => {
    const updated = makeEnv({ name: "Updated" });
    vi.mocked(envManager.updateEnv).mockReturnValue(updated as any);

    const res = await app.request("/api/envs/test-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(updated);
    expect(envManager.updateEnv).toHaveBeenCalledWith(
      "test-env",
      expect.objectContaining({ name: "Updated" }),
    );
  });

  // Scope changes (e.g. assigning a legacy profile) go through the update API.
  it("passes scope and folders through to updateEnv", async () => {
    vi.mocked(envManager.updateEnv).mockReturnValue(makeEnv({ scope: "global" }) as any);

    const res = await app.request("/api/envs/test-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", folders: [] }),
    });

    expect(res.status).toBe(200);
    expect(envManager.updateEnv).toHaveBeenCalledWith(
      "test-env",
      expect.objectContaining({ scope: "global", folders: [] }),
    );
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.updateEnv).mockReturnValue(null as any);

    const res = await app.request("/api/envs/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it("returns 400 when updateEnv throws", async () => {
    vi.mocked(envManager.updateEnv).mockImplementation(() => {
      throw new Error("Invalid slug");
    });

    const res = await app.request("/api/envs/test-env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid slug");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /api/envs/:slug
// ═══════════════════════════════════════════════════════════════════════════

describe("DELETE /api/envs/:slug", () => {
  it("deletes an environment and returns ok", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(true);

    const res = await app.request("/api/envs/test-env", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(envManager.deleteEnv).toHaveBeenCalledWith("test-env");
  });

  it("returns 404 when the environment does not exist", async () => {
    vi.mocked(envManager.deleteEnv).mockReturnValue(false);

    const res = await app.request("/api/envs/missing", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });
});
