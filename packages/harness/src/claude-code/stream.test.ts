import { describe, expect, it } from "vitest";
import { addUsage } from "../usage.js";
import { findResult, isAuthRetry, outputOf, usageOf } from "./stream.js";

describe("findResult", () => {
  it("finds the last result event and skips other lines", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      "not json",
      '{"type":"result","subtype":"success","result":"first"}',
      '{"type":"result","subtype":"success","result":"last"}',
      "",
    ].join("\n");
    expect(findResult(stdout)?.result).toBe("last");
  });

  it("returns undefined without a result", () => {
    expect(findResult('{"type":"system"}\n')).toBeUndefined();
  });
});

describe("outputOf", () => {
  it("prefers structured output", () => {
    expect(outputOf({ type: "result", subtype: "success", structured_output: { a: 1 } })).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("parses plain or fenced JSON text", () => {
    expect(outputOf({ type: "result", subtype: "success", result: "[1]" })).toEqual({
      ok: true,
      value: [1],
    });
    expect(outputOf({ type: "result", subtype: "success", result: "```\n{}\n```" })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("reports empty or broken answers", () => {
    expect(outputOf({ type: "result", subtype: "success", result: " " }).ok).toBe(false);
    expect(outputOf({ type: "result", subtype: "success", result: "{" }).ok).toBe(false);
  });
});

describe("usage", () => {
  it("maps the CLI's fields", () => {
    expect(
      usageOf({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.1,
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.1 });
  });

  it("adds attempts, leaving unreported fields unset", () => {
    expect(addUsage({ inputTokens: 1, costUsd: 0.5 }, { inputTokens: 2 })).toEqual({
      inputTokens: 3,
      costUsd: 0.5,
    });
  });
});

describe("isAuthRetry", () => {
  it("spots retries caused by the credential", () => {
    expect(
      isAuthRetry('{"type":"system","subtype":"api_retry","error":"authentication_failed"}'),
    ).toBe(true);
    expect(isAuthRetry('{"type":"system","subtype":"api_retry","error":"overloaded"}')).toBe(false);
    expect(isAuthRetry("garbage")).toBe(false);
  });
});
