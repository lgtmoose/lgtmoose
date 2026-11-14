/**
 * Every message form the failure classifiers have had to handle, from every review round, in
 * one place: a change that drops one shows up here at once. Add a row for each new form, and a
 * negative row for each false positive found.
 */
import { describe, expect, it } from "vitest";
import { classifyCursorFailure } from "./cursor/result.js";
import {
  classifyFailure,
  classifyMachineSignals,
  classifyReportedFailure,
  isGenericError,
} from "./limits.js";
import { statusesIn } from "./status.js";

type Kind = "plan_limit" | "rate_limit" | "auth" | undefined;
const P = "plan_limit";
const R = "rate_limit";
const A = "auth";
const N = undefined;

/**
 * [message, classifyFailure (shared with Codex), classifyCursorFailure]. The Cursor classifier
 * adds Cursor's plan-limit and auth wording, and bare connect code names.
 */
const KINDS: readonly (readonly [string, Kind, Kind])[] = [
  // Codex's wording.
  ["You’ve hit your usage limit. Upgrade to Plus to continue using Codex", P, P],
  ["You hit your spend cap set in your workspace.", P, P],
  ["Quota exceeded. Check your plan and billing details.", P, P],
  ["error code: usage_not_included", P, P],
  ["exceeded retry limit, last status: 429 Too Many Requests", R, R],
  ["Rate limit reached for requests", R, R],
  ["429 rate limit. Please try again in 2m", R, R],
  ["unexpected status 401 Unauthorized", A, A],
  ["unexpected status 401 Unauthorized: invalid_api_key", A, A],
  ["Incorrect API key provided", A, A],
  ["Invalid API key", A, A],
  ["sandbox error: denied", N, N],
  // Cursor's plan-limit wording.
  ["You've hit your usage limit", P, P],
  ["[resource_exhausted] You've hit your usage limit", P, P],
  ["You're out of fast requests", N, P],
  ["You've run out of fast requests", N, P],
  ["Spending limit reached for this team", N, P],
  ["Spending limit reached (429), try again in 2 hours", N, P],
  ["Your spend limit has been reached.", N, P],
  ["Spending limit exceeded", N, P],
  ["You've used up your included usage for this month.", N, P],
  ["You have reached your monthly limit", N, P],
  ["You've hit your\nusage   limit", N, P],
  // Cursor's auth wording, and bare connect codes in an error result.
  ["Authentication required", N, A],
  ["Authentication required. Run agent login or set CURSOR_API_KEY.", N, A],
  ["unauthenticated: token revoked", N, A],
  ["resource_exhausted: slow down", N, R],
  // JSON status fields.
  ['{"status":429}', R, R],
  ['error body: {"statusCode": 401, "message": "bad key"}', A, A],
  ['{"error":{"code":401,"message":"x"}}', A, A],
  ['{"error":{"code":429}}', R, R],
  ['{"errorCode":"429"}', R, R],
  ['{"error_code": 401}', A, A],
  ['{"code":"unauthenticated","message":"invalid token"}', A, A],
  ['{"error":{"code":"resource_exhausted"}}', R, R],
  // Bracketed connect codes.
  ["ConnectError: [unauthenticated] invalid token", A, A],
  ["ConnectError: [resource_exhausted] slow down, try again in 20 seconds", R, R],
  // HTTP wording.
  ["HTTP 429", R, R],
  ["HTTP/1.1 401", A, A],
  ["HTTP/1.1 429", R, R],
  ["HTTP/2 429", R, R],
  ["HTTP error 429", R, R],
  ["returned HTTP 401", A, A],
  ["Request failed: server returned HTTP 401", A, A],
  ["got 401 Unauthorized", A, A],
  ["Error: 401 Unauthorized", A, A],
  ["429 Too Many Requests", R, R],
  ["429 (Too Many Requests)", R, R],
  ["401 (Unauthorized)", A, A],
  ["returned 429 Too Many Requests", R, R],
  ["request returned 401 Unauthorized", A, A],
  ["Response code 401 (Unauthorized)", A, A],
  // Error class names.
  ["AuthenticationError: 401 status code", A, A],
  ["HTTPError: 401", A, A],
  ["HTTPError 401", A, A],
  ["ServerError: 429", R, R],
  ["RateLimitException: 429", R, R],
  ["Error: 401", A, A],
  // Strong forms count whatever follows the code (round 8).
  ["HTTP 429 requests queued", R, R],
  ["HTTP 401 from upstream", A, A],
  ["statusCode: 429 rows", R, R],
  ["ServerError: 429 items", R, R],
  ["RateLimitError: 429 Rate limit reached for requests", R, R],
  ["AuthenticationError: 401 invalid x-api-key", A, A],
  ["level=error status=429 url=https://api2.cursor.sh/x", R, R],
  ["statusCode=401 path=/v1", A, A],
  ["code=429 msg=slow", R, R],
  ['{ code: 429, message: "slow down" }', R, R],
  ["{ status: 401, statusText: 'nope' }", A, A],
  // Status fields and words.
  ["statusCode: 429", R, R],
  ['"statusCode": 401', A, A],
  ["status_code=401", A, A],
  ["status: 429", R, R],
  ["status code: 429", R, R],
  ["errorCode: 429", R, R],
  ["unexpected status 401", A, A],
  ["request failed with status 429", R, R],
  ["Request failed with status code 429", R, R],
  ["server responded with status 429", R, R],
  ["code 429", R, R],
  ["code: 429", R, R],
  // returned / responded with / failed with, at the end of a clause.
  ["server returned 401", A, A],
  ["server returned 401.", A, A],
  ["Request failed: server returned 401 Unauthorized", A, A],
  ["the API responded with 429, retrying", R, R],
  ["upload failed with 429", R, R],
  ["failed with 429.", R, R],
  // Not limits: banners, mentions and other failures.
  ["Upgrade to Pro for higher usage limits.", N, N],
  ["Your plan includes included usage of 500 requests.", N, N],
  ["Check your spend limit in settings.", N, N],
  ["Usage limits apply to fast requests.", N, N],
  ["Your team's monthly limit resets on the 1st.", N, N],
  ["ENOENT: no such file", N, N],
  ["CONNECT tunnel failed, response 403 Forbidden", N, N],
  // Not statuses: line numbers and counts.
  ["    at run (index.js:429:17)", N, N],
  ["TypeError: x is undefined\n    at run (index.js:429:17)", N, N],
  ["at x (cli.js:401:3)", N, N],
  ["    at main (cli.js:401:3)", N, N],
  ["search returned 429 results", N, N],
  ["the query failed with 401 matches pending", N, N],
  ["error 401 tests failed", N, N],
  ["code 429 lines changed", N, N],
  ["Error: 429 files changed", N, N],
  ["processed 429 files", N, N],
  ["Fetched 429 files in 3s", N, N],
  ["PR #401", N, N],
  ['{"count": 429}', N, N],
  ['{"status": "ok", "items": 401}', N, N],
  ["{ not json at all 401 }", N, N],
  // The count rule holds after the weak prefixes ("status" as a plain word, "returned", ...): a
  // word after the code that isn't a status text makes it a count (rounds 7 and 8).
  ["status 429 rows", N, N],
  ["status 429 from server", N, N],
  ["status: 429 rows", N, N],
  // A bare "error" or "code" prefix only at the end of the line or before a status text.
  ["found error 401.", N, N],
  ["Error: 429, Passed: 12", N, N],
  ["code 401; retrying", N, N],
  ["resource exhausted, trying a smaller batch", N, R],
  ["unauthenticated users see a login page", N, A],
];

