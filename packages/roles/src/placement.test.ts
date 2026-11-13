import type { Finding } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import { placeFindings } from "./placement.js";
import { TOTAL_PATCH, fileDiff } from "./testing/fixtures.js";

function finding(overrides: Partial<Finding>): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 9,
    side: "RIGHT",
    title: "Off by one",
    body: "The loop skips the last item.",
    evidence: "for (let i = 0; i < items.length - 1; i++) {",
    ...overrides,
  };
}

describe("placeFindings", () => {
  const batch = { files: [{ file: fileDiff(TOTAL_PATCH), depth: "full" as const }] };

  it("sorts findings by whether they point into the batch's diff", () => {
    const inline = finding({});
    const left = finding({ line: 9, side: "LEFT" });
    const outside = finding({ line: 120 });
    const range = finding({ start_line: 2, line: 9 });
    const other = finding({ path: "src/other.ts" });
    expect(placeFindings([inline, left, outside, range, other], batch)).toEqual({
      inline: [inline, left],
      outsideDiff: [outside, range],
      otherFile: [other],
    });
  });
});
