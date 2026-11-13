import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findingSchema, reviewerOutputSchema, type Finding } from "./index.js";

const finding: Finding = {
  rule_category: "correctness",
  severity: "blocking",
  path: "src/total.ts",
  line: 12,
  side: "RIGHT",
  title: "The loop skips the last item",
  body: "`i < items.length - 1` stops one short, so the total misses the last price.",
  evidence: "for (let i = 0; i < items.length - 1; i++) {",
};

describe("findingSchema", () => {
  it("accepts a minimal finding", () => {
    expect(findingSchema.parse(finding)).toEqual(finding);
  });

  it("accepts a range with a suggestion", () => {
    const range = { ...finding, start_line: 10, suggestion: "for (const item of items) {" };
    expect(findingSchema.parse(range)).toEqual(range);
  });

  it("accepts a deleted line on the LEFT side", () => {
    expect(findingSchema.safeParse({ ...finding, side: "LEFT" }).success).toBe(true);
  });

  it.each([
    ["an unknown severity", { severity: "critical" }],
    ["an unknown side", { side: "BOTH" }],
    ["line 0", { line: 0 }],
    ["a fractional line", { line: 1.5 }],
    ["an empty path", { path: "" }],
    ["empty evidence", { evidence: "" }],
    ["a category that isn't snake_case", { rule_category: "Error Handling" }],
    ["start_line after line", { start_line: 13 }],
  ])("rejects %s", (_name, change) => {
    expect(findingSchema.safeParse({ ...finding, ...change }).success).toBe(false);
  });

  it("rejects a finding with a required field missing", () => {
    const partial: Partial<Finding> = { ...finding };
    delete partial.evidence;
    expect(findingSchema.safeParse(partial).success).toBe(false);
  });
});

describe("reviewerOutputSchema", () => {
  it("accepts an empty list", () => {
    expect(reviewerOutputSchema.parse({ findings: [] })).toEqual({ findings: [] });
  });

  it("converts to JSON Schema for the harness", () => {
    expect(z.toJSONSchema(reviewerOutputSchema)).toMatchSnapshot();
  });
});
