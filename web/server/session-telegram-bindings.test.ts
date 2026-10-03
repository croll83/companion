import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBinding,
  setBinding,
  removeBinding,
  getAllBindings,
  normalize,
  _resetForTest,
  type TelegramBinding,
} from "./session-telegram-bindings.js";

// Each test gets an isolated temp file so the real ~/.companion is never touched.
let dir: string;
let file: string;

const sample: TelegramBinding = {
  groupId: -1003574153485,
  topicId: 3,
  allowlist: [172751380, 393249644],
  requireMention: true,
  enabled: true,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-bindings-"));
  file = join(dir, "bindings.json");
  _resetForTest(file);
});

afterEach(() => {
  _resetForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("session-telegram-bindings store", () => {
  it("returns undefined for an unknown session", () => {
    expect(getBinding("nope")).toBeUndefined();
  });

  it("sets, persists to disk, and reads back a binding", () => {
    setBinding("sess-1", sample);
    expect(getBinding("sess-1")).toEqual(sample);
    // Persisted as pretty JSON keyed by sessionId.
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk["sess-1"]).toEqual(sample);
  });

  it("survives a reload from disk (fresh module state)", () => {
    setBinding("sess-1", sample);
    _resetForTest(file); // simulate process restart: drop in-memory, keep file
    expect(getBinding("sess-1")).toEqual(sample);
  });

  it("removeBinding deletes and reports whether it existed", () => {
    setBinding("sess-1", sample);
    expect(removeBinding("sess-1")).toBe(true);
    expect(getBinding("sess-1")).toBeUndefined();
    expect(removeBinding("sess-1")).toBe(false); // already gone
  });

  it("getAllBindings returns a copy (mutating it does not affect the store)", () => {
    setBinding("sess-1", sample);
    const all = getAllBindings();
    delete all["sess-1"];
    expect(getBinding("sess-1")).toEqual(sample); // store untouched
  });
});

describe("normalize()", () => {
  it("rejects non-objects and missing groupId", () => {
    expect(normalize(null)).toBeNull();
    expect(normalize("x")).toBeNull();
    expect(normalize({ topicId: 3 })).toBeNull(); // no groupId
  });

  it("defaults topicId to null and dedupes the allowlist", () => {
    const n = normalize({ groupId: -100, allowlist: [1, 1, 2] });
    expect(n).toMatchObject({ groupId: -100, topicId: null, allowlist: [1, 2] });
  });

  it("drops non-numeric allowlist entries", () => {
    const n = normalize({ groupId: -100, allowlist: [1, "two", null, 3] });
    expect(n?.allowlist).toEqual([1, 3]);
  });

  it("defaults requireMention to true when a topicId is present, false for DM", () => {
    expect(normalize({ groupId: -100, topicId: 3 })?.requireMention).toBe(true);
    expect(normalize({ groupId: 172751380 })?.requireMention).toBe(false);
  });

  it("defaults enabled to true", () => {
    expect(normalize({ groupId: -100 })?.enabled).toBe(true);
  });
});
