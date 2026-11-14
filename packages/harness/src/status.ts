import { HeadTail } from "./headtail.js";

/**
 * HTTP statuses (and connect-rpc codes, as the status they stand for) a CLI's error text reports.
 * Only machine-shaped signals count, so a line number (`index.js:429:17`) or a count ("search
 * returned 429 results", "error 401 tests failed") never does. Every pattern is anchored and
 * linear in the text's length.
 */

/** connect-rpc codes, by the HTTP status they map to. Cursor's API speaks connect. */
const CONNECT_CODES: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  resource_exhausted: 429,
  permission_denied: 403,
};

/** Status texts that may follow a code: "401 Unauthorized", "429 (Too Many Requests)". */
const STATUS_TEXT = String.raw`\(?(?:Unauthorized|Too Many Requests|Forbidden|Payment Required)\b`;
/** Where a weak verb's code may end: the end of a clause, or a status text. */
const CLAUSE_END = String.raw`(?=[ \t]*(?:$|[.,;:!)\]]|${STATUS_TEXT}))`;
/** Where a bare "error" or "code" prefix's code may end: the end of the line, or a status text. */
const LINE_END = String.raw`(?=[ \t]*(?:$|${STATUS_TEXT}))`;

/**
 * The text forms, each capturing the code.
 *
 * Strong forms count whatever follows the code, since a count can't take their place:
 * - bracketed connect codes: "[unauthenticated]", "[resource_exhausted]" (the name is the
 *   capture);
 * - "HTTP 429", "HTTP/1.1 401", "HTTP error 429", "HTTP 401 from upstream";
 * - the code with its status text: "401 Unauthorized", "429 (Too Many Requests)";
 * - an error class and a colon: "RateLimitError: 429 Rate limit reached", "HTTPError: 401";
 * - key-value fields: "status: 429", "status:429", `status: "429"`, "statusCode: 429",
 *   "status_code=401", "errorCode: 429", "code=401", `"code": 429`, and `{ code: 429, … }` in an
 *   object literal opened on the same line.
 *
 * Weak forms follow the count rule: the code must end its clause or carry a status text, so
 * "status 429 rows" and "search returned 429 results" don't count:
 * - after "returned", "responded with", "failed with", "status" or "status code": "server
 *   returned 401", "responded with 429, retrying", "status 429", "status code 429";
 * - after a bare "error" or "code", or an error class without a colon, only at the end of the
 *   line or before a status text: "Error: 401", "code: 429", "HTTPError 401", "Response code 401
 *   (Unauthorized)"; not "found error 401." or "Error: 429, Passed: 12".
 */
const FORMS: readonly RegExp[] = [
  /\[(unauthenticated|resource_exhausted|permission_denied)\]/gi,
  /\bHTTP(?:\/\d(?:\.\d)?)?(?: error)?:? (\d{3})\b/gi,
  new RegExp(String.raw`\b(\d{3}) ${STATUS_TEXT}`, "gi"),
  /\b[A-Za-z]\w*(?:Error|Exception): ?(\d{3})\b/g,
  /\b(?:status|statusCode|status_code|errorCode|error_code)"?\s*[:=]\s*"?(\d{3})\b/gi,
  /\bcode\s*=\s*"?(\d{3})\b/gi,
  /"(?:status|code)" ?: ?"?(\d{3})\b/gi,
  /\{[^{}\n]*?\b(?:status|code)\s*:\s*(\d{3})\b/gi,
  new RegExp(
    String.raw`\b(?:returned|responded with|failed with|status code:?|status) (\d{3})${CLAUSE_END}`,
    "gim",
  ),
  new RegExp(
    String.raw`\b(?:code:?|error:?|[A-Za-z]\w*(?:Error|Exception)) (\d{3})${LINE_END}`,
    "gim",
  ),
];

/** A key `fromObject` reads, quoted as JSON writes it. */
const STATUS_KEY = /"(?:status|statusCode|status_code|code|errorCode|error_code|error)"\s*:/;

/** Longest object the JSON pass parses, how many it parses, and how many spans it records. */
const MAX_OBJECT = 64 * 1024;
const MAX_PARSES = 40;
const MAX_CLOSED = 2000;
/** Unclosed openers the scan remembers; past this the oldest are dropped. */
const MAX_OPEN = 64;

/** The status a JSON field holds: a number, a numeric string, or a connect code name. */
function statusOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  if (/^\d{3}$/.test(value)) return statusOf(Number(value));
  return CONNECT_CODES[value.toLowerCase()];
}

