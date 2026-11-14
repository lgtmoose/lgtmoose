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

interface State {
  Type: string;
  Resource?: string;
  Next?: string;
  End?: boolean;
  TimeoutSeconds?: number;
  ResultPath?: string | null;
  MaxConcurrency?: number;
  ItemsPath?: string;
  Parameters?: Record<string, unknown>;
  Retry?: { ErrorEquals: string[]; MaxAttempts?: number; BackoffRate?: number }[];
  Catch?: { ErrorEquals: string[]; Next: string }[];
  ItemProcessor?: { StartAt: string; States: Record<string, State> };
  Branches?: { StartAt: string; States: Record<string, State> }[];
  Choices?: { Variable: string; BooleanEquals?: boolean; Next: string }[];
  Default?: string;
}

/** The state machine's definition, with deploy-time references replaced by "REF". */
function definition(): { StartAt: string; States: Record<string, State>; TimeoutSeconds: number } {
  const [machine] = Object.values(resources).filter(
    (r) => r.Type === "AWS::StepFunctions::StateMachine",
  );
  const body = machine?.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] };
  const text = body["Fn::Join"][1]
    .map((part) => (typeof part === "string" ? part : "REF"))
    .join("");
  return JSON.parse(text) as ReturnType<typeof definition>;
}

/** The states of one batch attempt: the Parallel branch inside the map. */
function batchStates(): Record<string, State> {
  return definition().States.Batches?.ItemProcessor?.States.Attempt?.Branches?.[0]?.States ?? {};
}

function overrides(state: State | undefined): Record<string, unknown> {
  const containers =
    (
      state?.Parameters?.Overrides as
        | {
            ContainerOverrides: {
              Environment: { Name: string; Value?: string; "Value.$"?: string }[];
            }[];
          }
        | undefined
    )?.ContainerOverrides ?? [];
  return Object.fromEntries(
    (containers[0]?.Environment ?? []).map((e) => [e.Name, e.Value ?? `$:${e["Value.$"]}`]),
  );
}

