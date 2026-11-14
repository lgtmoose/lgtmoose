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

  it("doesn't blame the key for a proxy's 403", () => {
    expect(classifyCursorFailure("CONNECT tunnel failed, response 403 Forbidden")).toBeUndefined();
  });
});
