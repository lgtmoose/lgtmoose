import { describe, expect, it } from "vitest";
import { isInside } from "./paths.js";

describe("isInside", () => {
  it("is true for the dir itself and paths below it", () => {
    expect(isInside("/work/checkout", "/work/checkout")).toBe(true);
    expect(isInside("/work/checkout", "/work/checkout/src/a.ts")).toBe(true);
  });

  it("counts names that only start with dots as inside", () => {
    expect(isInside("/work/checkout", "/work/checkout/..data")).toBe(true);
    expect(isInside("/work/checkout", "/work/checkout/...")).toBe(true);
  });

  it("is false for parents, siblings and lookalike prefixes", () => {
    expect(isInside("/work/checkout", "/work")).toBe(false);
    expect(isInside("/work/checkout", "/work/other")).toBe(false);
    expect(isInside("/work/checkout", "/work/checkout2")).toBe(false);
    expect(isInside("/home", "/homework")).toBe(false);
  });
});
