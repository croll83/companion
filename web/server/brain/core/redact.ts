// Secret and personal-data detection. Used two ways:
// - on every MCP read, when BRAIN_REDACT_SECRETS is true, secrets found in
//   wiki text are replaced before the text reaches the model;
// - on every inbox write, secrets and personal data make the note rejected
//   (always, whatever the redaction setting).
// Rules are deterministic regexes; findings carry the rule name, never the value.

export interface Finding {
  rule: string;
  kind: "secret" | "personal";
}

interface Rule {
  name: string;
  kind: "secret" | "personal";
  re: RegExp;
  /** Optional extra check on the match (checksums cut false positives). */
  accept?: (m: RegExpExecArray) => boolean;
  /** Group to replace when only a value inside the match is secret. */
  group?: number;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const PLACEHOLDER = /^(<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\*+|x+|\.\.\.|…|changeme|example|redacted|tbd|todo|none|null|password|passwd|secret|pass|pwd|your[_-]?\w*)$/i;
/** A value that names something (env variable, file, path) rather than being the secret. */
const REFERENCE = (v: string) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) || /^(?:\/|~|\.\/|\$)/.test(v) || /\.(?:env|ya?ml|json|properties|conf|txt|toml|ini|md)$/i.test(v);

const SECRET_RULES: Rule[] = [
  { name: "private-key", kind: "secret", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key-id", kind: "secret", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "jwt", kind: "secret", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "anthropic-key", kind: "secret", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", kind: "secret", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", kind: "secret", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { name: "slack-token", kind: "secret", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-api-key", kind: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "huggingface-token", kind: "secret", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "tailscale-key", kind: "secret", re: /\btskey-[a-z]+-[A-Za-z0-9-]{20,}/g },
  { name: "telegram-bot-token", kind: "secret", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g },
  { name: "connection-string-password", kind: "secret", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mqtt|https?):\/\/[^:\s/@]+:([^@\s]{3,})@/gi, group: 1 },
  { name: "bearer-token", kind: "secret", re: /\bBearer\s+([A-Za-z0-9_\-+/=.]{16,})/g, group: 1, accept: (m) => /\d/.test(m[1]) && /[A-Za-z]/.test(m[1]) },
  // Passwords given on a command line: sshpass -p '...', mysql -p..., redis-cli -a ..., tpm2_unseal -p "...".
  {
    name: "cli-password",
    kind: "secret",
    re: /\b(?:sshpass|tpm2_unseal|mysql|mysqladmin|mysqldump|redis-cli)\b[^\n|]*?\s-(?:p|a)\s*(['"]?)([^'"\s]{4,})\1/g,
    group: 2,
    accept: (m) => !PLACEHOLDER.test(m[2]),
  },
  // Markdown prose: "password `value`", "SSID `x` / password `y`", "login `user` / `value`".
  {
    name: "inline-password",
    kind: "secret",
    re: /\b(?:password|passwd|pwd|psw|passphrase|psk|login\s+`[^`\n]{1,40}`\s*\/)[^`\n]{0,12}?`([^`\n]{4,64})`/gi,
    group: 1,
    accept: (m) => !PLACEHOLDER.test(m[1]) && !REFERENCE(m[1]) && !/\s/.test(m[1]),
  },
  {
    name: "assigned-secret",
    kind: "secret",
    re: /\b(?:password|passwd|pwd|passphrase|psk|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|bot[_-]?token|auth[_-]?token)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.]{12,})/gi,
    group: 1,
    accept: (m) => !PLACEHOLDER.test(m[1]) && !REFERENCE(m[1]) && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1]),
  },
];

const PERSONAL_RULES: Rule[] = [
  { name: "iban", kind: "personal", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, accept: (m) => ibanOk(m[0]) },
  { name: "card-number", kind: "personal", re: /\b(?:\d[ -]?){13,19}\b/g, accept: (m) => luhn(m[0].replace(/\D/g, "")) },
  { name: "phone-number", kind: "personal", re: /(?:\+|\b00)\d{1,3}[ .-]?\(?\d{2,4}\)?(?:[ .-]?\d{2,4}){2,4}\b/g },
  { name: "tax-code-it", kind: "personal", re: /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/g },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function scan(text: string, rules: Rule[]): Finding[] {
  const found: Finding[] = [];
  for (const r of rules) {
    r.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.re.exec(text))) {
      if (!r.accept || r.accept(m)) {
        found.push({ rule: r.name, kind: r.kind });
        break;
      }
    }
  }
  return found;
}

export function findSecrets(text: string): Finding[] {
  return scan(text, SECRET_RULES);
}

/** Personal data; e-mail addresses count unless their domain (or a parent domain) is allowed. */
export function findPersonalData(text: string, allowedEmailDomains: string[] = []): Finding[] {
  const found = scan(text, PERSONAL_RULES);
  for (const m of text.matchAll(EMAIL_RE)) {
    const domain = m[1].toLowerCase();
    if (!allowedEmailDomains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      found.push({ rule: "email-address", kind: "personal" });
      break;
    }
  }
  return found;
}

/** Replace secrets with [REDACTED:<rule>]. Returns the text and the rules that fired. */
export function redactSecrets(text: string): { text: string; rules: string[] } {
  let out = text;
  const rules = new Set<string>();
  for (const r of SECRET_RULES) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, (...args) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as (string | undefined)[];
      const m = Object.assign([match, ...groups], { index: 0, input: out }) as unknown as RegExpExecArray;
      if (r.accept && !r.accept(m)) return match;
      rules.add(r.name);
      const tag = `[REDACTED:${r.name}]`;
      if (r.group && groups[r.group - 1]) return match.replace(groups[r.group - 1] as string, tag);
      return tag;
    });
  }
  return { text: out, rules: [...rules] };
}

/** The redaction the server applies to tool output: real, or a no-op when disabled. */
export function redactor(enabled: boolean): (text: string) => { text: string; rules: string[] } {
  return enabled ? redactSecrets : (text) => ({ text, rules: [] });
}

/**
 * Wrap wiki or source text as untrusted data. Any sequence that could close or
 * open the envelope is neutralised so the content cannot fake its own end.
 */
export function envelope(path: string, text: string, kind: "page" | "source"): string {
  const safe = text.replace(/<\/?\s*brain_(source|page)/gi, (s) => s.replace("<", "‹"));
  const tag = kind === "page" ? "brain_page" : "brain_source";
  return `<${tag} path="${path.replace(/"/g, "")}" trust="data">\n${safe}\n</${tag}>`;
}
