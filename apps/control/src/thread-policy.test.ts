import { describe, expect, it, vi } from "vitest";
import { needsTrustedResolver, resolutionHeld, toPermission } from "./thread-policy.js";

const blocking = { severity: "blocking" as const, ruleCategory: "correctness" };
const shouldFix = { severity: "should_fix" as const, ruleCategory: "correctness" };
const protectedNit = { severity: "nit" as const, ruleCategory: "tenant_scoping" };

describe("needsTrustedResolver", () => {
  it("covers blocking findings and protected categories only", () => {
    expect(needsTrustedResolver(blocking)).toBe(true);
    expect(needsTrustedResolver(protectedNit)).toBe(true);
    expect(needsTrustedResolver(shouldFix)).toBe(false);
  });
});

describe("resolutionHeld", () => {
  it("holds the PR's author resolving a blocking finding, without asking GitHub", async () => {
    const permission = vi.fn(async () => "admin" as const);
    expect(await resolutionHeld(blocking, "Dev", "dev", permission)).toBe("author");
    expect(permission).not.toHaveBeenCalled();
  });

  it("counts someone else with write access or higher", async () => {
    for (const level of ["write", "maintain", "admin"] as const) {
      expect(await resolutionHeld(blocking, "lead", "dev", async () => level)).toBeUndefined();
    }
  });

  it("holds someone without write access, or an unknown resolver", async () => {
    expect(await resolutionHeld(blocking, "fan", "dev", async () => "triage")).toBe(
      "no_write_access",
    );
    expect(await resolutionHeld(protectedNit, undefined, "dev", async () => "admin")).toBe(
      "unknown_resolver",
    );
  });

  it("lets anyone resolve a should_fix finding, the author included", async () => {
    const permission = vi.fn(async () => "none" as const);
    expect(await resolutionHeld(shouldFix, "dev", "dev", permission)).toBeUndefined();
    expect(permission).not.toHaveBeenCalled();
  });
});

describe("toPermission", () => {
  it("reads GitHub's names and treats anything else as none", () => {
    expect(toPermission("maintain")).toBe("maintain");
    expect(toPermission("constructor")).toBe("none");
    expect(toPermission(undefined)).toBe("none");
  });
});
