import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_FINDINGS_PER_VERIFIER_RUN, verdictSchema, verifierOutputSchema } from "./index.js";

describe("verifierOutputSchema", () => {
  const verdict = { id: "F1", confirmed: true, reason: "The guard is missing." };

  it("accepts verdicts with an optional severity change", () => {
    expect(verifierOutputSchema.parse({ verdicts: [verdict] })).toEqual({ verdicts: [verdict] });
    const adjusted = { ...verdict, adjusted_severity: "nit" };
    expect(verdictSchema.parse(adjusted)).toEqual(adjusted);
  });

  it("refuses unknown fields, bad severities, empty reasons and too many verdicts", () => {
    expect(verdictSchema.safeParse({ ...verdict, extra: 1 }).success).toBe(false);
    expect(verdictSchema.safeParse({ ...verdict, adjusted_severity: "minor" }).success).toBe(false);
    expect(verdictSchema.safeParse({ ...verdict, reason: "" }).success).toBe(false);
    const many = Array.from({ length: MAX_FINDINGS_PER_VERIFIER_RUN + 1 }, () => verdict);
    expect(verifierOutputSchema.safeParse({ verdicts: many }).success).toBe(false);
  });

  it("converts to JSON Schema for the harness", () => {
    expect(z.toJSONSchema(verifierOutputSchema)).toMatchSnapshot();
  });
});