describe.each(KINDS)("%j", (message, shared, cursor) => {
  it(`is ${shared ?? "nothing"} to the shared classifier`, () => {
    expect(classifyFailure(message)?.kind).toBe(shared);
  });
  it(`is ${cursor ?? "nothing"} to the Cursor classifier`, () => {
    expect(classifyCursorFailure(message)?.kind).toBe(cursor);
  });
});

/** [stderr, classifyMachineSignals]: machine signals only, never wording. */
const STRICT: readonly (readonly [string, Kind])[] = [
  ["[unauthenticated] bad key", A],
  ["Error: [resource_exhausted]", R],
  ['{"status":429}', R],
  ["HTTPError: 401", A],
  ["request failed with status 429", R],
  ["unauthenticated session", N],
  ["resource exhausted", N],
  ["resource_exhausted", N],
  ["You've hit your usage limit", N],
  ["warning: rate limit headers missing", N],
  ["Authentication required", N],
  ["Spending limit reached for this team", N],
  ["Rate limit reached for requests", N],
  ["unexpected status 401 Unauthorized", A],
  ['{"error":{"code":"resource_exhausted"}}', R],
];

describe.each(STRICT)("stderr %j", (stderr, kind) => {
  it(`is ${kind ?? "nothing"} to the strict classifier`, () => {
    expect(classifyMachineSignals(stderr)?.kind).toBe(kind);
  });
});

/** [text, statuses]: JSON shapes the text forms above don't show. */
const LOG_LINE = '{"level":"info","msg":"working"}\n';
const JSON_LINES = `${LOG_LINE.repeat(60)}{"error":{"status":429}}`;
/** The error, then more log lines than the parse budget. */
const ERROR_THEN_LOGS = `{"error":{"status":401}}\n${LOG_LINE.repeat(100)}`;
/** Log lines that do carry a key the pass reads, but no status. */
const KEYED_LOGS = `{"status":429}\n${'{"code":"ok","msg":"x"}\n'.repeat(100)}`;
const STATUSES: readonly (readonly [string, readonly number[]])[] = [
  ['log {"status": 401} then {"error": {"status": 429}}', [401, 429]],
  [JSON_LINES, [429]],
  [ERROR_THEN_LOGS, [401]],
  [KEYED_LOGS, [429]],
  ['AxiosError { message: oops, response: {"status":401,"data":{}} }', [401]],
  ['{ inspect: dump, nested: {"code": 429} }', [429]],
  [`${"{".repeat(100)}\n{"status":429}`, [429]],
  [`${"{".repeat(100)}${"}".repeat(100)}\n{"status":429}`, [429]],
  ['warning: config {draft\n{"status":429}', [429]],
  ['warning: {can\'t "parse\n{"status":401}', [401]],
  ['{"message": "a } brace", "status": 429}', [429]],
];

