import { describe, it, expect } from "vitest";
import {
  CLI_BRIDGE_MODES,
  CLI_BRIDGE_MODE_ERROR,
  DEFAULT_CLI_BRIDGE_MODE,
  isCliBridgeMode,
} from "./cli-bridge-mode.js";

describe("cli-bridge-mode", () => {
  // The list is the single source of truth for every layer (settings
  // normalization, route validation, UI). It must contain the recommended
  // "stdio" mode plus all legacy values so existing settings keep loading.
  it("lists stdio and every legacy mode", () => {
    expect([...CLI_BRIDGE_MODES]).toEqual(["loopback", "jsonHandoff", "tlsLoopback", "stdio"]);
  });

  // The default is unchanged for backward compatibility and must itself be valid.
  it("defaults to a valid mode (loopback)", () => {
    expect(DEFAULT_CLI_BRIDGE_MODE).toBe("loopback");
    expect(isCliBridgeMode(DEFAULT_CLI_BRIDGE_MODE)).toBe(true);
  });

  // The guard accepts exactly the listed modes.
  it.each(CLI_BRIDGE_MODES)("accepts %s", (mode) => {
    expect(isCliBridgeMode(mode)).toBe(true);
  });

  // ...and rejects anything else: unknown strings, wrong case, non-strings.
  it.each([["sdk"], ["STDIO"], [""], [undefined], [null], [1], [{}]])("rejects %j", (value) => {
    expect(isCliBridgeMode(value)).toBe(false);
  });

  // The validation error is derived from the list, so it can never go stale
  // the way the old hand-written message (missing 'stdio') did.
  it("builds the error message from the list", () => {
    expect(CLI_BRIDGE_MODE_ERROR).toBe(
      "cliBridgeMode must be one of: 'loopback', 'jsonHandoff', 'tlsLoopback', 'stdio'",
    );
  });
});
