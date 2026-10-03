/**
 * Render the model's Markdown into something Telegram displays properly.
 *
 * The bridge used to send with no `parse_mode` at all, so Telegram printed the
 * source verbatim — `**bold**`, `### heading` and fence backticks all visible.
 *
 * We target Telegram's **HTML** parse mode rather than MarkdownV2 on purpose:
 * MarkdownV2 requires escaping ~18 characters anywhere outside an entity, and a
 * single missed one makes Telegram reject the whole message with HTTP 400 — the
 * answer would be lost. HTML needs only `&`, `<` and `>` escaped and supports a
 * small, stable tag set, so it is far harder to get wrong. The caller still
 * falls back to plain text if Telegram refuses.
 *
 * Deliberate omission: `_underscore italic_` is NOT converted. In a coding
 * conversation `spot_follower_sleeve` is vastly more common than intentional
 * underscore emphasis, and treating it as markup would mangle identifiers.
 * Asterisk italics still work.
 */

const FENCE_RE = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Markdown -> Telegram HTML. Code spans/blocks keep their contents verbatim. */
export function mdToTelegramHtml(md: string): string {
  const fences: string[] = [];
  const inlines: string[] = [];

  // 1. Pull code out first so markdown inside it is never interpreted.
  let s = md.replace(FENCE_RE, (_m, lang: string, body: string) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    fences.push(`<pre><code${cls}>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000F${fences.length - 1}\u0000`;
  });
  s = s.replace(INLINE_CODE_RE, (_m, body: string) => {
    inlines.push(`<code>${escapeHtml(body)}</code>`);
    return `\u0000I${inlines.length - 1}\u0000`;
  });

  // 2. Escape everything else exactly once.
  s = escapeHtml(s);

  // 3. Block level.
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "<b>$1</b>");
  s = s.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "—");
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  s = s.replace(/^\s{0,3}&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");

  // 4. Inline. Bold before italic so ** isn't eaten by the * rule.
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

  // 5. Put code back.
  s = s.replace(/\u0000I(\d+)\u0000/g, (_m, i: string) => inlines[Number(i)]);
  s = s.replace(/\u0000F(\d+)\u0000/g, (_m, i: string) => fences[Number(i)]);
  return s.trim();
}

/** Readable plain text: used when Telegram refuses our HTML. */
export function stripMarkdown(md: string): string {
  let s = md.replace(FENCE_RE, (_m, _l, body: string) => body.replace(/\n$/, ""));
  s = s.replace(INLINE_CODE_RE, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "$1");
  s = s.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "—");
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "$1").replace(/__([^\n]+?)__/g, "$1");
  s = s.replace(/~~([^\n]+?)~~/g, "$1");
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/g, "$1$2");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
  return s.trim();
}

/**
 * Split HTML into Telegram-sized pieces without ever cutting a tag in half.
 * A `<pre>` block spanning a boundary is closed and reopened so each piece is
 * valid on its own — otherwise Telegram rejects the fragment.
 */
export function splitTelegramHtml(html: string, limit: number): string[] {
  if (html.length <= limit) return html ? [html] : [];
  const out: string[] = [];
  let rest = html;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Never break inside a tag: retreat to before any unclosed '<'.
    const lastOpen = window.lastIndexOf("<");
    const lastClose = window.lastIndexOf(">");
    let hardMax = lastOpen > lastClose ? lastOpen : window.length;
    // Prefer a newline, then a space, for a natural break.
    const nl = rest.lastIndexOf("\n", hardMax);
    const sp = rest.lastIndexOf(" ", hardMax);
    let cut = nl > limit * 0.5 ? nl : sp > limit * 0.5 ? sp : hardMax;
    if (cut <= 0) cut = hardMax > 0 ? hardMax : limit;

    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, "");

    // Balance a <pre><code> that the cut left open.
    const opens = (piece.match(/<pre>/g) || []).length;
    const closes = (piece.match(/<\/pre>/g) || []).length;
    if (opens > closes) {
      const hadCode = /<pre><code[^>]*>(?![\s\S]*<\/code>)/.test(piece);
      piece += hadCode ? "</code></pre>" : "</pre>";
      rest = (hadCode ? "<pre><code>" : "<pre>") + rest;
    }
    out.push(piece.trim());
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
