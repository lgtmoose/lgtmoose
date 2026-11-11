import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { LGTMOOSE_VERSION, buildApp } from "./app.js";
import type { MetaStack } from "./meta-stack.js";

describe("buildApp", () => {
  it("synthesizes the meta stack with the deployed version", () => {
    const app = buildApp();
    const stack = app.node.findChild("Lgtmoose-Meta") as MetaStack;
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/lgtmoose/version",
      Value: LGTMOOSE_VERSION,
    });
    expect(app.synth().stacks.map((s) => s.stackName)).toEqual(["Lgtmoose-Meta"]);
  });
});
