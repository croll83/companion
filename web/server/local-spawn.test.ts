import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The environment a LOCAL session's Claude Code starts with (local-spawn.ts):
 * the provider's proxy URL and shared token, the session header the proxy
 * keys its metrics by, the model alias resolved to the local model,
 * Anthropic credentials removed, no non-essential traffic, and the
 * context/autocompact variables found in Claude Code 2.1.303. Temp
 * COMPANION_HOME only.
 */

const h = vi.hoisted(() => ({ home: "" }));
vi.mock("./paths.js", () => ({
  get COMPANION_HOME() {
    return h.home;
  },
}));
vi.mock("./settings-manager.js", () => ({ getSettings: () => ({ localLlmEnabled: true }) }));

import { buildLocalSpawn, contextEnv, LOCAL_MODEL_ALIAS, NO_TOKEN_PLACEHOLDER } from "./local-spawn.js";
import { applyProxyInfo, createLocalProvider } from "./local-providers.js";

const SID = "11111111-2222-3333-4444-555555555555";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "local-spawn-"));
  h.home = join(tmp, "companion");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("buildLocalSpawn", () => {
  it("points Claude Code at the provider's proxy with the local model behind every alias", () => {
    const r = createLocalProvider({ name: "Lab", baseUrl: "http://proxy.example:8787", models: ["my-model"], token: "proxy-shared-token" });
    if (!r.ok) throw new Error(r.error);
    const spawn = buildLocalSpawn(SID, { provider: "lab", model: "my-model" });
    if ("error" in spawn) throw new Error(spawn.error);
    expect(spawn.modelAlias).toBe(LOCAL_MODEL_ALIAS);
    expect(spawn.disallowedTools).toEqual(["WebSearch"]);
    expect(spawn.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(spawn.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://proxy.example:8787",
      ANTHROPIC_AUTH_TOKEN: "proxy-shared-token",
      ANTHROPIC_CUSTOM_HEADERS: `X-Companion-Session: ${SID}`,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "my-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "my-model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "my-model",
      ANTHROPIC_SMALL_FAST_MODEL: "my-model",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "131072",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "131072",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    });
    // Credentials are explicitly unset (applied last in the launcher), never copied.
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      expect(k in spawn.env).toBe(true);
      expect(spawn.env[k]).toBeUndefined();
    }
  });

  // Without any credential Claude Code would fall back to the user's Anthropic login and send that OAuth token.
  it("always sets a credential, a placeholder when the proxy has no token", () => {
    const r = createLocalProvider({ name: "Open", baseUrl: "http://proxy.example:8787", models: ["m"] });
    if (!r.ok) throw new Error(r.error);
    const spawn = buildLocalSpawn(SID, { provider: "open", model: "m" });
    if ("error" in spawn) throw new Error(spawn.error);
    expect(spawn.env.ANTHROPIC_AUTH_TOKEN).toBe(NO_TOKEN_PLACEHOLDER);
  });

  // WebSearch stays only when the proxy answers it (its /info says webSearch: true), and goes again when it stops.
  it("keeps WebSearch when the provider's proxy has a search backend", () => {
    const r = createLocalProvider({ name: "Web", baseUrl: "http://proxy.example:8787", models: ["m"] });
    if (!r.ok) throw new Error(r.error);
    applyProxyInfo("web", { models: ["m"], webSearch: true, searchBackend: "tavily" });
    const on = buildLocalSpawn(SID, { provider: "web", model: "m" });
    if ("error" in on) throw new Error(on.error);
    expect(on.disallowedTools).toEqual([]);
    applyProxyInfo("web", { models: ["m"], webSearch: false, searchBackend: null });
    const off = buildLocalSpawn(SID, { provider: "web", model: "m" });
    if ("error" in off) throw new Error(off.error);
    expect(off.disallowedTools).toEqual(["WebSearch"]);
  });

  it("fails clearly when the provider was deleted", () => {
    expect(buildLocalSpawn(SID, { provider: "gone", model: "m" })).toEqual({ error: expect.stringContaining("no longer exists") });
  });
});

describe("contextEnv", () => {
  // A small window must not keep Claude Code's 32k max_tokens: vLLM refuses prompt + max_tokens > max_model_len.
  it("caps max output at a quarter of a small window", () => {
    expect(contextEnv({ contextWindow: 65536 })).toEqual({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "65536",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "65536",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384",
    });
  });
});
