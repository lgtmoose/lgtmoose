import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FINDING_LIMITS,
  findingSchema,
  keepMostSevere,
  reviewerOutputSchema,
  type Finding,
} from "./index.js";

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

  it("accepts more than the soft limit but refuses a flood", () => {
    const many = Array.from({ length: FINDING_LIMITS.findingsPerRun + 5 }, () => base);
    expect(reviewerOutputSchema.safeParse({ findings: many }).success).toBe(true);
    const flood = Array.from({ length: FINDING_LIMITS.findingsHardMax + 1 }, () => base);
    expect(reviewerOutputSchema.safeParse({ findings: flood }).success).toBe(false);
  });

  it("keeps the most severe findings, in order", () => {
    const at = (severity: Finding["severity"], line: number) =>
      ({ ...base, severity, line }) as Finding;
    const findings = [at("nit", 1), at("blocking", 2), at("should_fix", 3), at("blocking", 4)];
    expect(keepMostSevere(findings, 3)).toEqual({
      kept: [at("blocking", 2), at("should_fix", 3), at("blocking", 4)],
      dropped: 1,
    });
    expect(keepMostSevere(findings).dropped).toBe(0);
  });

  it.each(["body", "evidence", "suggestion"] as const)("refuses an overlong %s", (field) => {
    const text = "x".repeat(FINDING_LIMITS[field] + 1);
    expect(findingSchema.safeParse({ ...base, [field]: text }).success).toBe(false);
  });
});
