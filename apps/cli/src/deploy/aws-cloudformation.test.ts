import { describe, expect, it } from "vitest";
import { cloudFormationLookup, isUsable } from "./aws-cloudformation.js";

describe("cloudFormationLookup", () => {
  it("returns a stack's status", async () => {
    const lookup = cloudFormationLookup(
      { send: () => Promise.resolve({ Stacks: [{ StackStatus: "UPDATE_COMPLETE" }] }) },
      "us-east-1",
    );
    await expect(lookup.status("CDKToolkit")).resolves.toBe("UPDATE_COMPLETE");
  });

  it("treats a missing stack as undefined and anything else as an error", async () => {
    const missing = cloudFormationLookup(
      { send: () => Promise.reject(new Error("Stack with id CDKToolkit does not exist")) },
      "us-east-1",
    );
    await expect(missing.status("CDKToolkit")).resolves.toBeUndefined();
    const denied = cloudFormationLookup(
      { send: () => Promise.reject(new Error("AccessDenied")) },
      "eu-west-1",
    );
    await expect(denied.status("CDKToolkit")).rejects.toThrow("CloudFormation (eu-west-1)");
  });
});

describe("isUsable", () => {
  it("rejects stacks that are gone or never finished creating", () => {
    expect(isUsable("CREATE_COMPLETE")).toBe(true);
    expect(isUsable("UPDATE_ROLLBACK_COMPLETE")).toBe(true);
    for (const status of [
      undefined,
      "DELETE_COMPLETE",
      "ROLLBACK_COMPLETE",
      "REVIEW_IN_PROGRESS",
    ]) {
      expect(isUsable(status)).toBe(false);
    }
  });
});
