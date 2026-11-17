import { describe, expect, it } from "vitest";
import { cloudFormationLookup, isUpdatable } from "./aws-cloudformation.js";

describe("cloudFormationLookup", () => {
  it("returns a stack's status and outputs", async () => {
    const lookup = cloudFormationLookup(
      {
        send: () =>
          Promise.resolve({
            Stacks: [
              {
                StackStatus: "UPDATE_COMPLETE",
                Outputs: [{ OutputKey: "DatabaseIdentifier", OutputValue: "db-1" }],
              },
            ],
          }),
      },
      "us-east-1",
    );
    await expect(lookup.describe("Lgtmoose-Data")).resolves.toEqual({
      status: "UPDATE_COMPLETE",
      outputs: { DatabaseIdentifier: "db-1" },
    });
  });

  it("treats a missing stack as undefined and anything else as an error", async () => {
    const missing = cloudFormationLookup(
      { send: () => Promise.reject(new Error("Stack with id CDKToolkit does not exist")) },
      "us-east-1",
    );
    await expect(missing.describe("CDKToolkit")).resolves.toBeUndefined();
    const denied = cloudFormationLookup(
      { send: () => Promise.reject(new Error("AccessDenied")) },
      "eu-west-1",
    );
    await expect(denied.describe("CDKToolkit")).rejects.toThrow("CloudFormation (eu-west-1)");
  });
});

describe("physicalIds", () => {
  it("returns the ids of one resource type, and nothing for a missing stack", async () => {
    const lookup = cloudFormationLookup(
      {
        send: () =>
          Promise.resolve({
            StackResources: [
              { ResourceType: "AWS::RDS::DBInstance", PhysicalResourceId: "db-1" },
              { ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "bucket-1" },
              { ResourceType: "AWS::RDS::DBInstance" },
            ],
          }),
      },
      "us-east-1",
    );
    await expect(lookup.physicalIds("Lgtmoose-Data", "AWS::RDS::DBInstance")).resolves.toEqual([
      "db-1",
    ]);
    const missing = cloudFormationLookup(
      { send: () => Promise.reject(new Error("Stack with id Lgtmoose-Data does not exist")) },
      "us-east-1",
    );
    await expect(missing.physicalIds("Lgtmoose-Data", "AWS::RDS::DBInstance")).resolves.toEqual([]);
  });
});

describe("isUpdatable", () => {
  it("accepts only stacks that finished and still have resources", () => {
    for (const status of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]) {
      expect(isUpdatable(status)).toBe(true);
    }
    for (const status of [
      undefined,
      "DELETE_COMPLETE",
      "ROLLBACK_COMPLETE",
      "REVIEW_IN_PROGRESS",
      "CREATE_FAILED",
      "DELETE_FAILED",
      "DELETE_IN_PROGRESS",
      "UPDATE_ROLLBACK_FAILED",
      "UPDATE_IN_PROGRESS",
    ]) {
      expect(isUpdatable(status)).toBe(false);
    }
  });
});
