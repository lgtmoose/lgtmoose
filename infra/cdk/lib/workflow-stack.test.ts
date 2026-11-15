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
  SecondsPath?: string;
  HeartbeatSeconds?: number;
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
  it("debounces, prepares, maps the batches, then posts", () => {
    const { StartAt, States } = definition();
    expect(StartAt).toBe("Debounce");
    expect(States.Debounce).toMatchObject({
      Type: "Wait",
      SecondsPath: "$.debounceSeconds",
      Next: "Prepare",
    });
    expect(States.Prepare?.Resource).toContain("ecs:runTask.waitForTaskToken");
    expect(States.Prepare?.Next).toBe("Superseded?");
    expect(States["Superseded?"]).toMatchObject({
      Choices: [{ Variable: "$.prepared.superseded", BooleanEquals: true, Next: "Superseded" }],
      Default: "Batches",
    });
    expect(States.Batches).toMatchObject({ Type: "Map", ItemsPath: "$.prepared.batches" });
    expect(States.Batches?.Next).toBe("Post");
    expect(States.Post).toMatchObject({ End: true });
    // A stop mustn't cut a post short: post reports on a task token instead of `.sync`.
    expect(States.Post?.Resource).toContain("ecs:runTask.waitForTaskToken");
    // A control task that dies before reporting fails the step in minutes, not half an hour,
    // with room for a cold Fargate start before the first heartbeat.
    expect(States.Post?.HeartbeatSeconds).toBe(300);
    // Post resumes from its recorded progress, so a failed write or a dead task is retried,
    // without jitter, for longer in all than the heartbeat timeout.
    const retry = States.Post?.Retry?.[1] as
      | {
          IntervalSeconds?: number;
          MaxAttempts?: number;
          BackoffRate?: number;
          JitterStrategy?: string;
        }
      | undefined;
    expect(retry?.JitterStrategy ?? "NONE").toBe("NONE");
    const waits = Array.from(
      { length: retry?.MaxAttempts ?? 0 },
      (_, i) => (retry?.IntervalSeconds ?? 0) * (retry?.BackoffRate ?? 1) ** i,
    );
    expect(waits.reduce((sum, wait) => sum + wait, 0)).toBeGreaterThan(
      States.Post?.HeartbeatSeconds ?? Infinity,
    );
    expect(States.Post?.Retry?.map((retry) => retry.ErrorEquals)).toEqual([
      ["ECS.AmazonECSException", "ECS.ServerException"],
      ["Lgtmoose.PostFailed", "States.HeartbeatTimeout"],
    ]);
    expect(States.Prepare?.HeartbeatSeconds).toBe(300);
    expect(overrides(States.Post).LGTMOOSE_TASK_TOKEN).toBe("$:$$.Task.Token");

    const items = States.Batches?.ItemProcessor;
    // Each attempt presigns afresh: Presign and Review run inside one retried Parallel.
    expect(items?.StartAt).toBe("Attempt");
    expect(items?.States.Attempt?.Type).toBe("Parallel");
    const attempt = batchStates();
    expect(attempt.Presign?.Next).toBe("Review");
    expect(attempt.Review?.Resource).toContain("ecs:runTask.sync");
  });

  it("caps the map at the configured concurrency, or the reviewer credential's if lower", () => {
    // maxConcurrency is 4 by default; the reviewer's Claude plan token allows 2 at once.
    expect(definition().States.Batches?.MaxConcurrency).toBe(2);
    const bedrockFirst = parseDeployConfig({
      allowedOrgs: ["lgtmoose"],
      maxConcurrency: 6,
      providers: [{ id: "bedrock", harness: "claude-code", auth: "bedrock" }],
    });
    const machine = Object.values(
      Template.fromStack(buildApp(bedrockFirst, appWithoutBundling()).workflow).toJSON()
        .Resources as Resources,
    ).find((r) => r.Type === "AWS::StepFunctions::StateMachine");
    const body = machine?.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] };
    const text = body["Fn::Join"][1].map((p) => (typeof p === "string" ? p : "REF")).join("");
    // Bedrock has no stored credential to limit it.
    expect((JSON.parse(text) as ReturnType<typeof definition>).States.Batches?.MaxConcurrency).toBe(
      6,
    );
  }, 120_000);

  it("falls back to the next provider when a batch hits a limit, and fails it after the last", () => {
    const items = definition().States.Batches?.ItemProcessor?.States ?? {};
    // The reviewer's attempt, then a look at its output.
    expect(items.Attempt?.Next).toBe("CheckOutcome");
    expect(items.CheckOutcome?.Parameters).toMatchObject({
      action: "outcome",
      "runId.$": "$.runId",
      "index.$": "$.index",
      providerId: "claude",
    });
    expect(items["FallBack?"]).toMatchObject({
      Choices: [{ Variable: "$.outcome.fallback", BooleanEquals: true, Next: "Attempt-bedrock" }],
      Default: "BatchDone",
    });
    // An attempt that failed outright moves on too.
    expect(items.Attempt?.Catch?.[0]?.Next).toBe("Attempt-bedrock");
    // The last provider's outcome stands, and a failure there fails the batch.
    expect(items["Attempt-bedrock"]?.Next).toBeUndefined();
    expect(items["Attempt-bedrock"]?.End).toBe(true);
    expect(items["Attempt-bedrock"]?.Catch?.[0]?.Next).toBe("BatchFailed");
    // Each provider's attempt runs its own sandbox task.
    const branch = items["Attempt-bedrock"]?.Branches?.[0]?.States ?? {};
    expect(branch["Review-bedrock"]?.Parameters?.TaskDefinition).toBe(
      taskDefinition("bedrock").Family,
    );
    // Bedrock has no stored credential: nothing to lease.
    expect(branch["Lease-bedrock"]).toBeUndefined();
  });

  it("gives each sandbox task its own provider's model", () => {
    const model = (provider: string) =>
      (
        (
          taskDefinition(provider).ContainerDefinitions as {
            Environment: { Name: string; Value: unknown }[];
          }[]
        )[0]?.Environment ?? []
      ).find((e) => e.Name === "LGTMOOSE_MODEL")?.Value;
    expect(model("claude")).toBe("sonnet");
    expect(model("bedrock")).toBe("sonnet");
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
    for (const state of [States.Prepare, States.Post, States.MarkFailed]) {
      expect(state?.Retry?.[0]?.BackoffRate).toBe(2);
    }
    // An attempt isn't retried for a busy or unusable credential (the lease waits on its own),
    // and is retried with backoff for anything else.
    expect(attempt?.Retry?.[0]).toMatchObject({
      ErrorEquals: ["Lgtmoose.CredentialBusy", "Lgtmoose.CredentialUnavailable"],
      MaxAttempts: 0,
    });
    expect(attempt?.Retry?.[1]).toMatchObject({ ErrorEquals: ["States.ALL"], BackoffRate: 2 });
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
    // A batch that fails for good, on every provider, leaves no output; the review is
    // incomplete, not failed.
    const items = States.Batches?.ItemProcessor?.States ?? {};
    expect(items["Attempt-bedrock"]?.Catch?.[0]?.Next).toBe("BatchFailed");
    expect(items.BatchFailed?.Type).toBe("Pass");
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
      expect.arrayContaining([
        "states:SendTaskSuccess",
        "states:SendTaskFailure",
        "states:DescribeExecution",
        "ecs:DescribeTasks",
      ]),
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

describe("dispatcher", () => {
  function dispatcher() {
    const entry = Object.entries(resources).find(
      ([, r]) =>
        r.Type === "AWS::Lambda::Function" &&
        JSON.stringify(r.Properties.Environment).includes("STATE_MACHINE_ARN"),
    );
    if (entry === undefined) throw new Error("no dispatcher function");
    return entry;
  }

  it("consumes the job queue in batches with partial failures", () => {
    const [id] = dispatcher();
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionName: { Ref: id },
      BatchSize: 10,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
  });

  it("runs in the VPC with the control security group, inside the queue's visibility", () => {
    const [, fn] = dispatcher();
    expect(fn.Properties.VpcConfig).toBeDefined();
    expect(fn.Properties.Timeout).toBeLessThanOrEqual(50);
  });

  it("may start, list and stop review executions and read only the database secret", () => {
    const [, fn] = dispatcher();
    const granted = statements(getAttId(fn.Properties.Role));
    expect(actions(granted)).toEqual(
      expect.arrayContaining([
        "states:StartExecution",
        "states:StopExecution",
        "states:DescribeExecution",
        "secretsmanager:GetSecretValue",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:SendMessage",
      ]),
    );
    // It sends to the dead-letter queue and the conversation queue, never to the job queue it
    // consumes.
    const sends = granted.filter((s) => actions([s]).includes("sqs:SendMessage"));
    expect(sends.map((s) => JSON.stringify(s.Resource)).sort()).toEqual([
      expect.stringContaining("ConversationQueue"),
      expect.stringContaining("JobDeadLetterQueue"),
    ]);
    expect(JSON.stringify(sends)).not.toContain('"JobQueue');
    const secrets = granted.filter((s) => actions([s]).includes("secretsmanager:GetSecretValue"));
    expect(secrets).toHaveLength(1);
    expect(actions(granted).some((a) => a.startsWith("s3:"))).toBe(false);
    const stop = granted.find((s) => actions([s]).includes("states:StopExecution"));
    expect(JSON.stringify(stop?.Resource)).toContain(":execution:");
    // It finds a PR's executions in the database, never by listing the state machine's.
    expect(actions(granted)).not.toContain("states:ListExecutions");
  });
});

describe("conversation", () => {
  function conversation() {
    const entry = Object.entries(resources).find(
      ([, r]) =>
        r.Type === "AWS::Lambda::Function" &&
        JSON.stringify(r.Properties.Description ?? "").includes("@lgtmoose commands"),
    );
    if (entry === undefined) throw new Error("no conversation function");
    return entry;
  }

  it("has a FIFO queue with a dead-letter queue and an alarm on it", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      ContentBasedDeduplication: false,
      RedrivePolicy: { maxReceiveCount: 5 },
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmDescription: Match.stringLikeRegexp("comment jobs failed"),
    });
  });

  it("consumes the conversation queue with partial failures, in the VPC, with shadow mode", () => {
    const [id, fn] = conversation();
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionName: { Ref: id },
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    expect(fn.Properties.VpcConfig).toBeDefined();
    const env = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env).toMatchObject({ LGTMOOSE_SHADOW: "true" });
  });

  it("may send to the job queue and read the database and App secrets, and nothing else", () => {
    const [, fn] = conversation();
    const granted = statements(getAttId(fn.Properties.Role));
    const sends = granted.filter((s) => actions([s]).includes("sqs:SendMessage"));
    expect(sends.map((s) => JSON.stringify(s.Resource))).toEqual([
      expect.stringContaining("JobQueue"),
    ]);
    const secrets = granted.filter((s) => actions([s]).includes("secretsmanager:GetSecretValue"));
    expect(secrets).toHaveLength(2);
    expect(actions(granted).some((a) => a.startsWith("s3:") || a.startsWith("states:"))).toBe(
      false,
    );
    expect(actions(granted).some((a) => a.startsWith("bedrock:"))).toBe(false);
  });
});

