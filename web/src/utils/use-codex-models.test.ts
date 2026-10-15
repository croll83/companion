// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * The Codex catalogue for pickers that work before any session exists.
 * Validates: it is fetched only while enabled, an empty or failed answer
 * stays null (callers then fall back to the static list and treat effort
 * levels as unknown), and an answer after unmount is dropped.
 */
const getBackendModels = vi.hoisted(() => vi.fn());
vi.mock("../api.js", () => ({ api: { getBackendModels } }));

import { useCodexModels } from "./use-codex-models.js";

beforeEach(() => getBackendModels.mockReset());

describe("useCodexModels", () => {
  it("fetches the catalogue only while enabled", async () => {
    const models = [{ value: "gpt-6.1-sol", label: "Sol", description: "", efforts: ["low"] }];
    getBackendModels.mockResolvedValue(models);
    const { result, rerender } = renderHook(({ on }) => useCodexModels(on), { initialProps: { on: false } });
    expect(getBackendModels).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ on: true });
    await waitFor(() => expect(result.current).toEqual(models));
    expect(getBackendModels).toHaveBeenCalledWith("codex");
  });

  it("stays null without a catalogue (empty list or 404)", async () => {
    getBackendModels.mockResolvedValueOnce([]);
    const empty = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(getBackendModels).toHaveBeenCalledTimes(1));
    expect(empty.result.current).toBeNull();

    getBackendModels.mockRejectedValueOnce(new Error("Codex models cache not found"));
    const missing = renderHook(() => useCodexModels(true));
    await waitFor(() => expect(getBackendModels).toHaveBeenCalledTimes(2));
    expect(missing.result.current).toBeNull();
  });

  it("ignores an answer that arrives after unmount", async () => {
    let resolve!: (v: unknown) => void;
    getBackendModels.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useCodexModels(true));
    unmount();
    resolve([{ value: "x", label: "x", description: "" }]);
    await Promise.resolve();
    expect(result.current).toBeNull();
  });
});