describe.each(STATUSES)("statuses in %j", (text, expected) => {
  it(`are ${expected.join(", ")}`, () => {
    expect([...statusesIn(text)].sort((a, b) => a - b)).toEqual(expected);
  });
});

/** [error result, generic]: whether stderr may explain it. */
const GENERIC: readonly (readonly [string, boolean])[] = [
  ["", true],
  ["  ", true],
  ["Request failed", true],
  ["request failed.", true],
  ["Unknown error", true],
  ["An error occurred", true],
  ["Error", true],
  ["Error: Request failed", true],
  ["Error: Unknown error", true],
  ["ConnectError: Request failed", true],
  ["An unexpected error occurred. Please try again.", true],
  ["Something went wrong! Try again later.", true],
  ["Request failed: model overloaded", false],
  ["The model returned malformed tool calls.", false],
  ["Error: the workspace isn't trusted", false],
  ["error: request failed", true],
  ["ERROR: Unknown error", true],
  ["Error: Request failed. See https://cursor.com/docs for details.", true],
  ["Request failed. Try again later.", true],
  ["Request failed. The model is overloaded.", false],
  ["An unexpected error occurred. Your API key was revoked.", false],
  // Identifiers say nothing about the cause; an HTTP status as the code may (round 8).
  ["Request failed. Request ID: 1234.", true],
  ["Unknown error. Trace ID: 9f8e7d.", true],
  ["An error occurred. Error code: 13.", true],
  ["Request failed. Correlation ID: abc-123", true],
  ["Request failed. Error code: 429.", false],
  // Sentences split at line breaks too (round 8).
  ["Request failed\nPlease try again", true],
  ["Request failed\nThe model is overloaded", false],
];

describe.each(GENERIC)("error result %j", (text, generic) => {
  it(`is ${generic ? "" : "not "}generic`, () => {
    expect(isGenericError(text)).toBe(generic);
  });
});

/**
 * [reported error, stderr, classifyReportedFailure]: wording only in the report; stderr for
 * machine signals, without a report or behind a generic one. Shared by Cursor and Codex.
 */
const REPORTED: readonly (readonly [string | undefined, string | undefined, Kind])[] = [
  ["You've hit your usage limit", undefined, P],
  [undefined, "You've hit your usage limit", N],
  [undefined, "Error: [unauthenticated] token revoked", A],
  ["Request failed", "HTTPError: 401", A],
  ["Error: Request failed. Request ID: 12.", '{"status":429}', R],
  ["Request failed", "Rate limit reached for requests", N],
  ["The model returned malformed tool calls.", "HTTPError: 401", N],
  [undefined, undefined, N],
];

describe.each(REPORTED)("reported %j with stderr %j", (reported, stderr, kind) => {
  it(`is ${kind ?? "nothing"}`, () => {
    expect(classifyReportedFailure(reported, stderr, classifyCursorFailure)?.kind).toBe(kind);
    expect(classifyReportedFailure(reported, stderr, classifyFailure)?.kind).toBe(kind);
  });
});

describe("limit times", () => {
  it("keep the wait and reset time a limit gives", () => {
    expect(classifyFailure("429 rate limit. Please try again in 2m")).toEqual({
      kind: "rate_limit",
      retryAfterSeconds: 120,
    });
    expect(
      classifyFailure("You've hit your usage limit. Try again at Nov 14, 2026 3:45 PM."),
    ).toEqual({ kind: "plan_limit", resetsAt: "Nov 14, 2026 3:45 PM" });
    expect(classifyCursorFailure("Spending limit reached (429), try again in 2 hours")).toEqual({
      kind: "plan_limit",
      retryAfterSeconds: 7200,
    });
  });
});

describe("classification cost", () => {
  const inputs = {
    "1 MB of word characters": "a".repeat(1024 * 1024),
    "1 MB ending like an error class": `${"a".repeat(1024 * 1024)}Erro`,
    "1 MB of spaces after a limit word": `used up${" ".repeat(1024 * 1024)}x`,
    "1 MB of words": "word ".repeat(200 * 1024),
    "1 MB of open braces": "{".repeat(1024 * 1024),
    "1 MB of closed braces": "{}".repeat(512 * 1024),
    "1 MB of 'try again at'": "try again at ".repeat(80 * 1024),
    "1 MB of 'status '": "status ".repeat(150 * 1024),
  };
  const classifiers = { classifyFailure, classifyCursorFailure, classifyMachineSignals };

  // A linear pass over 1 MB takes milliseconds; a quadratic pattern takes seconds. The best of
  // five runs, and a retry, keep a machine busy with other test files from failing it.
  for (const [name, classify] of Object.entries(classifiers)) {
    it.each(Object.entries(inputs))(
      `${name} classifies %s in under 50 ms`,
      { retry: 2 },
      (_input, text) => {
        classify("x");
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          classify(text);
          best = Math.min(best, performance.now() - started);
        }
        expect(best).toBeLessThan(50);
      },
    );
  }
});
