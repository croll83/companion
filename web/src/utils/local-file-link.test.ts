import { describe, it, expect } from "vitest";
import { parseLocalFileLink, fileKind, fileExtension } from "./local-file-link.js";

const ORIGIN = "https://companion.mintwork.it";

describe("parseLocalFileLink", () => {
  it("recognises the case this exists for", () => {
    // Exactly what a model produces: an absolute path resolved against our origin.
    expect(parseLocalFileLink(
      `${ORIGIN}/home/jarvis/sviluppo/hermes-billing-proxy/docs/anthropic-fixes-2026-09-22.md`,
      ORIGIN,
    )).toBe("/home/jarvis/sviluppo/hermes-billing-proxy/docs/anthropic-fixes-2026-09-22.md");
  });

  it("handles a bare absolute path (resolved against our origin)", () => {
    expect(parseLocalFileLink("/home/u/report.md", ORIGIN)).toBe("/home/u/report.md");
  });

  it("decodes percent-encoding, so spaces in names still open", () => {
    expect(parseLocalFileLink(`${ORIGIN}/home/u/my%20notes.md`, ORIGIN)).toBe("/home/u/my notes.md");
  });

  it("leaves genuinely external links alone", () => {
    for (const href of [
      "https://github.com/herdfi/herd/pull/92",
      "https://example.com/a/b.md",
      "mailto:x@y.z",
    ]) {
      expect(parseLocalFileLink(href, ORIGIN), href).toBeNull();
    }
  });

  it("never hijacks Companion's own URLs", () => {
    // A false positive here would break the app's own links and downloads.
    for (const href of [
      `${ORIGIN}/api/fs/raw?path=/x.md`,
      `${ORIGIN}/assets/index-abc.js`,
      `${ORIGIN}/#/docs`,
      `${ORIGIN}/`,
      `${ORIGIN}/settings`,          // no dot: an in-app route, not a file
      `${ORIGIN}/home/u/dir/`,       // trailing slash: a directory
    ]) {
      expect(parseLocalFileLink(href, ORIGIN), href).toBeNull();
    }
  });

  it("is safe on rubbish input", () => {
    expect(parseLocalFileLink(undefined, ORIGIN)).toBeNull();
    expect(parseLocalFileLink("", ORIGIN)).toBeNull();
    expect(parseLocalFileLink("not a url at all", ORIGIN)).toBeNull();
  });
});

describe("fileKind", () => {
  it("routes each family to the right renderer", () => {
    expect(fileKind("/a/b.md")).toBe("markdown");
    expect(fileKind("/a/b.MD")).toBe("markdown");
    expect(fileKind("/a/shot.jpeg")).toBe("image");
    expect(fileKind("/a/diagram.svg")).toBe("image");
    expect(fileKind("/a/server.log")).toBe("text");
    expect(fileKind("/a/main.ts")).toBe("text");
    expect(fileKind("/a/data.json")).toBe("text");
  });

  it("falls back to download for things a browser can't show", () => {
    expect(fileKind("/a/archive.zip")).toBe("binary");
    expect(fileKind("/a/report.pdf")).toBe("binary");
    expect(fileKind("/a/binary")).toBe("binary");
  });

  it("treats dotfiles by their name, not as extensionless", () => {
    expect(fileExtension("/a/.gitignore")).toBe("gitignore");
    expect(fileKind("/a/.gitignore")).toBe("text");
  });
});
