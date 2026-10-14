/**
 * legacy-memory.ts lists the notes of a legacy Claude session's folder memory
 * and copies the chosen ones into a domain memory. Everything runs in temp
 * folders: the real ~/.claude and ~/companion_domain_* are never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyMemoryNotes,
  indexLine,
  invalidNoteFiles,
  isNoteFileName,
  listMemoryNotes,
  parseNote,
} from "./legacy-memory.js";

let root: string;
let src: string;
let dest: string;

const note = (name: string, description: string, type: string, body: string) =>
  `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "legacy-memory-"));
  src = join(root, "projects", "-w", "memory");
  dest = join(root, "companion_domain_herd", "memory");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "MEMORY.md"), "- [Deploy](deploy.md) — how to deploy\n");
  writeFileSync(join(src, "deploy.md"), note("Deploy", "how to deploy", "project", "Run the build, then rsync."));
  writeFileSync(join(src, "prefs.md"), note("Prefs", "user prefs", "feedback", "Reply in Italian."));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseNote", () => {
  // The fields the migration dialog shows come from the frontmatter; the
  // type sits under `metadata:` in Claude's notes (`node_type` must not match).
  it("reads name, description, metadata.type and the body preview", () => {
    expect(parseNote("deploy.md", note("Deploy", "how to deploy", "project", "Body text."))).toEqual({
      file: "deploy.md", name: "Deploy", description: "how to deploy", type: "project", preview: "Body text.",
    });
    // A top-level `type:` (older notes) works too.
    expect(parseNote("x.md", "---\nname: X\ntype: user\n---\nhi").type).toBe("user");
  });

  // A note without (or with broken) frontmatter must still be listable.
  it("falls back to the file name for malformed frontmatter", () => {
    expect(parseNote("loose-note.md", "---\nname: never closed\nbody")).toMatchObject({
      name: "loose-note", description: "", type: "", preview: "---\nname: never closed\nbody",
    });
    expect(parseNote("plain.md", "just text")).toMatchObject({ name: "plain", preview: "just text" });
  });

  it("caps the preview at about 300 characters", () => {
    const preview = parseNote("long.md", `---\nname: L\n---\n${"a".repeat(1000)}`).preview;
    expect(preview).toHaveLength(301);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("isNoteFileName", () => {
  // Strict names are what keeps the copy inside the two memory folders.
  it("accepts plain .md names only", () => {
    expect(isNoteFileName("deploy.md")).toBe(true);
    for (const bad of ["MEMORY.md", "../x.md", "a/b.md", ".hidden.md", "x.txt", "a\\b.md", 3, null]) {
      expect(isNoteFileName(bad)).toBe(false);
    }
  });
});

describe("listMemoryNotes", () => {
  it("lists the notes, not the index, sorted by file name", () => {
    const notes = listMemoryNotes(src);
    expect(notes.map((n) => n.file)).toEqual(["deploy.md", "prefs.md"]);
    expect(notes[0]).toMatchObject({ name: "Deploy", type: "project", preview: "Run the build, then rsync." });
    expect(notes[0]).not.toHaveProperty("existsInDomain");
  });

  // With a target domain, a file name already there is flagged (it would be skipped).
  it("marks the notes whose file name is already in the domain memory", () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "prefs.md"), "other");
    const notes = listMemoryNotes(src, dest);
    expect(notes.map((n) => [n.file, n.existsInDomain])).toEqual([["deploy.md", false], ["prefs.md", true]]);
  });

  it("returns no notes for a missing folder", () => {
    expect(listMemoryNotes(join(root, "nope"))).toEqual([]);
  });

  // A symlink pointing outside the memory folder must not leak a foreign file.
  it("ignores symlinks escaping the folder but keeps ones inside it", () => {
    writeFileSync(join(root, "secret.md"), "secret");
    symlinkSync(join(root, "secret.md"), join(src, "escape.md"));
    symlinkSync(join(src, "deploy.md"), join(src, "alias.md"));
    expect(listMemoryNotes(src).map((n) => n.file)).toEqual(["alias.md", "deploy.md", "prefs.md"]);
  });
});

describe("invalidNoteFiles", () => {
  it("accepts names present in the folder and rejects anything else", () => {
    expect(invalidNoteFiles(src, ["deploy.md"])).toBeNull();
    expect(invalidNoteFiles(src, [])).toMatch(/non-empty/);
    expect(invalidNoteFiles(src, "deploy.md")).toMatch(/non-empty/);
    expect(invalidNoteFiles(src, ["../deploy.md"])).toMatch(/Invalid note file name/);
    expect(invalidNoteFiles(src, ["MEMORY.md"])).toMatch(/Invalid note file name/);
    expect(invalidNoteFiles(src, ["ghost.md"])).toMatch(/Not a note/);
  });
});

describe("copyMemoryNotes", () => {
  // The domain folder may not exist yet (a fresh domain): it is created with
  // its index, and every copied note gets one index line.
  it("copies notes into a new domain memory and indexes them", () => {
    expect(copyMemoryNotes(src, dest, ["deploy.md", "prefs.md"])).toEqual({ copied: ["deploy.md", "prefs.md"], skipped: [] });
    expect(readFileSync(join(dest, "deploy.md"), "utf-8")).toBe(readFileSync(join(src, "deploy.md"), "utf-8"));
    expect(readFileSync(join(dest, "MEMORY.md"), "utf-8")).toBe(
      "- [Deploy](deploy.md) — how to deploy\n- [Prefs](prefs.md) — user prefs\n",
    );
    // Copy, never move: the source folder is untouched.
    expect(existsSync(join(src, "deploy.md"))).toBe(true);
  });

  // Never overwrite a domain note: same file name = skipped with a reason, and no index line.
  it("skips files already in the domain memory and appends to an existing index", () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "prefs.md"), "domain version");
    writeFileSync(join(dest, "MEMORY.md"), "- [Other](other.md) — x");
    const result = copyMemoryNotes(src, dest, ["prefs.md", "deploy.md", "deploy.md"]);
    expect(result.copied).toEqual(["deploy.md"]);
    expect(result.skipped).toEqual([{ file: "prefs.md", reason: "A note with this file name is already in the domain memory" }]);
    expect(readFileSync(join(dest, "prefs.md"), "utf-8")).toBe("domain version");
    expect(readFileSync(join(dest, "MEMORY.md"), "utf-8")).toBe("- [Other](other.md) — x\n- [Deploy](deploy.md) — how to deploy\n");
  });

  it("creates an empty index when nothing was copied and does not duplicate index lines", () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "deploy.md"), "x");
    copyMemoryNotes(src, dest, ["deploy.md"]);
    expect(readFileSync(join(dest, "MEMORY.md"), "utf-8")).toBe("");

    const other = join(root, "other-domain");
    mkdirSync(other);
    writeFileSync(join(other, "MEMORY.md"), "- [Deploy](deploy.md) — already indexed\n");
    copyMemoryNotes(src, other, ["deploy.md"]);
    expect(readFileSync(join(other, "MEMORY.md"), "utf-8")).toBe("- [Deploy](deploy.md) — already indexed\n");
  });

  // Errors other than "already there" are reported per file, not thrown.
  it("reports a file it could not write", () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "MEMORY.md"), "");
    chmodSync(dest, 0o555);
    try {
      const result = copyMemoryNotes(src, dest, ["deploy.md"]);
      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([{ file: "deploy.md", reason: expect.stringMatching(/EACCES|permission/i) }]);
    } finally {
      chmodSync(dest, 0o755);
    }
  });
});

describe("indexLine", () => {
  it("formats the MEMORY.md line, without a dash when there is no description", () => {
    expect(indexLine({ file: "a.md", name: "A [x]", description: "d" })).toBe("- [A x](a.md) — d");
    expect(indexLine({ file: "a.md", name: "A", description: "" })).toBe("- [A](a.md)");
  });
});
