import { describe, it, expect } from "vitest";
// The module's boot is guarded by `import.meta.main`, so importing it here does
// not start the bot — only the pure helpers are exercised.
import { safeName } from "./telegram-bridge-child.js";

describe("safeName (attachment filename hardening)", () => {
  it("keeps a normal filename", () => {
    expect(safeName("report.pdf", ".pdf")).toBe("report.pdf");
  });

  it("strips directory components (basename)", () => {
    expect(safeName("/etc/passwd", ".bin")).toBe("passwd");
    expect(safeName("sub/dir/file.csv", ".csv")).toBe("file.csv");
  });

  it("neutralizes path-traversal names — never returns '.' or '..'", () => {
    // A traversal attempt must not escape or target the inbox directory itself.
    for (const evil of ["..", ".", "../../etc/passwd", "..\\..\\evil"]) {
      const out = safeName(evil, ".bin");
      expect(out).not.toBe("..");
      expect(out).not.toBe(".");
      expect(out.includes("/")).toBe(false);
      expect(out.includes("\\")).toBe(false);
    }
  });

  it("strips leading dots (no dotfiles / '..evil')", () => {
    expect(safeName("..evil", ".bin")).toBe("evil");
    expect(safeName(".bashrc", ".bin")).toBe("bashrc");
  });

  it("replaces shell/markdown metacharacters with underscores", () => {
    // Backticks/newlines would otherwise let a filename break the injected note.
    const out = safeName("a`whoami`\n$(id).pdf", ".pdf");
    expect(out).not.toMatch(/[`\n$()]/);
    expect(out.includes("/")).toBe(false);
  });

  it("falls back for empty / all-punctuation names", () => {
    expect(safeName("", ".pdf")).toMatch(/^file-\d+\.pdf$/);
    expect(safeName("...", ".bin")).toMatch(/^file-\d+\.bin$/);
  });

  it("caps length at 120 chars", () => {
    expect(safeName("x".repeat(500) + ".pdf", ".pdf").length).toBe(120);
  });
});
