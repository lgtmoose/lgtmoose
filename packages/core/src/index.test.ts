import { describe, expect, it } from "vitest";
import { isSeverity, severityRank } from "./index.js";

describe("severityRank", () => {
  it("orders blocking before should_fix before nit", () => {
    expect(severityRank("blocking")).toBeLessThan(severityRank("should_fix"));
    expect(severityRank("should_fix")).toBeLessThan(severityRank("nit"));
  });
});

describe("isSeverity", () => {
  it("accepts known severities", () => {
    expect(isSeverity("nit")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isSeverity("critical")).toBe(false);
    expect(isSeverity(1)).toBe(false);
    expect(isSeverity(undefined)).toBe(false);
  });
});
