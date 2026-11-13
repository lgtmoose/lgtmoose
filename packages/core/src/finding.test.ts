import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FINDING_LIMITS, findingSchema, reviewerOutputSchema, type Finding } from "./index.js";

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

describe("finding limits", () => {
  const base = {
    rule_category: "correctness",
    severity: "nit",
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    title: "t",
    body: "b",
    evidence: "e",
  };

  it("refuses more findings than one run may return", () => {
    const findings = Array.from({ length: FINDING_LIMITS.findingsPerRun + 1 }, () => base);
    expect(reviewerOutputSchema.safeParse({ findings }).success).toBe(false);
    expect(reviewerOutputSchema.safeParse({ findings: findings.slice(1) }).success).toBe(true);
  });

  it.each(["body", "evidence", "suggestion"] as const)("refuses an overlong %s", (field) => {
    const text = "x".repeat(FINDING_LIMITS[field] + 1);
    expect(findingSchema.safeParse({ ...base, [field]: text }).success).toBe(false);
  });
});
