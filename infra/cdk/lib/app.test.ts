import type { CloudAssembly } from "aws-cdk-lib/cx-api";
import { Match, Template } from "aws-cdk-lib/assertions";
import { STACK_NAMES, STACK_OUTPUTS, parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { LGTMOOSE_VERSION, buildApp, reviewerModel, type LgtmooseStacks } from "./app.js";
import { EXAMPLE_CONFIG } from "./load-config.js";
import { appWithoutBundling } from "./test-utils.js";

describe("buildApp", () => {
  let stacks: LgtmooseStacks;
  let assembly: CloudAssembly;

  // One full synth shared by every test; it's the slow part.
  beforeAll(() => {
    const config = parseDeployConfig({
      ...EXAMPLE_CONFIG,
      region: "eu-west-2",
      allowedOrgs: ["example-org", "second-org"],
    });
    stacks = buildApp(config, appWithoutBundling());
    assembly = stacks.app.synth();
  }, 60_000);

  it("uses the stack and output names the CLI drives", () => {
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual(
      Object.values(STACK_NAMES).sort(),
    );
    const outputs = (stack: { template: unknown }) =>
      Object.keys((stack.template as { Outputs?: object }).Outputs ?? {});
    expect(outputs(assembly.getStackByName(STACK_NAMES.api))).toContain(
      STACK_OUTPUTS.api.githubWebhookUrl,
    );
    expect(outputs(assembly.getStackByName(STACK_NAMES.data))).toEqual(
      expect.arrayContaining(Object.values(STACK_OUTPUTS.data)),
    );
    expect(outputs(assembly.getStackByName(STACK_NAMES.workflow))).toEqual(
      expect.arrayContaining(Object.values(STACK_OUTPUTS.workflow)),
    );
  });

  it("synthesizes every stack in the configured region", () => {
    expect(assembly.stacks.map((s) => s.stackName).sort()).toEqual([
      "Lgtmoose-Api",
      "Lgtmoose-Data",
      "Lgtmoose-Meta",
      "Lgtmoose-Network",
      "Lgtmoose-Proxy",
      "Lgtmoose-Workflow",
    ]);
    expect(stacks.network.region).toBe("eu-west-2");
  });

  it("deploys the Api and Workflow stacks after the Data stack, so migrations run first", () => {
    expect(stacks.api.dependencies).toContain(stacks.data);
    expect(stacks.workflow.dependencies).toContain(stacks.data);
  });

  it("passes the config's allowed orgs to the gateway", () => {
    Template.fromStack(stacks.api).hasResourceProperties("AWS::Lambda::Function", {
      Environment: { Variables: Match.objectLike({ ALLOWED_ORGS: "example-org,second-org" }) },
    });
  });

  it("records the deployed version", () => {
    Template.fromStack(stacks.meta).hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/lgtmoose/version",
      Value: LGTMOOSE_VERSION,
    });
  });
});

describe("reviewerModel", () => {
  it("uses the provider's standard tier, else the harness's default", () => {
    expect(
      reviewerModel({
        id: "c",
        harness: "claude-code",
        auth: "api-key",
        models: { standard: "opus" },
      }),
    ).toBe("opus");
    expect(reviewerModel({ id: "c", harness: "claude-code", auth: "api-key" })).toBe("sonnet");
    expect(reviewerModel({ id: "x", harness: "codex", auth: "api-key" })).toBe("");
  });
});
