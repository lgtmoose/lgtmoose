import { describe, expect, it } from "vitest";
import { cursorUsage, findCursorResult } from "./result.js";

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