const FIELDS = ["status", "statusCode", "status_code", "code", "errorCode", "error_code"] as const;

/** Statuses in a parsed object's fields, and in its `error` object's. */
function fromObject(value: unknown, found: Set<number>): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const field of FIELDS) {
    const status = statusOf(record[field]);
    if (status !== undefined) found.add(status);
  }
  const error = record.error;
  if (error !== null && typeof error === "object") fromObject(error, found);
}

interface Span {
  start: number;
  end: number;
  children: Span[];
}

/**
 * The closed `{...}` spans in a text as a forest, outermost first, found in one pass that skips
 * braces inside JSON strings. An opener that never closes doesn't hide later objects: past
 * `MAX_OPEN` unclosed openers the oldest are forgotten. A JSON string can't hold a raw line
 * break, so a stray quote stops counting as one at the end of its line.
 */
function spanForest(text: string): Span[] {
  const closed: Span[] = [];
  const open: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") inString = false;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && open.length > 0) inString = true;
    else if (c === "{") {
      // Dropped in batches, so it stays linear.
      if (open.length >= 2 * MAX_OPEN) open.splice(0, MAX_OPEN);
      open.push(i);
    } else if (c === "}") {
      const start = open.pop();
      if (start === undefined) continue;
      closed.push({ start, end: i + 1, children: [] });
      // Keep the latest spans, the error usually being the last thing a CLI prints; trimmed in
      // batches so it stays linear.
      if (closed.length >= 2 * MAX_CLOSED) closed.splice(0, closed.length - MAX_CLOSED);
    }
  }
  if (closed.length > MAX_CLOSED) closed.splice(0, closed.length - MAX_CLOSED);
  // Nest them: sorted by start, an outer span before the ones inside it.
  closed.sort((a, b) => a.start - b.start || b.end - a.end);
  const roots: Span[] = [];
  const stack: Span[] = [];
  for (const span of closed) {
    while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= span.start) stack.pop();
    const parent = stack.at(-1);
    if (parent === undefined) roots.push(span);
    else parent.children.push(span);
    stack.push(span);
  }
  return roots;
}

/**
 * Statuses in the text's JSON objects. The outermost objects are parsed from the last one
 * back, since the error is usually printed last; one that isn't valid JSON (an inspect dump,
 * say) has its inner objects parsed instead.
 */
function fromJson(text: string, found: Set<number>): void {
  let parses = 0;
  const visit = (spans: readonly Span[]): void => {
    for (let i = spans.length - 1; i >= 0 && parses < MAX_PARSES; i--) {
      const span = spans[i];
      if (span === undefined) continue;
      const body = text.slice(span.start, span.end);
      // An object with none of the keys read can't hold a status, nor can anything inside it:
      // skip it before parsing, so JSON log lines don't use up the budget.
      if (!STATUS_KEY.test(body)) continue;
      if (span.end - span.start <= MAX_OBJECT) {
        parses++;
        try {
          fromObject(JSON.parse(body), found);
          continue;
        } catch {
          // Not JSON: look inside.
        }
      }
      visit(span.children);
    }
  };
  visit(spanForest(text));
}

/**
 * Every status the text reports: JSON fields, then the text forms. A long text is read the way
 * stderr is kept (`HeadTail`): its start and its end.
 */
export function statusesIn(whole: string): Set<number> {
  const text = HeadTail.of(whole);
  const found = new Set<number>();
  fromJson(text, found);
  for (const form of FORMS) {
    for (const match of text.matchAll(form)) {
      const value = match[1];
      if (value === undefined) continue;
      const status = statusOf(/^\d+$/.test(value) ? Number(value) : value);
      if (status !== undefined) found.add(status);
    }
  }
  return found;
}
