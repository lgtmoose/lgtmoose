import { describe, expect, it } from "vitest";
import { classifyCursorFailure, classifyStrictCursorFailure } from "./cursor/result.js";
import { classifyFailure } from "./limits.js";
import { statusesIn } from "./status.js";

const statuses = (text: string) => [...statusesIn(text)].sort((a, b) => a - b);

describe("statusesIn", () => {
  it.each([
    // JSON fields
    ['{"status":429}', 429],
    ['error body: {"statusCode": 401, "message": "bad key"}', 401],
    ['{"error":{"code":401,"message":"x"}}', 401],
    ['{"errorCode":"429"}', 429],
    ['{"error_code": 401}', 401],
    ['{"code":"unauthenticated","message":"invalid token"}', 401],
    ['{"error":{"code":"resource_exhausted"}}', 429],
    // connect codes
    ["ConnectError: [unauthenticated] invalid token", 401],
    ["[resource_exhausted] slow down", 429],
    // HTTP
    ["HTTP 429", 429],
    ["HTTP/1.1 401", 401],
    ["got 401 Unauthorized", 401],
    ["429 Too Many Requests", 429],
    // error classes and status fields
    ["AuthenticationError: 401 status code", 401],
    ["HTTPError: 401", 401],
    ["ServerError: 429", 429],
    ["RateLimitException: 429", 429],
    ["statusCode: 429", 429],
    ["status_code=401", 401],
    ["status: 429", 429],
    ['"statusCode": 401', 401],
    ["errorCode: 429", 429],
    // returned / responded / failed with, at the end of a clause
    ["server returned 401", 401],
    ["server returned 401.", 401],
    ["the API responded with 429, retrying", 429],
    ["upload failed with 429", 429],
    ["Request failed with status code 429", 429],
    ["returned 429 Too Many Requests", 429],
  ] as const)("finds %s in %j", (text, status) => {
    expect(statuses(text)).toEqual([status]);
  });

  it.each([
    "    at run (index.js:429:17)",
    "at x (cli.js:401:3)",
    "search returned 429 results",
    "the query failed with 401 matches pending",
    "error 401 tests failed",
    "code 429 lines changed",
    "processed 429 files",
    "PR #401",
    "unauthenticated users see a login page",
    "resource exhausted, trying a smaller batch",
    "status 429 rows",
    '{"count": 429}',
    '{"status": "ok", "items": 401}',
    "{ not json at all 401 }",
  ])("finds nothing in %j", (text) => {
    expect(statuses(text)).toEqual([]);
  });

  it("finds statuses in each of several JSON objects", () => {
    expect(statuses('log {"status": 401} then {"error": {"status": 429}}')).toEqual([401, 429]);
  });

  it("isn't fooled by braces inside JSON strings", () => {
    expect(statuses('{"message": "a } brace", "status": 429}')).toEqual([429]);
  });
});

describe("classification cost", () => {
  const inputs = {
    "1 MB of word characters": "a".repeat(1024 * 1024),
    "1 MB ending like an error class": `${"a".repeat(1024 * 1024)}Erro`,
    "1 MB of spaces after a limit word": `used up${" ".repeat(1024 * 1024)}x`,
    "1 MB of words": "word ".repeat(200 * 1024),
    "1 MB of open braces": "{".repeat(1024 * 1024),
    "1 MB of 'try again at'": "try again at ".repeat(80 * 1024),
  };

  const classifiers = { classifyFailure, classifyCursorFailure, classifyStrictCursorFailure };

  // A linear pass over 1 MB takes 10 to 20 ms; a quadratic pattern takes seconds. The best of
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
