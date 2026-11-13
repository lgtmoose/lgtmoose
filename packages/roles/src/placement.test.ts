import { FINDING_LIMITS, type Finding } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import { placeFindings } from "./placement.js";
import { TOTAL_PATCH, fileDiff } from "./testing/fixtures.js";

const LOOP = "for (let i = 0; i < items.length - 1; i++) {";

function finding(overrides: Partial<Finding>): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 9,
    side: "RIGHT",
    title: "Off by one",
    body: "The loop skips the last item.",
    evidence: LOOP,
    ...overrides,
  };
}

describe("placeFindings", () => {
  const batch = { files: [{ file: fileDiff(TOTAL_PATCH), depth: "full" as const }] };

  it("sorts findings by whether they point into the batch's diff", () => {
    const inline = finding({});
    const left = finding({
      side: "LEFT",
      evidence: "for (let i = 0; i < items.length; i++) {",
    });
    const range = finding({ start_line: 8, line: 9, evidence: `let sum = 0;\n  ${LOOP}` });
    const outside = finding({ line: 120 });
    const partlyOutside = finding({ start_line: 2, line: 9 });
    const other = finding({ path: "src/other.ts" });
    expect(placeFindings([inline, left, range, outside, partlyOutside, other], batch)).toEqual({
      inline: [inline, left, range],
      outsideDiff: [outside, partlyOutside],
      dropped: [other],
      overLimit: 0,
    });
  });

  it("keeps a finding whose evidence doesn't match the cited line out of the inline comments", () => {
    const misnumbered = finding({ line: 10 });
    expect(placeFindings([misnumbered], batch).outsideDiff).toEqual([misnumbered]);
  });

  it("matches evidence regardless of indentation", () => {
    const reindented = finding({ evidence: `    ${LOOP}  ` });
    expect(placeFindings([reindented], batch).inline).toEqual([reindented]);
  });

  it("drops findings on pure renames", () => {
    const moved = { files: [{ file: fileDiff(TOTAL_PATCH), depth: "move" as const }] };
    expect(placeFindings([finding({})], moved).dropped).toHaveLength(1);
  });

  it("places only the most severe findings past the limit", () => {
    const many = [
      ...Array.from({ length: FINDING_LIMITS.findingsPerRun }, () => finding({})),
      finding({ severity: "nit" }),
    ];
    const placed = placeFindings(many, batch);
    expect(placed.overLimit).toBe(1);
    expect(placed.inline.every((f) => f.severity === "blocking")).toBe(true);
  });
});
