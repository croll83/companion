import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point COMPANION_HOME at a throwaway dir so saveAttachment never touches ~/.companion.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("./paths.js", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-store-"));
  return { COMPANION_HOME: home.dir };
});

import {
  safeAttachmentName, attachmentNote, INLINE_IMAGE_TYPES, uploadsDir, saveAttachment,
} from "./attachment-store.js";

afterAll(() => { if (home.dir) rmSync(home.dir, { recursive: true, force: true }); });

describe("safeAttachmentName", () => {
  it("keeps a normal filename", () => {
    expect(safeAttachmentName("report.pdf", "application/pdf")).toBe("report.pdf");
  });
  it("strips any directory component (path traversal)", () => {
    expect(safeAttachmentName("../../etc/passwd", "application/pdf")).toBe("passwd");
    expect(safeAttachmentName("/etc/shadow", "application/pdf")).toBe("shadow");
  });
  it("refuses to produce a dotfile or a bare dot name", () => {
    expect(safeAttachmentName("..", "application/pdf")).toMatch(/^attachment-\d+\.pdf$/);
    expect(safeAttachmentName(".bashrc", "application/pdf")).toBe("bashrc");
  });
  it("strips shell metacharacters", () => {
    expect(safeAttachmentName("a`whoami`$(id).pdf", "application/pdf")).not.toMatch(/[`$()]/);
  });
  it("falls back when the name is empty, and caps the length", () => {
    expect(safeAttachmentName("", "application/pdf")).toMatch(/^attachment-\d+\.pdf$/);
    expect(safeAttachmentName("x".repeat(400) + ".pdf", "application/pdf").length).toBe(120);
  });
});

describe("safeAttachmentName fallback extension", () => {
  it("strips leading dots even when the rest is usable", () => {
    expect(safeAttachmentName("..png", "image/png")).toBe("png");
  });
  it("falls back to a generated, non-hidden name when only dots/spaces remain (non-PDF)", () => {
    // extname(" . ") is "." so the generated name may end in a bare dot; what
    // matters is that it is generated, flat and not a dotfile.
    const n = safeAttachmentName(" . ", "text/plain");
    expect(n).toMatch(/^attachment-\d+/);
    expect(n).not.toMatch(/[\/\s]/);
  });
  it("uses .bin when there is no name and the type is not PDF", () => {
    expect(safeAttachmentName(undefined, "application/octet-stream")).toMatch(/^attachment-\d+\.bin$/);
  });
});

describe("uploadsDir", () => {
  it("lives under COMPANION_HOME/uploads/<session>, outside any repo", () => {
    expect(uploadsDir("sess-1")).toBe(join(home.dir, "uploads", "sess-1"));
  });
});

describe("saveAttachment", () => {
  it("decodes base64, writes the bytes under the session dir and reports metadata", () => {
    const payload = Buffer.from("%PDF-1.4 hello");
    const saved = saveAttachment("sess-save", {
      data: payload.toString("base64"), media_type: "application/pdf", name: "../evil/report.pdf",
    });
    expect(saved.name).toBe("report.pdf");                 // traversal stripped
    expect(saved.bytes).toBe(payload.length);
    expect(saved.mediaType).toBe("application/pdf");
    expect(saved.path.startsWith(join(home.dir, "uploads", "sess-save") + "/")).toBe(true);
    expect(saved.path).toMatch(/\/\d+-report\.pdf$/);    // timestamp prefix
    expect(readFileSync(saved.path)).toEqual(payload);
  });

  it("never clobbers an earlier upload with the same filename", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const a = saveAttachment("sess-dup", { data: Buffer.from("one").toString("base64"), media_type: "text/plain", name: "n.txt" });
      vi.setSystemTime(2_000);
      const b = saveAttachment("sess-dup", { data: Buffer.from("two").toString("base64"), media_type: "text/plain", name: "n.txt" });
      expect(a.path).not.toBe(b.path);
      expect(readdirSync(join(home.dir, "uploads", "sess-dup")).sort()).toEqual(["1000-n.txt", "2000-n.txt"]);
      expect(readFileSync(a.path, "utf-8")).toBe("one");
      expect(readFileSync(b.path, "utf-8")).toBe("two");
    } finally { vi.useRealTimers(); }
  });
});

describe("attachmentNote", () => {
  it("is empty when nothing was saved (message text stays untouched)", () => {
    expect(attachmentNote([])).toBe("");
  });
  it("lists the absolute path so the model can read the file", () => {
    const note = attachmentNote([
      { path: "/home/u/.companion/uploads/s1/1-report.pdf", name: "report.pdf", bytes: 12, mediaType: "application/pdf" },
    ]);
    expect(note).toContain("/home/u/.companion/uploads/s1/1-report.pdf");
    expect(note).toContain("report.pdf");
    expect(note).toContain("[File allegato salvato su disco, leggilo da lì:]"); // singular
    expect(note).toContain("(report.pdf, application/pdf, 12 byte)");
  });
  it("uses the plural form for several files and omits an empty media type", () => {
    const note = attachmentNote([
      { path: "/a/1-x.bin", name: "x.bin", bytes: 1, mediaType: "" },
      { path: "/a/2-y.pdf", name: "y.pdf", bytes: 2, mediaType: "application/pdf" },
    ]);
    expect(note.startsWith("\n\n[File allegati salvati su disco, leggili da lì:]\n")).toBe(true);
    expect(note).toContain("- `/a/1-x.bin` (x.bin, 1 byte)");
    expect(note).toContain("- `/a/2-y.pdf` (y.pdf, application/pdf, 2 byte)");
  });
});

describe("INLINE_IMAGE_TYPES", () => {
  it("covers what Codex takes inline, and excludes PDFs", () => {
    for (const t of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(INLINE_IMAGE_TYPES.has(t)).toBe(true);
    }
    expect(INLINE_IMAGE_TYPES.has("application/pdf")).toBe(false);
  });
});
