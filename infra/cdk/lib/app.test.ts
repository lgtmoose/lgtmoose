import type { CloudAssembly } from "aws-cdk-lib/cx-api";
import { Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { LGTMOOSE_VERSION, buildApp, type LgtmooseStacks } from "./app.js";
import { EXAMPLE_CONFIG } from "./load-config.js";
import { appWithoutBundling } from "./test-utils.js";

describe("buildApp", () => {
  let stacks: LgtmooseStacks;
  let assembly: CloudAssembly;

  // One full synth shared by every test; it's the slow part.
  beforeAll(() => {
    const config = parseDeployConfig({ ...EXAMPLE_CONFIG, region: "eu-west-2" });
    stacks = buildApp(config, appWithoutBundling());
    assembly = stacks.app.synth();
  }, 60_000);

  it("synthesizes every stack in the configured region", () => {
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual([
      "Lgtmoose-Api",
      "Lgtmoose-Data",
      "Lgtmoose-Meta",
      "Lgtmoose-Network",
    ]);
    expect(stacks.network.region).toBe("eu-west-2");
  });

  it("deploys the Api stack after the Data stack, so migrations run first", () => {
    expect(stacks.api.dependencies).toContain(stacks.data);
  });

  it("records the deployed version", () => {
    Template.fromStack(stacks.meta).hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/lgtmoose/version",
      Value: LGTMOOSE_VERSION,
    });
  });
});
