import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Codex selectors, tested on the path production actually runs.
//
// The effort levels used to be computed only in attachCodexAdapterHandlers,
// which nothing in production calls; its tests passed while every Codex
// session reached the browser without levels. These go through
// attachBackendAdapter + routeBrowserMessage instead.

if (typeof globalThis.Bun === "undefined") {
  (globalThis as any).Bun = {
    hash(input: string | Uint8Array): number {
      const s = typeof input === "string" ? input : new TextDecoder().decode(input);
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
      return h >>> 0;
    },
  };
}

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
vi.mock("./settings-manager.js", () => ({
  getSettings: () => ({ aiValidationEnabled: false, aiValidationAutoApprove: false, aiValidationAutoDeny: false, anthropicApiKey: "" }),
  DEFAULT_ANTHROPIC_MODEL: "claude-sonnet-4-6",
}));

// Catalogue as Codex reports it: levels differ per model.
const LEVELS: Record<string, string[]> = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};
const DEFAULTS: Record<string, string> = { "gpt-6-astra": "medium", "gpt-6-luna": "low" };
vi.mock("./codex-models.js", () => ({
  getCodexEffortLevels: (m: string) => LEVELS[m] ?? [],
  getCodexDefaultEffort: (m: string) => DEFAULTS[m] ?? null,
}));

import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { companionBus } from "./event-bus.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let bridge: WsBridge;

function codexAdapter() {
  let onMessage: ((msg: any) => void) | undefined;
  const adapter = {
    isConnected: () => true,
    send: vi.fn(() => true),
    disconnect: async () => {},
    onBrowserMessage: (cb: (msg: any) => void) => { onMessage = cb; },
    onSessionMeta: () => {},
    onDisconnect: () => {},
    onInitError: () => {},
  };
  return { adapter, emit: (msg: any) => onMessage!(msg) };
}

function codexInit(model: string) {
  return { type: "session_init", session: { session_id: "s1", backend_type: "codex", model } };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-live-"));
  bridge = new WsBridge();
  bridge.setStore(new SessionStore(tempDir));
  companionBus.clear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Codex effort on the live path", () => {
  it("sends the model's effort levels with the session", () => {
    const browser = { data: { kind: "browser", sessionId: "s1" }, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    bridge.getOrCreateSession("s1", "codex");
    bridge.handleBrowserOpen(browser, "s1");
    const { adapter, emit } = codexAdapter();
    bridge.attachBackendAdapter("s1", adapter as any, "codex");
    browser.send.mockClear();

    emit(codexInit("gpt-6-astra"));

    const session = bridge.getSession("s1")!;
    expect(session.state.supportedEfforts).toEqual(LEVELS["gpt-6-astra"]);
    expect(session.state.effort).toBe("medium"); // the model's own default
    // The browser must get them in the same session_init, not later.
    const init = browser.send.mock.calls
      .map(([m]: [string]) => JSON.parse(m))
      .find((m: any) => m.type === "session_init");
    expect(init.session.supportedEfforts).toEqual(LEVELS["gpt-6-astra"]);
  });

  it("settles an effort the new model lacks on its default", () => {
    bridge.getOrCreateSession("s1", "codex");
    const { adapter, emit } = codexAdapter();
    bridge.attachBackendAdapter("s1", adapter as any, "codex");
    const session = bridge.getSession("s1")!;
    session.state.effort = "ultra"; // valid on Astra, not on Luna

    emit(codexInit("gpt-6-luna"));

    expect(session.state.supportedEfforts).toEqual(LEVELS["gpt-6-luna"]);
    expect(session.state.effort).toBe("low");
  });
});

describe("Codex model switch", () => {
  it("routes set_model to a relaunch instead of the adapter that rejects it", () => {
    const modelChange = vi.fn();
    companionBus.on("session:model-change", modelChange);
    const browser = { data: { kind: "browser", sessionId: "s1" }, send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
    bridge.getOrCreateSession("s1", "codex");
    bridge.handleBrowserOpen(browser, "s1");
    const { adapter, emit } = codexAdapter();
    bridge.attachBackendAdapter("s1", adapter as any, "codex");
    emit(codexInit("gpt-6-astra"));

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "set_model", model: "gpt-6-luna" }));

    expect(modelChange).toHaveBeenCalledWith({ sessionId: "s1", model: "gpt-6-luna" });
    // Never handed to the Codex adapter, which would drop it with a warning.
    expect(adapter.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "set_model" }));
  });
});
