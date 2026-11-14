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

/** Status texts that may follow a code: "401 Unauthorized", "429 Too Many Requests". */
const STATUS_TEXT = String.raw`(?:Unauthorized|Too Many Requests|Forbidden|Payment Required)`;

/**
 * The text forms, each capturing the code:
 * - "[unauthenticated]", "[resource_exhausted]" (group 1 is the name);
 * - "HTTP 429", "HTTP/1.1 401";
 * - "401 Unauthorized", "429 Too Many Requests";
 * - an error class name: "AuthenticationError: 401", "HTTPError: 401", "FooException: 429";
 * - a status field: "status: 429", "statusCode=401", "status_code: 401", "status code: 429",
 *   "errorCode: 429", `"statusCode": 401`;
 * - "returned 401", "responded with 429", "failed with 429", "status code 429", "status 429", at
 *   the end of a clause (end of line, or punctuation); before a status text, the form above
 *   covers it.
 */
const FORMS: readonly RegExp[] = [
  /\[(unauthenticated|resource_exhausted|permission_denied)\]/gi,
  /\bHTTP(?:\/\d(?:\.\d)?)? (\d{3})\b/gi,
  new RegExp(String.raw`\b(\d{3}) ${STATUS_TEXT}\b`, "gi"),
  /\b[A-Za-z]\w*(?:Error|Exception): ?(\d{3})\b/g,
  /\b(?:status|statusCode|status_code|status code|errorCode|error_code)"? ?[:=] ?"?(\d{3})\b/gi,
  /\b(?:returned|responded with|failed with|status code|status) (\d{3})(?=[ \t]*(?:$|[.,;:!)\]]))/gim,
];

/** Longest object the JSON pass parses, and how many it looks at. */
const MAX_OBJECT = 64 * 1024;
const MAX_OBJECTS = 20;

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

/** How many closed `{...}` spans the scan records before it stops. */
const MAX_CLOSED = 1000;

/**
 * The outermost closed `{...}` spans in a text, found in one pass that tracks nesting and skips
 * braces inside JSON strings. A brace that never closes doesn't hide the objects after it: every
 * closed span is recorded, and the ones not inside another closed span are kept. A JSON string
 * can't hold a raw line break, so a stray quote stops counting as one at the end of its line.
 */
function objectSpans(text: string): string[] {
  const closed: { start: number; end: number }[] = [];
  const open: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length && closed.length < MAX_CLOSED; i++) {
    const c = text[i];
    if (c === "\n") inString = false;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && open.length > 0) inString = true;
    else if (c === "{") open.push(i);
    else if (c === "}") {
      const start = open.pop();
      if (start !== undefined) closed.push({ start, end: i + 1 });
    }
  }
  // Closed in order of their ends: an outer span comes after the ones inside it.
  closed.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: string[] = [];
  let reach = -1;
  for (const { start, end } of closed) {
    if (start < reach) continue;
    reach = end;
    if (end - start <= MAX_OBJECT) spans.push(text.slice(start, end));
    if (spans.length >= MAX_OBJECTS) break;
  }
  return spans;
}

/** Every status the text reports, JSON fields first, then the text forms. */
export function statusesIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const span of objectSpans(text)) {
    try {
      fromObject(JSON.parse(span), found);
    } catch {
      // Not JSON.
    }
  }
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
