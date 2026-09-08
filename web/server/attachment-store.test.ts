import { describe, it, expect } from "vitest";
import { safeAttachmentName, attachmentNote, INLINE_IMAGE_TYPES } from "./attachment-store.js";

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