describe("reconciler", () => {
  function reconciler() {
    const entry = Object.entries(resources).find(
      ([, r]) =>
        r.Type === "AWS::Lambda::Function" &&
        JSON.stringify(r.Properties.Environment).includes("ALLOWED_ORGS"),
    );
    if (entry === undefined) throw new Error("no reconciler function");
    return entry;
  }

  it("runs every 30 minutes by default, without retries", () => {
    const [id] = reconciler();
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(30 minutes)",
      State: "ENABLED",
      Target: {
        Arn: { "Fn::GetAtt": [id, "Arn"] },
        RetryPolicy: { MaximumRetryAttempts: 0 },
      },
    });
  });

  it("runs one at a time in the VPC, with the allowed orgs and shadow mode", () => {
    const [, fn] = reconciler();
    expect(fn.Properties.VpcConfig).toBeDefined();
    expect(fn.Properties.ReservedConcurrentExecutions).toBe(1);
    const env = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env).toMatchObject({
      ALLOWED_ORGS: "lgtmoose",
      LGTMOOSE_SHADOW: "true",
      RECONCILE_LOOKBACK_HOURS: "24",
    });
  });

  it("may send to the job queue and read the database and App secrets, and nothing else", () => {
    const [, fn] = reconciler();
    const granted = statements(getAttId(fn.Properties.Role));
    const sends = granted.filter((s) => actions([s]).includes("sqs:SendMessage"));
    expect(sends.map((s) => JSON.stringify(s.Resource))).toEqual([
      expect.stringContaining("JobQueue"),
    ]);
    const secrets = granted.filter((s) => actions([s]).includes("secretsmanager:GetSecretValue"));
    expect(secrets).toHaveLength(2);
    expect(actions(granted).some((a) => a.startsWith("s3:") || a.startsWith("states:"))).toBe(
      false,
    );
    expect(actions(granted)).not.toContain("sqs:ReceiveMessage");
  });

  it("takes its interval from the config", () => {
    const config = parseDeployConfig({
      allowedOrgs: ["lgtmoose"],
      providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
      reconcileIntervalMinutes: 15,
    });
    const other = Template.fromStack(buildApp(config, appWithoutBundling()).workflow);
    other.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(15 minutes)",
    });
  }, 120_000);
});

