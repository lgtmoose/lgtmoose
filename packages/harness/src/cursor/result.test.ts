import { describe, expect, it } from "vitest";
import { classifyCursorFailure, cursorUsage, findCursorResult } from "./result.js";

describe("findCursorResult", () => {
  it("reads the result object and ignores unknown fields and other lines", () => {
    const stdout = [
      "warning: something",
      JSON.stringify({ type: "result", subtype: "success", result: "{}", extra: 1 }),
      "",
    ].join("\n");
    expect(findCursorResult(stdout)).toEqual({ type: "result", subtype: "success", result: "{}" });
  });

  it("returns undefined without a result object", () => {
    expect(findCursorResult("")).toBeUndefined();
    expect(findCursorResult('{"type":"assistant"}\nnot json')).toBeUndefined();
  });
});

describe("cursorUsage", () => {
  it("maps the camelCase token counts", () => {
    expect(
      cursorUsage({
        type: "result",
        subtype: "success",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 });
    expect(cursorUsage(undefined)).toEqual({});
  });
});

describe("classifyCursorFailure", () => {
  it.each([
    ["You've hit your usage limit", "plan_limit"],
    ["You're out of fast requests", "plan_limit"],
    ["Spending limit reached for this team", "plan_limit"],
    ["429 Too Many Requests", "rate_limit"],
    ["Invalid API key", "auth"],
    ["Error: 401 Unauthorized", "auth"],
    ["Authentication required", "auth"],
    ["Your spend limit has been reached.", "plan_limit"],
    ["Spending limit exceeded", "plan_limit"],
    ["You've used up your included usage for this month.", "plan_limit"],
    ["You've run out of fast requests", "plan_limit"],
    ["You have reached your monthly limit", "plan_limit"],
    ["Request failed: server returned HTTP 401", "auth"],
    ["Request failed: server returned 401 Unauthorized", "auth"],
    ["ConnectError: [unauthenticated] invalid token", "auth"],
    ["request failed with status 429", "rate_limit"],
    ["ConnectError: [resource_exhausted] slow down, try again in 20 seconds", "rate_limit"],
    ["[resource_exhausted] You've hit your usage limit", "plan_limit"],
  ] as const)("%j is %s", (message, kind) => {
    expect(classifyCursorFailure(message)?.kind).toBe(kind);
  });

  it("leaves other failures alone", () => {
    expect(classifyCursorFailure("ENOENT: no such file")).toBeUndefined();
  });

  it("prefers a plan limit over a 429 in the same message, keeping the wait", () => {
    expect(classifyCursorFailure("Spending limit reached (429), try again in 2 hours")).toEqual({
      kind: "plan_limit",
      retryAfterSeconds: 7200,
    });
  });

  it.each([
    "Upgrade to Pro for higher usage limits.",
    "Your plan includes included usage of 500 requests.",
    "TypeError: x is undefined\n    at run (index.js:429:17)",
    "    at main (cli.js:401:3)",
    "Check your spend limit in settings.",
    "Usage limits apply to fast requests.",
    "Your team's monthly limit resets on the 1st.",
    "Fetched 429 files in 3s",
  ])("doesn't read %j as a limit", (message) => {
    expect(classifyCursorFailure(message)).toBeUndefined();
  });

  it("reads status codes next to HTTP wording", () => {
    expect(classifyCursorFailure("request failed with status code 429")?.kind).toBe("rate_limit");
    expect(classifyCursorFailure("HTTP 401")?.kind).toBe("auth");
  });

  it("doesn't blame the key for a proxy's 403", () => {
    expect(classifyCursorFailure("CONNECT tunnel failed, response 403 Forbidden")).toBeUndefined();
  });
});