describe("review state machine", () => {
  it("prepares, maps the batches, then posts", () => {
    const { StartAt, States } = definition();
    expect(StartAt).toBe("Prepare");
    expect(States.Prepare?.Resource).toContain("ecs:runTask.waitForTaskToken");
    expect(States.Prepare?.Next).toBe("Superseded?");
    expect(States["Superseded?"]).toMatchObject({
      Choices: [{ Variable: "$.prepared.superseded", BooleanEquals: true, Next: "Superseded" }],
      Default: "Batches",
    });
    expect(States.Batches).toMatchObject({ Type: "Map", ItemsPath: "$.prepared.batches" });
    expect(States.Batches?.Next).toBe("Post");
    expect(States.Post).toMatchObject({ End: true });
    expect(States.Post?.Resource).toContain("ecs:runTask.sync");

    const items = States.Batches?.ItemProcessor;
    // Each attempt presigns afresh: Presign and Review run inside one retried Parallel.
    expect(items?.StartAt).toBe("Attempt");
    expect(items?.States.Attempt?.Type).toBe("Parallel");
    const attempt = batchStates();
    expect(attempt.Presign?.Next).toBe("Review");
    expect(attempt.Review?.Resource).toContain("ecs:runTask.sync");
  });

  it("caps the map at the configured concurrency", () => {
    expect(definition().States.Batches?.MaxConcurrency).toBe(4);
  });

  it("passes each step its command and the execution, and the job to prepare", () => {
    const { States } = definition();
    expect(overrides(States.Prepare)).toEqual({
      LGTMOOSE_EXECUTION_ARN: "$:$$.Execution.Id",
      LGTMOOSE_COMMAND: "prepare",
      LGTMOOSE_JOB: "$:States.JsonToString($$.Execution.Input)",
      LGTMOOSE_TASK_TOKEN: "$:$$.Task.Token",
    });
    expect(overrides(States.Post)).toMatchObject({
      LGTMOOSE_COMMAND: "post",
      LGTMOOSE_RUN_ID: "$:$.prepared.runId",
    });
    expect(overrides(States.MarkFailed)).toMatchObject({
      LGTMOOSE_COMMAND: "fail",
      LGTMOOSE_ERROR: "$:$.error.Error",
    });
    expect(overrides(batchStates().Review)).toEqual({
      LGTMOOSE_BATCH_URLS: "$:$.presigned.urls",
    });
  });

  it("starts sandbox tasks in the sandbox subnets, with the reviewer's task and no public IP", () => {
    const review = batchStates().Review;
    const network = (
      review?.Parameters?.NetworkConfiguration as
        | {
            AwsvpcConfiguration: {
              AssignPublicIp?: string;
              Subnets: unknown[];
              SecurityGroups: unknown[];
            };
          }
        | undefined
    )?.AwsvpcConfiguration ?? { AssignPublicIp: undefined, Subnets: [], SecurityGroups: [] };
    // CDK leaves AssignPublicIp out for `assignPublicIp: false`; RunTask defaults it to DISABLED.
    expect(network.AssignPublicIp ?? "DISABLED").toBe("DISABLED");
    expect(network.Subnets.length).toBeGreaterThan(0);
    // Every task the machine starts: no public addresses anywhere.
    const all = [...Object.values(definition().States), ...Object.values(batchStates())].filter(
      (s) => s.Resource?.includes("ecs:runTask"),
    );
    expect(all).toHaveLength(4);
    for (const state of all) {
      expect(JSON.stringify(state.Parameters?.NetworkConfiguration)).not.toContain("ENABLED");
    }
    // The first provider reviews by default: its family, not the Bedrock one.
    expect(review?.Parameters?.TaskDefinition).toBe(taskDefinition("claude").Family);
    expect(taskDefinition("claude").Family).not.toBe(taskDefinition("bedrock").Family);
  });

  it("times out and retries with backoff; post retries only tasks that never started", () => {
    const { States, TimeoutSeconds } = definition();
    // No execution timeout: it would skip the fail step. Each task bounds its own time.
    expect(TimeoutSeconds).toBeUndefined();
    const review = batchStates().Review;
    const attempt = States.Batches?.ItemProcessor?.States.Attempt;
    for (const state of [States.Prepare, States.Post, review, States.MarkFailed]) {
      expect(state?.TimeoutSeconds).toBeGreaterThan(0);
    }
    for (const state of [States.Prepare, States.Post, attempt, States.MarkFailed]) {
      expect(state?.Retry?.[0]?.BackoffRate).toBe(2);
    }
    expect(review?.TimeoutSeconds).toBe(30 * 60);
    // The attempt retries as a whole, so the sandbox task itself doesn't.
    expect(review?.Retry).toBeUndefined();
    expect(States.Post?.Retry?.flatMap((r) => r.ErrorEquals)).not.toContain("States.ALL");
    expect(States.Post?.Retry?.flatMap((r) => r.ErrorEquals)).not.toContain("States.TaskFailed");
  });

  it("marks the run failed and posts nothing when a step fails", () => {
    const { States } = definition();
    for (const name of ["Prepare", "Batches", "Post"]) {
      expect(States[name]?.Catch).toEqual([
        expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "MarkFailed" }),
      ]);
    }
    expect(States.MarkFailed?.Next).toBe("ReviewFailed");
    expect(States.ReviewFailed?.Type).toBe("Fail");
    // A batch that fails for good leaves no output; the review is incomplete, not failed.
    const items = States.Batches?.ItemProcessor?.States ?? {};
    expect(items.Attempt?.Catch?.[0]?.Next).toBe("BatchFailed");
  });

  it("logs without execution data, which holds task tokens and presigned URLs", () => {
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      LoggingConfiguration: Match.objectLike({ IncludeExecutionData: false }),
    });
  });

  it("scopes PassRole to the workflow's own task roles", () => {
    const machine = Object.values(resources).find(
      (r) => r.Type === "AWS::StepFunctions::StateMachine",
    );
    const role = getAttId(machine?.Properties.RoleArn);
    const passRole = statements(role).filter((s) => actions([s]).includes("iam:PassRole"));
    expect(passRole.length).toBeGreaterThan(0);
    for (const statement of passRole) {
      expect(JSON.stringify(statement.Resource)).not.toContain('"*"');
      expect(JSON.stringify(statement.Resource)).toContain("TaskRole");
    }
  });

  it("signs URLs with a presigner role that reaches only run objects, for a fixed hour", () => {
    const fn = Object.entries(resources).find(
      ([, r]) =>
        r.Type === "AWS::Lambda::Function" &&
        JSON.stringify(r.Properties.Environment).includes("LGTMOOSE_URL_TTL_SECONDS"),
    );
    const env =
      (fn?.[1].Properties.Environment as { Variables?: Record<string, unknown> } | undefined)
        ?.Variables ?? {};
    // One attempt (30 minutes) plus room to start, inside the one-hour session.
    expect(env.LGTMOOSE_URL_TTL_SECONDS).toBe("2700");
    expect(env.LGTMOOSE_PRESIGNER_SESSION_SECONDS).toBe("3600");
    const presignerId = getAttId(env.LGTMOOSE_PRESIGNER_ROLE_ARN);
    expect(resources[presignerId]?.Properties.MaxSessionDuration).toBe(3600);
    // The function itself can only assume the presigner role; it reaches no S3 on its own.
    const own = statements(getAttId(fn?.[1].Properties.Role));
    expect(actions(own).filter((a) => a.startsWith("s3:"))).toEqual([]);
    expect(actions(own)).toContain("sts:AssumeRole");
    const granted = statements(presignerId);
    const s3 = granted.filter((s) => actions([s]).some((a) => a.startsWith("s3:")));
    expect(s3.length).toBeGreaterThan(0);
    for (const statement of s3) {
      for (const resource of [statement.Resource].flat()) {
        expect(JSON.stringify(resource)).toContain("/runs/*");
      }
    }
    const control = statements(getAttId(taskDefinition("control").TaskRoleArn));
    expect(actions(control)).toEqual(
      expect.arrayContaining(["states:SendTaskSuccess", "states:SendTaskFailure"]),
    );
  });

  it("gives the control task the reviewer's model and shadow mode", () => {
    const [container] = taskDefinition("control").ContainerDefinitions as {
      Environment: { Name: string; Value: unknown }[];
    }[];
    const env = Object.fromEntries((container?.Environment ?? []).map((e) => [e.Name, e.Value]));
    expect(env).toMatchObject({
      LGTMOOSE_REVIEWER_MODEL: "sonnet",
      LGTMOOSE_SHADOW: "true",
      LGTMOOSE_BATCH_TIMEOUT_MS: String(20 * 60_000),
    });
  });
});