describe("learnings embeddings", () => {
  /** The control container's environment, its task role's statements, and the sandboxes'. */
  function inspect(from: Template) {
    const all = from.toJSON().Resources as Resources;
    const definitions = Object.values(all).filter((r) => r.Type === "AWS::ECS::TaskDefinition");
    const isControl = (r: Resources[string]) =>
      (r.Properties.ContainerDefinitions as { Name: string }[])[0]?.Name === "control";
    const definition = definitions.find(isControl);
    if (definition === undefined) throw new Error("no control task definition");
    const [container] = definition.Properties.ContainerDefinitions as {
      Environment: { Name: string; Value: unknown }[];
    }[];
    const env = Object.fromEntries((container?.Environment ?? []).map((e) => [e.Name, e.Value]));
    const policiesOf = (roleId: string) =>
      Object.values(all)
        .filter((r) => r.Type === "AWS::IAM::Policy")
        .filter((r) =>
          (r.Properties.Roles as { Ref: string }[]).some((role) => role.Ref === roleId),
        )
        .flatMap(
          (r) =>
            (
              r.Properties.PolicyDocument as {
                Statement: { Action: string | string[]; Resource: unknown }[];
              }
            ).Statement,
        );
    const granted = policiesOf(getAttId(definition.Properties.TaskRoleArn));
    const sandboxes = definitions
      .filter((r) => !isControl(r))
      .flatMap((r) => [
        ...policiesOf(getAttId(r.Properties.TaskRoleArn)),
        ...policiesOf(getAttId(r.Properties.ExecutionRoleArn)),
      ]);
    return { env, granted, sandboxes: JSON.stringify(sandboxes) };
  }

  function build(embeddings: unknown): Template {
    const config = parseDeployConfig({
      allowedOrgs: ["lgtmoose"],
      providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
      learnings: { embeddings },
    });
    return Template.fromStack(buildApp(config, appWithoutBundling()).workflow);
  }

  it("ranks by keyword by default, with no embeddings access", () => {
    const { env, granted } = inspect(template);
    expect(env.LGTMOOSE_EMBEDDINGS).toBe("none");
    expect(env).not.toHaveProperty("LGTMOOSE_EMBEDDINGS_SECRET_ID");
    expect(JSON.stringify(granted)).not.toContain("titan-embed");
  });

  it("lets only the control task call the Titan model it's configured with", () => {
    const { env, granted, sandboxes } = inspect(build({ provider: "bedrock" }));
    expect(env.LGTMOOSE_EMBEDDINGS).toBe("bedrock:amazon.titan-embed-text-v2:0");
    const invoke = granted.filter((s) => actions([s]).includes("bedrock:InvokeModel"));
    expect(JSON.stringify(invoke)).toContain("foundation-model/amazon.titan-embed-text-v2:0");
    expect(JSON.stringify(invoke)).not.toContain("*");
    expect(sandboxes).not.toContain("titan-embed");
  }, 120_000);

  it("gives the control task the OpenAI key by its secret's name, and only it", () => {
    const { env, granted, sandboxes } = inspect(build({ provider: "openai" }));
    expect(env).toMatchObject({
      LGTMOOSE_EMBEDDINGS: "openai:text-embedding-3-small",
      LGTMOOSE_EMBEDDINGS_SECRET_ID: SECRET_NAMES.openAiEmbeddings,
    });
    const reads = granted.filter((s) => actions([s]).includes("secretsmanager:GetSecretValue"));
    expect(JSON.stringify(reads)).toContain(SECRET_NAMES.openAiEmbeddings);
    expect(sandboxes).not.toContain(SECRET_NAMES.openAiEmbeddings);
  }, 120_000);
});
