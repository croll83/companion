import { describe, it, expect } from "vitest";
import { mdToTelegramHtml, stripMarkdown, splitTelegramHtml } from "./telegram-markdown.js";

describe("mdToTelegramHtml", () => {
  it("converts the formatting that was previously shown as raw source", () => {
    expect(mdToTelegramHtml("**bold**")).toBe("<b>bold</b>");
    expect(mdToTelegramHtml("### Verdetto")).toBe("<b>Verdetto</b>");
    expect(mdToTelegramHtml("- primo\n- secondo")).toBe("• primo\n• secondo");
    expect(mdToTelegramHtml("~~via~~")).toBe("<s>via</s>");
    expect(mdToTelegramHtml("[PR 92](https://github.com/x/y/pull/92)"))
      .toBe('<a href="https://github.com/x/y/pull/92">PR 92</a>');
  });

  it("keeps code verbatim and does not format inside it", () => {
    expect(mdToTelegramHtml("`a**b**c`")).toBe("<code>a**b**c</code>");
    const fenced = mdToTelegramHtml("```ts\nconst a = 1 < 2;\n```");
    expect(fenced).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it("escapes HTML so code and diffs can't break the message", () => {
    // A stray '<' used to be enough for Telegram to reject the whole send.
    expect(mdToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(mdToTelegramHtml("<script>alert(1)</script>"))
      .toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("leaves snake_case identifiers alone", () => {
    // The whole reason underscore-italics are not supported: in a coding chat
    // these are identifiers, not emphasis.
    expect(mdToTelegramHtml("spot_follower_sleeve_bootstrap"))
      .toBe("spot_follower_sleeve_bootstrap");
    expect(mdToTelegramHtml("chiama read_ledger e write_ledger"))
      .toBe("chiama read_ledger e write_ledger");
  });

  it("does not mistake a bullet for italics", () => {
    expect(mdToTelegramHtml("* voce")).toBe("• voce");
  });

  it("handles asterisk italics", () => {
    expect(mdToTelegramHtml("questo è *importante* davvero"))
      .toBe("questo è <i>importante</i> davvero");
  });
});

describe("stripMarkdown (the fallback)", () => {
  it("produces readable plain text with no markup left", () => {
    const out = stripMarkdown("### T\n**b** and `c`\n- x\n[l](https://e.com)");
    expect(out).not.toMatch(/[*`#]/);
    expect(out).toContain("T");
    expect(out).toContain("• x");
    expect(out).toContain("https://e.com");
  });
});

describe("splitTelegramHtml", () => {
  it("returns a single piece when it already fits", () => {
    expect(splitTelegramHtml("<b>hi</b>", 100)).toEqual(["<b>hi</b>"]);
    expect(splitTelegramHtml("", 100)).toEqual([]);
  });

  it("never cuts a tag in half", () => {
    const html = "x".repeat(40) + '<a href="https://example.com/very/long/path">link</a>' + "y".repeat(40);
    for (const piece of splitTelegramHtml(html, 50)) {
      // An odd '<' with no matching '>' after it means a tag was severed.
      const lastOpen = piece.lastIndexOf("<");
      const lastClose = piece.lastIndexOf(">");
      expect(lastClose, `severed tag in: ${piece}`).toBeGreaterThan(lastOpen - 1);
    }
  });

  it("closes and reopens a <pre> that spans a boundary", () => {
    const html = "<pre><code>" + "L".repeat(200) + "</code></pre>";
    const pieces = splitTelegramHtml(html, 80);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      // Each piece must be self-contained: Telegram rejects a dangling <pre>.
      expect((p.match(/<pre>/g) || []).length).toBe((p.match(/<\/pre>/g) || []).length);
    }
  });

  it("keeps every character of the original content", () => {
    const html = ("parola ".repeat(60)).trim();
    const joined = splitTelegramHtml(html, 50).join(" ").replace(/\s+/g, " ");
    expect(joined.replace(/\s/g, "")).toBe(html.replace(/\s/g, ""));
  });
});
