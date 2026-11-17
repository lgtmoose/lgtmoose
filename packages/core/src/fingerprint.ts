import { createHash } from "node:crypto";

/**
 * Finding fingerprints: a stable identity for "this problem at this code", so a finding that's
 * already on the PR (from us, another bot or a human) isn't raised again. This replaces the
 * prompt's "never re-raise" rules with code.
 *
 * A fingerprint is a hash of four parts:
 * - the rule category (empty for comments from other sources, which don't have one),
 * - the path,
 * - the cited code, normalised so whitespace, identifier names and line numbers don't matter
 *   (moved lines and renamed variables keep their fingerprint),
 * - the key nouns of the title (lowercase, no stopwords, no identifiers),
 * - which occurrence of that normalised code in the file it is (see `codeOccurrence`), so two
 *   separate problems on same-shaped lines (`const user = await loadUser(id)` and
 *   `const order = await loadOrder(orderId)`) don't collapse into one.
 *
 * The hash is versioned (`fp1:`): if the recipe changes, bump the version so old and new
 * fingerprints never match by accident.
 */

export const FINGERPRINT_VERSION = "fp1";

/**
 * Categories where a wrongly dropped finding is expensive. They're only dropped on an exact
 * fingerprint match, never a fuzzy one.
 */
export const PROTECTED_CATEGORIES: readonly string[] = [
  "authz",
  "tenant_scoping",
  "money",
  "secrets",
];

/**
 * Whole words for those four topics. A suppressing learning with no category that uses one is
 * refused until a category is set (`mentionsProtectedTopic`). Matched as whole words, so
 * "secretary" is not "secret".
 */
export const PROTECTED_TOPIC_WORDS: readonly string[] = [
  "authorization",
  "authorisation",
  "authz",
  "tenant",
  "money",
  "payment",
  "payments",
  "refund",
  "refunds",
  "billing",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "password",
  "passwords",
];

const PROTECTED_TOPIC_WORD = new Set(PROTECTED_TOPIC_WORDS);

/** Whether `text` uses a protected-topic word on its own, not inside a longer word. */
export function mentionsProtectedTopic(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  if (words === null) return false;
  return words.some((word) => PROTECTED_TOPIC_WORD.has(word));
}

export function isProtectedCategory(category: string): boolean {
  return PROTECTED_CATEGORIES.includes(category);
}

/**
 * The category of the prompt-injection detector's findings (in @lgtmoose/pipeline). Like a
 * protected category, it's only dropped as a duplicate on an exact fingerprint match: otherwise
 * the PR's author could post a look-alike comment on the line and have the finding dropped.
 */
export const INJECTION_CATEGORY = "prompt_injection";

/** Whether a finding of this category is dropped as a duplicate only on an exact match. */
export function matchesExactlyOnly(category: string): boolean {
  return isProtectedCategory(category) || category === INJECTION_CATEGORY;
}

/** What a fingerprint is computed from. */
export interface FingerprintSubject {
  /** The finding's rule category. Leave out for comments from other bots or humans. */
  ruleCategory?: string;
  path: string;
  /** The finding's title, or for a comment from another source, its first sentence. */
  title: string;
  /** The cited lines' text (see `citedCode`), not normalised. */
  code: readonly string[];
  /**
   * Which occurrence of this normalised code in the file the cited lines are, from 0 (see
   * `codeOccurrence`). Leave out for 0.
   */
  occurrence?: number;
}

/** The normalised parts a fingerprint hashes; kept so findings can also be compared fuzzily. */
export interface FingerprintParts {
  ruleCategory: string;
  path: string;
  /** Normalised code tokens, in order. */
  code: readonly string[];
  /** Key nouns of the title, sorted and unique. */
  nouns: readonly string[];
  /** Which occurrence of `code` in the file this is, from 0. */
  occurrence: number;
}

/** Words common across languages that stay as they are; any other identifier becomes `$id`. */
const KEYWORDS = new Set(
  (
    "abstract and as assert async await break case catch class const continue def default defer " +
    "del delete do elif else enum except export extends false final finally fn for from func " +
    "function go if impl implements import in instanceof interface is lambda let match mod mut " +
    "new nil none not null of or package pass private protected pub public raise return self " +
    "static struct super switch this throw throws trait true try type typeof undefined unless " +
    "unsafe use var void when where while with yield"
  ).split(" "),
);

/**
 * Tokens: comments (dropped), string literals, identifiers, numbers, then any other single
 * non-space character. Comments are `//` line comments, one-line block comments, and `#`
 * followed by a space (Python, shell, YAML), so `#include` and `#private` stay code.
 */
const TOKEN =
  /\/\/.*|\/\*.*?\*\/|#\s.*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][\w$]*|\d[\w.]*|\S/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const COMMENT = /^(?:\/\/|\/\*|#\s)/;
/** `${...}` inside a template literal: the names in it are identifiers too. */
const INTERPOLATION = /\$\{[^}]*\}/g;

