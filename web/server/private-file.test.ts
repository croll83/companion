import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFile } from "./private-file.js";

/**
 * Owner-only state files: new files and dirs get 0600/0700, and files left
 * world-readable by older versions are repaired on the next write.
 */

let root: string;
const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "private-file-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writePrivateFile", () => {
  it("creates the file 0600", () => {
    const path = join(root, "a.json");
    writePrivateFile(path, "{}");
    expect(readFileSync(path, "utf-8")).toBe("{}");
    expect(mode(path)).toBe(PRIVATE_FILE_MODE);
  });

  // `mode` in writeFileSync only applies on creation: an existing 0644 file
  // must be tightened too.
  it("tightens an existing world-readable file", () => {
    const path = join(root, "old.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);
    writePrivateFile(path, "new");
    expect(readFileSync(path, "utf-8")).toBe("new");
    expect(mode(path)).toBe(0o600);
  });
});

describe("ensurePrivateDir", () => {
  it("creates the directory 0700, nested", () => {
    const dir = join(root, "a", "b");
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(PRIVATE_DIR_MODE);
  });

  it("tightens an existing directory and the files with the given suffix", () => {
    const dir = join(root, "agents");
    mkdirSync(dir, { mode: 0o775 });
    chmodSync(dir, 0o775);
    writeFileSync(join(dir, "x.json"), "{}");
    chmodSync(join(dir, "x.json"), 0o644);
    writeFileSync(join(dir, "notes.txt"), "keep");
    chmodSync(join(dir, "notes.txt"), 0o644);

    ensurePrivateDir(dir, { fileSuffix: ".json" });

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "x.json"))).toBe(0o600);
    expect(mode(join(dir, "notes.txt"))).toBe(0o644);
  });

  it("leaves files alone without a suffix", () => {
    const dir = join(root, "w");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.json"), "{}");
    chmodSync(join(dir, "x.json"), 0o644);
    ensurePrivateDir(dir);
    expect(mode(join(dir, "x.json"))).toBe(0o644);
  });
});
