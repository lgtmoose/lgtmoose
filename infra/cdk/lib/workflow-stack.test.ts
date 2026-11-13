import { Match, Template } from "aws-cdk-lib/assertions";
import { SECRET_NAMES, STACK_OUTPUTS, parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp, type LgtmooseStacks } from "./app.js";
import { PROXY_URL } from "./proxy-stack.js";
import { appWithoutBundling } from "./test-utils.js";

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;

let stacks: LgtmooseStacks;
let template: Template;
let resources: Resources;

beforeAll(() => {
  const config = parseDeployConfig({
    allowedOrgs: ["lgtmoose"],
    providers: [
      { id: "claude", harness: "claude-code", auth: "oauth-token" },
      { id: "bedrock", harness: "claude-code", auth: "bedrock" },
    ],
  });
  stacks = buildApp(config, appWithoutBundling());
  template = Template.fromStack(stacks.workflow);
  resources = template.toJSON().Resources as Resources;
}, 120_000);

/** The logical ID a `{ Fn::GetAtt: [id, "Arn"] }` points at. */
function getAttId(value: unknown): string {
  const att = (value as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"];
  if (att === undefined) throw new Error(`not a GetAtt: ${JSON.stringify(value)}`);
  return att[0];
}

/** The control task definition, or the sandbox one whose LGTMOOSE_PROVIDER is `provider`. */
function taskDefinition(provider: string) {
  const entry = Object.entries(resources).find(([, r]) => {
    if (r.Type !== "AWS::ECS::TaskDefinition") return false;
    const [container] = r.Properties.ContainerDefinitions as {
      Name: string;
      Environment: { Name: string; Value: unknown }[];
    }[];
    if (provider === "control") return container?.Name === "control";
    return container?.Environment.some(
      (e) => e.Name === "LGTMOOSE_PROVIDER" && e.Value === provider,
    );
  });
  if (entry === undefined) throw new Error(`no task definition for ${provider}`);
  return entry[1].Properties;
}

/** Every statement in the IAM policies attached to a role. */
function statements(roleId: string): { Action: string | string[]; Resource: unknown }[] {
  return Object.values(resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .filter((r) => (r.Properties.Roles as { Ref: string }[]).some((role) => role.Ref === roleId))
    .flatMap(
      (r) =>
        (
          r.Properties.PolicyDocument as {
            Statement: { Action: string | string[]; Resource: unknown }[];
          }
        ).Statement,
    );
}

const actions = (list: { Action: string | string[] }[]) =>
  list.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe("WorkflowStack", () => {
  it("has one cluster, a control task and one sandbox task per provider", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
    template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
    expect(stacks.workflow.sandboxTaskDefinitions.size).toBe(2);
  });

  it("runs every container as hardened ARM64 Fargate: read-only root, no capabilities", () => {
    for (const name of ["control", "claude", "bedrock"]) {
      const def = taskDefinition(name);
      expect(def.RuntimePlatform).toEqual({
        CpuArchitecture: "ARM64",
        OperatingSystemFamily: "LINUX",
      });
      expect(def.RequiresCompatibilities).toEqual(["FARGATE"]);
      expect(def.NetworkMode).toBe("awsvpc");
      const [container] = def.ContainerDefinitions as Record<string, unknown>[];
      expect(container).toMatchObject({
        ReadonlyRootFilesystem: true,
        LinuxParameters: { Capabilities: { Drop: ["ALL"] }, InitProcessEnabled: true },
        MountPoints: [
          { ContainerPath: "/work", SourceVolume: "work", ReadOnly: false },
          { ContainerPath: "/tmp", SourceVolume: "tmp", ReadOnly: false },
        ],
      });
    }
  });

  it("lets the control task read the GitHub App and database secrets and the bucket", () => {
    const role = getAttId(taskDefinition("control").TaskRoleArn);
    const granted = statements(role);
    expect(actions(granted)).toEqual(
      expect.arrayContaining(["secretsmanager:GetSecretValue", "s3:PutObject", "s3:GetObject*"]),
    );
    expect(JSON.stringify(granted)).toContain(SECRET_NAMES.githubApp);
  });

  it("doesn't import the database endpoint, so the database can be replaced", () => {
    const [container] = taskDefinition("control").ContainerDefinitions as {
      Environment: { Name: string; Value: unknown }[];
    }[];
    const names = (container?.Environment ?? []).map((e) => e.Name);
    expect(names).toContain("DATABASE_SECRET_ARN");
    expect(names).not.toContain("DATABASE_HOST");
    // A cross-stack import of it would be named after the GetAtt: ...EndpointAddress...
    expect(JSON.stringify(template.toJSON())).not.toMatch(/Endpoint\.?Address/);
  });

  it("gives sandbox task roles no secrets, no S3, and Bedrock only when used", () => {
    for (const provider of ["claude", "bedrock"]) {
      const role = getAttId(taskDefinition(provider).TaskRoleArn);
      const granted = statements(role);
      expect(actions(granted).filter((a) => a.startsWith("secretsmanager:"))).toEqual([]);
      // One role serves every run, so S3 access couldn't be scoped to a run: presigned URLs.
      expect(actions(granted).filter((a) => a.startsWith("s3:"))).toEqual([]);
      const bedrock = actions(granted).filter((a) => a.startsWith("bedrock:"));
      expect(bedrock.length > 0).toBe(provider === "bedrock");
    }
  });

  it("injects only the task's own provider credential, read by its execution role", () => {
    const claude = taskDefinition("claude");
    const [container] = claude.ContainerDefinitions as { Secrets?: { Name: string }[] }[];
    expect(container?.Secrets?.map((s) => s.Name)).toEqual(["LGTMOOSE_PROVIDER_CREDENTIAL"]);
    const execution = statements(getAttId(claude.ExecutionRoleArn));
    const secretResources = JSON.stringify(
      execution.filter((s) => actions([s]).includes("secretsmanager:GetSecretValue")),
    );
    expect(secretResources).toContain(SECRET_NAMES.provider("claude"));
    expect(secretResources).not.toContain(SECRET_NAMES.githubApp);

    const bedrock = taskDefinition("bedrock");
    const [bedrockContainer] = bedrock.ContainerDefinitions as { Secrets?: unknown }[];
    expect(bedrockContainer?.Secrets).toBeUndefined();
  });

  it("sends sandbox traffic through the proxy, except to the AWS endpoints", () => {
    const [container] = taskDefinition("claude").ContainerDefinitions as {
      Environment: { Name: string; Value: unknown }[];
    }[];
    const env = Object.fromEntries((container?.Environment ?? []).map((e) => [e.Name, e.Value]));
    expect(env.HTTPS_PROXY).toBe(PROXY_URL);
    expect(env.ARTIFACT_BUCKET).toBeUndefined();
    expect(JSON.stringify(env.NO_PROXY)).toContain("169.254.170.2");
    expect(JSON.stringify(env.NO_PROXY)).toContain("127.0.0.1");
    expect(JSON.stringify(env.NO_PROXY)).not.toContain("bedrock");
  });

  it("outputs what the workflow needs to start tasks", () => {
    const outputs = template.toJSON().Outputs as Record<string, unknown>;
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(Object.values(STACK_OUTPUTS.workflow)),
    );
    template.hasOutput(STACK_OUTPUTS.workflow.sandboxTaskDefinitionArns, {
      Value: Match.objectLike({ "Fn::Join": Match.anyValue() }),
    });
    // A JSON object: provider id → task definition ARN, joined at deploy time.
    const arns = JSON.stringify(outputs[STACK_OUTPUTS.workflow.sandboxTaskDefinitionArns]);
    expect(arns).toContain('{\\"claude\\":\\"');
    expect(arns).toContain('\\"bedrock\\":\\"');
  });
});
