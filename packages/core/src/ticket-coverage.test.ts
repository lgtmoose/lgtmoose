import { describe, expect, it } from "vitest";
import {
  coverageLevel,
  missingCore,
  ticketCoverageSchema,
  type Requirement,
} from "./ticket-coverage.js";

const req = (status: Requirement["status"], core = true): Requirement => ({
  text: `a ${status} requirement`,
  core,
  status,
});

describe("ticket coverage", () => {
  it("rates coverage from the core requirements the checker could judge", () => {
    expect(coverageLevel({ requirements: [req("met"), req("met"), req("missing", false)] })).toBe(
      "covered",
    );
    expect(coverageLevel({ requirements: [req("met"), req("missing")] })).toBe("partial");
    expect(coverageLevel({ requirements: [req("partial")] })).toBe("partial");
    expect(coverageLevel({ requirements: [req("missing"), req("unclear")] })).toBe("not_covered");
    expect(coverageLevel({ requirements: [req("unclear"), req("met", false)] })).toBe("unclear");
    expect(coverageLevel({ requirements: [] })).toBe("unclear");
  });

  it("lists only missing core requirements as gaps", () => {
    const missing = missingCore({
      requirements: [req("missing"), req("missing", false), req("partial"), req("unclear")],
    });
    expect(missing).toEqual([req("missing")]);
  });

  it("refuses output with fields the checker can't set", () => {
    expect(ticketCoverageSchema.safeParse({ requirements: [], approve: true }).success).toBe(false);
    expect(
      ticketCoverageSchema.safeParse({
        requirements: [{ ...req("met"), severity: "blocking" }],
      }).success,
    ).toBe(false);
  });
});