function normalizeToken(token: string): string {
  if (IDENTIFIER.test(token)) return KEYWORDS.has(token.toLowerCase()) ? token : "$id";
  if (token.startsWith("`")) return token.replace(INTERPOLATION, "${}");
  return token;
}

/**
 * Normalised tokens of some code: identifiers that aren't keywords become `$id` (also inside a
 * template literal's `${...}`), comments, whitespace and line breaks disappear. String and
 * number literals stay, since they're usually the point (`"admin"`, a limit).
 */
export function normalizeCode(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    (line.match(TOKEN) ?? []).filter((token) => !COMMENT.test(token)).map(normalizeToken),
  );
}

/**
 * The identifiers in some code, lowercased: title words that name them aren't key nouns, since
 * a rename would change them. Keywords aren't renamed, so `null` in "missing null check" stays.
 */
function identifiersIn(lines: readonly string[]): Set<string> {
  const names = lines.flatMap((line) => line.match(/[A-Za-z_$][\w$]*/g) ?? []);
  return new Set(names.map((name) => name.toLowerCase()).filter((name) => !KEYWORDS.has(name)));
}

const STOPWORDS = new Set(
  (
    "a an the this that these those is are was were be been being it its of in on at to for " +
    "from by with without and or not no nor but if then than when while can could may might " +
    "should would will shall must do does did done has have had here there which who what why " +
    "how all any each every some such only also into onto over under after before again more " +
    "most less least very too just now use uses used using missing wrong bad possible potential " +
    "issue problem bug error"
  ).split(" "),
);

/**
 * Key nouns of a title: lowercase words of three letters or more, without stopwords, code in
 * backticks, identifier-like words (camelCase, snake_case, digits) or names that appear in the
 * code, with a plural `s` dropped. Sorted and unique.
 */
