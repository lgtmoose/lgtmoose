import { Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { LGTMOOSE_VERSION, buildApp } from "./app.js";
import { EXAMPLE_CONFIG } from "./load-config.js";

describe("buildApp", () => {
  const config = parseDeployConfig({ ...EXAMPLE_CONFIG, region: "eu-west-2" });

  it("synthesizes the meta and network stacks in the configured region", () => {
    const { app, network } = buildApp(config);
    const stacks = app.synth().stacks;
    expect(stacks.map((s) => s.stackName).sort()).toEqual(["Lgtmoose-Meta", "Lgtmoose-Network"]);
    expect(network.region).toBe("eu-west-2");
  });

  it("records the deployed version", () => {
    const { meta } = buildApp(config);
    Template.fromStack(meta).hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/lgtmoose/version",
      Value: LGTMOOSE_VERSION,
    });
  });
});
