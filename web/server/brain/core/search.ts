// BM25 over wiki pages and raw passages. Everything stays in memory (a wiki
// is a few MB at most), and no text is sent to an external embedding service.
//
// Stemming is chosen by the wiki's language (BRAIN_LANGUAGE):
//  - "it": light Italian folding (servizio/servizi, pagina/pagine share a stem);
//  - "en": a light English stemmer (plurals, -ing, -ed);
//  - "auto": both forms of every word go into the index (mixed wikis);
//  - "none": words as written.
// Stop words of the language are dropped ("auto" and "none": both lists).

import type { WikiSnapshot } from "./wiki.js";

export const LANGUAGES = ["auto", "it", "en", "none"] as const;
export type Language = (typeof LANGUAGES)[number];

const STOP_IT = "il lo la i gli le un uno una di a da in con su per tra fra e o ma se che non come piu più del della dei delle al alla ai alle dal dalla nel nella nei sul sulla è sono ha hanno essere questo questa quello quella cosa cos".split(" ");
const STOP_EN = "the a an of to in on for and or is are be with by as at from this that it its not".split(" ");
const STOP: Record<Language, Set<string>> = {
  it: new Set(STOP_IT),
  en: new Set(STOP_EN),
  auto: new Set([...STOP_IT, ...STOP_EN]),
  none: new Set([...STOP_IT, ...STOP_EN]),
};

/** Italian, light: drop the final vowel (or -io/-ia/-ie) of longer words (servizio/servizi → serviz, pagina/pagine → pagin). */
export function stemIt(t: string): string {
  if (t.length > 5 && /i[oae]$/.test(t)) return t.slice(0, -2);
  return t.length > 4 && /[aeio]$/.test(t) ? t.slice(0, -1) : t;
}

/** English, light: plurals, -ing and -ed; a doubled final consonant left behind is collapsed (running → run). */
export function stemEn(t: string): string {
  let s = t;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith("sses")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  const before = s;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  if (s !== before && /([bdfgkmnprt])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function tokenize(text: string, language: Language = "auto"): string[] {
  const norm = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const stop = STOP[language];
  const out: string[] = [];
  for (const t of norm.split(/[^a-z0-9]+/)) {
    if (t.length < 2 || stop.has(t)) continue;
    if (language === "it") out.push(stemIt(t));
    else if (language === "en") out.push(stemEn(t));
    else if (language === "none") out.push(t);
    else {
      const a = stemIt(t);
      const b = stemEn(t);
      out.push(a);
      if (b !== a) out.push(b);
    }
  }
  return out;
}

export interface Doc {
  id: string;
  kind: "page" | "raw";
  /** page slug or raw path */
  ref: string;
  title: string;
  fromLine: number;
  toLine: number;
  text: string;
  boost: Map<string, number>;
}

interface Indexed {
  doc: Doc;
  tf: Map<string, number>;
  len: number;
}

export interface Hit {
  kind: "page" | "raw";
  ref: string;
  title: string;
  fromLine: number;
  toLine: number;
  score: number;
  snippet: string;
}

const PASSAGE_LINES = 60;

function counts(tokens: string[], into = new Map<string, number>(), weight = 1): Map<string, number> {
  for (const t of tokens) into.set(t, (into.get(t) ?? 0) + weight);
  return into;
}

export class SearchIndex {
  private docs: Indexed[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  readonly language: Language;

  private constructor(language: Language) {
    this.language = language;
  }

  static build(w: WikiSnapshot, language: Language = "auto"): SearchIndex {
    const idx = new SearchIndex(language);
    const tok = (s: string) => tokenize(s, language);
    for (const p of w.pages.values()) {
      const boost = counts(tok(p.title), new Map(), 3);
      counts(tok(p.tags.join(" ")), boost, 2);
      counts(tok(p.slug.replace(/[-/]/g, " ")), boost, 2);
      idx.add({ id: `page:${p.slug}`, kind: "page", ref: p.slug, title: p.title, fromLine: 1, toLine: 0, text: p.body, boost });
    }
    for (const r of w.raw.values()) {
      if (r.text === null) continue;
      const lines = r.text.split("\n");
      const title = /^#\s+(.+)$/m.exec(r.text)?.[1]?.trim() ?? r.path;
      for (let i = 0; i < lines.length; i += PASSAGE_LINES) {
        const chunk = lines.slice(i, i + PASSAGE_LINES).join("\n");
        if (!chunk.trim()) continue;
        const boost = i === 0 ? counts(tok(title + " " + r.path), new Map(), 2) : new Map<string, number>();
        idx.add({
          id: `raw:${r.path}:${i + 1}`,
          kind: "raw",
          ref: r.path,
          title,
          fromLine: i + 1,
          toLine: Math.min(i + PASSAGE_LINES, lines.length),
          text: chunk,
          boost,
        });
      }
    }
    idx.finish();
    return idx;
  }

  private add(doc: Doc): void {
    const tf = counts(tokenize(doc.text, this.language));
    for (const [t, n] of doc.boost) tf.set(t, (tf.get(t) ?? 0) + n);
    let len = 0;
    for (const n of tf.values()) len += n;
    this.docs.push({ doc, tf, len });
  }

  private finish(): void {
    let total = 0;
    for (const d of this.docs) {
      total += d.len;
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  search(query: string, opts: { limit: number; includeRaw: boolean }): Hit[] {
    const q = [...new Set(tokenize(query, this.language))];
    if (q.length === 0) return [];
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const scored: { d: Indexed; s: number }[] = [];
    for (const d of this.docs) {
      if (!opts.includeRaw && d.doc.kind === "raw") continue;
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      if (s > 0) scored.push({ d, s: d.doc.kind === "page" ? s * 1.3 : s });
    }
    scored.sort((a, b2) => b2.s - a.s);
    // One hit per raw file: the best passage.
    const seen = new Set<string>();
    const hits: Hit[] = [];
    for (const { d, s } of scored) {
      const key = `${d.doc.kind}:${d.doc.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        kind: d.doc.kind,
        ref: d.doc.ref,
        title: d.doc.title,
        fromLine: d.doc.fromLine,
        toLine: d.doc.toLine,
        score: Math.round(s * 100) / 100,
        snippet: snippet(d.doc.text, q, this.language),
      });
      if (hits.length >= opts.limit) break;
    }
    return hits;
  }
}

export function snippet(text: string, qTokens: string[], language: Language = "auto", max = 320): string {
  const paras = text.split(/\n\s*\n/);
  let best = paras[0] ?? "";
  let bestScore = -1;
  const q = new Set(qTokens);
  for (const p of paras) {
    const s = tokenize(p, language).filter((t) => q.has(t)).length;
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  const flat = best.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