export function titleNouns(title: string, code: readonly string[] = []): string[] {
  const names = identifiersIn(code);
  const words = title
    .replace(/`[^`]*`/g, " ")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length >= 3)
    // camelCase, PascalCase with an inner capital, snake_case or digits: an identifier.
    .filter((word) => !/\p{Ll}\p{Lu}|_|\d/u.test(word))
    .map((word) => word.toLowerCase())
    .filter((word) => !STOPWORDS.has(word) && !names.has(word))
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word,
    );
  return [...new Set(words)].sort();
}

export function fingerprintParts(subject: FingerprintSubject): FingerprintParts {
  return {
    ruleCategory: subject.ruleCategory ?? "",
    path: subject.path,
    code: normalizeCode(subject.code),
    nouns: titleNouns(subject.title, subject.code),
    occurrence: subject.occurrence ?? 0,
  };
}

/** The fingerprint: `fp1:` and 32 hex characters of a SHA-256 over the parts. */
export function fingerprint(subject: FingerprintSubject | FingerprintParts): string {
  const parts = "nouns" in subject ? subject : fingerprintParts(subject);
  const key = JSON.stringify([
    FINGERPRINT_VERSION,
    parts.ruleCategory,
    parts.path,
    parts.code.join(" "),
    parts.nouns.join(" "),
    parts.occurrence,
  ]);
  return `${FINGERPRINT_VERSION}:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** Fewer normalised tokens than this, and the cited code is too generic on its own (`}`). */
const MIN_CODE_TOKENS = 4;
/** How far `citedCode` widens a too-short citation, each side. */
const MAX_WIDEN = 2;

/**
 * The text of the lines a finding cites, from the file's lines on that side (head for RIGHT,
 * base for LEFT; `fileLines[0]` is line 1). A citation too short to identify code on its own,
 * such as a lone `}`, is widened by a line on each side, up to two, ignoring blank lines.
 * Lines outside the file are left out.
 */
export function citedCode(
  fileLines: readonly string[],
  line: number,
  startLine: number = line,
): string[] {
  const first = Math.max(1, Math.min(startLine, line));
  const last = Math.min(fileLines.length, Math.max(startLine, line));
  let from = first;
  let to = last;
  const slice = () => fileLines.slice(from - 1, to);
  for (
    let widen = 0;
    widen < MAX_WIDEN && normalizeCode(slice()).length < MIN_CODE_TOKENS;
    widen++
  ) {
    from = previousNonBlank(fileLines, from);
    to = nextNonBlank(fileLines, to);
  }
  return slice().filter((text) => text.trim() !== "");
}

function previousNonBlank(lines: readonly string[], from: number): number {
  let at = from - 1;
  while (at >= 1 && lines[at - 1]?.trim() === "") at--;
  return Math.max(1, at);
}

function nextNonBlank(lines: readonly string[], to: number): number {
  let at = to + 1;
  while (at <= lines.length && lines[at - 1]?.trim() === "") at++;
  return Math.min(lines.length, at);
}

/**
 * Which occurrence the cited lines' normalised code is in the file, from 0: how many earlier
 * places (by starting line) cite the same normalised code over the same span. It tells apart
 * separate problems on same-shaped lines, and stays the same when lines move or names change,
 * unless same-shaped code is added or removed above the site.
 */
export function codeOccurrence(
  fileLines: readonly string[],
  line: number,
  startLine: number = line,
): number {
  const first = Math.min(startLine, line);
  const span = Math.abs(line - startLine);
  const target = normalizeCode(citedCode(fileLines, line, startLine)).join(" ");
  if (target === "") return 0;
  let count = 0;
  for (let start = 1; start < first; start++) {
    const other = normalizeCode(citedCode(fileLines, start + span, start)).join(" ");
    if (other === target) count++;
  }
  return count;
}

/** A comment from another source as a fingerprint title: its first sentence, without markdown. */
export function commentTitle(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Markdown emphasis, quotes, headings and strike-through; an underscore inside a word
    // (`user_id`) stays, so the name is still recognised as an identifier.
    .replace(/[*>#~]|(?<!\w)_+|_+(?!\w)/g, " ")
    .trim();
  const first = text.split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Jaccard similarity of two sets of words or tokens. Two empty sets are equal. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Bigrams of a token sequence, so token order counts in code similarity. */
function bigrams(tokens: readonly string[]): string[] {
  if (tokens.length < 2) return [...tokens];
  return tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`);
}

/** How alike the code must be for a fuzzy match: bigram Jaccard. */
export const FUZZY_CODE_SIMILARITY = 0.8;
/** How alike the title nouns must be for a fuzzy match: Jaccard. */
export const FUZZY_NOUN_SIMILARITY = 0.5;

/**
 * Whether two findings are about the same problem though their fingerprints differ: same path,
 * the same category when both have one, very similar code and overlapping title nouns. A
 * comment with no key nouns only matches on identical code, and identical code at a different
 * occurrence in the file is a different site.
 */
export function isSimilar(a: FingerprintParts, b: FingerprintParts): boolean {
  if (a.path !== b.path) return false;
  if (a.ruleCategory !== "" && b.ruleCategory !== "" && a.ruleCategory !== b.ruleCategory) {
    return false;
  }
  if (a.code.length === 0 || b.code.length === 0) return false;
  const sameCode = a.code.join(" ") === b.code.join(" ");
  // The same code at another occurrence in the file is another site, not the same problem.
  if (sameCode && a.occurrence !== b.occurrence) return false;
  if (!sameCode && jaccard(bigrams(a.code), bigrams(b.code)) < FUZZY_CODE_SIMILARITY) return false;
  if (a.nouns.length === 0 || b.nouns.length === 0) return sameCode;
  return jaccard(a.nouns, b.nouns) >= FUZZY_NOUN_SIMILARITY;
}

/** A finding already on the PR, in any status, from any source. */
export interface KnownFinding {
  fingerprint: string;
  /** Its parts, when known, for fuzzy matching. Without them only exact matches count. */
  parts?: FingerprintParts;
}

/** A finding about to be posted, with its parts (see `fingerprintParts`). */
export interface Candidate<T> {
  finding: T;
  parts: FingerprintParts;
}

export interface DroppedFinding<T> {
  finding: T;
  /** `exact`: same fingerprint. `similar`: a fuzzy match, never for protected categories. */
  reason: "exact" | "similar";
  /** The fingerprint of the finding it matched. */
  matched: string;
}

export interface DedupeResult<T> {
  /** Findings to post, in their original order, each with its fingerprint. */
  kept: { finding: T; fingerprint: string }[];
  dropped: DroppedFinding<T>[];
}

/**
 * Drops findings already on the PR: an exact fingerprint match, or a fuzzy one (`isSimilar`)
 * unless the finding's category is protected or the injection detector's (`matchesExactlyOnly`).
 * Comments from other bots and humans have no rule
 * category, so they never match a finding exactly; they're matched fuzzily, which means a
 * protected finding is posted even if someone else already raised it. Candidates are also checked against each other,
 * in order, so two batches reporting the same problem post it once.
 */
export function dedupeFindings<T>(
  candidates: readonly Candidate<T>[],
  known: readonly KnownFinding[],
): DedupeResult<T> {
  const seen: KnownFinding[] = [...known];
  const exact = new Set(known.map((item) => item.fingerprint));
  const result: DedupeResult<T> = { kept: [], dropped: [] };
  for (const { finding, parts } of candidates) {
    const print = fingerprint(parts);
    if (exact.has(print)) {
      result.dropped.push({ finding, reason: "exact", matched: print });
      continue;
    }
    const similar = matchesExactlyOnly(parts.ruleCategory)
      ? undefined
      : seen.find((item) => item.parts !== undefined && isSimilar(parts, item.parts));
    if (similar !== undefined) {
      result.dropped.push({ finding, reason: "similar", matched: similar.fingerprint });
      continue;
    }
    result.kept.push({ finding, fingerprint: print });
    exact.add(print);
    seen.push({ fingerprint: print, parts });
  }
  return result;
}
