/**
 * Redaction for learning text, before anything is stored. Learnings are written from PR comments
 * and model proposals, so they're scanned by pattern for credentials and personal data: there's
 * no list of known secrets to match, as there is for a harness transcript.
 *
 * Each match is replaced with `[redacted <kind>]`, so a learning still reads as a sentence.
 */

/** What was found and replaced. */
export type RedactionKind =
  | "private key"
  | "token"
  | "aws key"
  | "jwt"
  | "credential in url"
  | "secret value"
  | "email"
  | "phone number"
  | "card number";

interface Pattern {
  kind: RedactionKind;
  pattern: RegExp;
  /** Which capture group holds the sensitive part; the whole match when left out. */
  group?: number;
  /** Extra check on the match (card numbers: Luhn). */
  check?: (value: string) => boolean;
}

/** Ordered: a private key block before the tokens inside it, URLs before emails. */
const PATTERNS: readonly Pattern[] = [
  {
    kind: "private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  {
    kind: "token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,})/g,
  },
  { kind: "aws key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: "credential in url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi,
    group: 1,
  },
  {
    kind: "secret value",
    // `password = hunter2`, `"apiKey": "…"`, `token: …`, `Authorization: Bearer …`.
    pattern:
      /\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|private[_-]?key|token|auth(?:orization)?|client[_-]?secret|credentials?)\b["']?\s*[:=]\s*(?:bearer\s+|basic\s+)?["']?([^\s"',;]{6,})/gi,
    group: 1,
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "card number",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (value) => luhn(value.replace(/\D/g, "")),
  },
  {
    kind: "phone number",
    // International (+31 6 1234 5678) or North American ((555) 123-4567) forms only, so
    // version numbers, line numbers and dates aren't taken for phones.
    pattern: /(?:\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}|\(\d{3}\)\s?\d{3}[ .-]\d{4})\b/g,
    check: (value) => {
      const digits = value.replace(/\D/g, "").length;
      return digits >= 8 && digits <= 15;
    },
  },
];

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * The text with credentials and personal data replaced, and what kinds were found (each once,
 * in the order of `PATTERNS`).
 */
export function redactSensitive(text: string): { text: string; found: RedactionKind[] } {
  const found: RedactionKind[] = [];
  let out = text;
  for (const { kind, pattern, group, check } of PATTERNS) {
    out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
      if (check !== undefined && !check(match)) return match;
      if (!found.includes(kind)) found.push(kind);
      const label = `[redacted ${kind}]`;
      if (group === undefined) return label;
      const part = rest[group - 1];
      return typeof part === "string" && part.length > 0 ? match.replace(part, label) : label;
    });
  }
  return { text: out, found };
}
