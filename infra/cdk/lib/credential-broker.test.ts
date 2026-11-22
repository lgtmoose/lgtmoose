import { Template } from "aws-cdk-lib/assertions";
import { SECRET_NAMES, parseDeployConfig, type DeployConfigInput } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { appWithoutBundling } from "./test-utils.js";

type Resources = Record<
  string,
  { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string }
>;
type Statement = { Action: string | string[]; Resource: unknown };

interface State {
  Type: string;
  Next?: string;
  Error?: string;
  Parameters?: Record<string, unknown>;
  Retry?: Record<string, unknown>[];
  Catch?: { ErrorEquals: string[]; Next: string }[];
  ItemProcessor?: { States: Record<string, State> };
  Branches?: { StartAt: string; States: Record<string, State> }[];
}

/** The workflow stack's resources for a config with these providers (the first reviews). */
function synth(providers: DeployConfigInput["providers"]) {
  const config = parseDeployConfig({ allowedOrgs: ["lgtmoose"], providers });
  const template = Template.fromStack(buildApp(config, appWithoutBundling()).workflow);
  const resources = template.toJSON().Resources as Resources;

  const functionWith = (name: string, without?: string) => {
    const entry = Object.entries(resources).find(([, r]) => {
      const env = JSON.stringify(r.Properties.Environment ?? {});
      return (
        r.Type === "AWS::Lambda::Function" &&
        env.includes(name) &&
        (without === undefined || !env.includes(without))
      );
    });
    if (entry === undefined) return undefined;
    const variables =
      (entry[1].Properties.Environment as { Variables?: Record<string, unknown> }).Variables ?? {};
    return { id: entry[0], fn: entry[1], env: variables };
  };
  const statements = (fn: Resources[string]): Statement[] => {
    const role = (fn.Properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    return Object.values(resources)
      .filter((r) => r.Type === "AWS::IAM::Policy")
      .filter((r) => (r.Properties.Roles as { Ref: string }[]).some((ref) => ref.Ref === role))
      .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  };
  const batchStates = (): Record<string, State> => {
    const [machine] = Object.values(resources).filter(
      (r) => r.Type === "AWS::StepFunctions::StateMachine",
    );
    const body = machine?.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] };
    const text = body["Fn::Join"][1].map((p) => (typeof p === "string" ? p : "REF")).join("");
    const { States } = JSON.parse(text) as { States: Record<string, State> };
    return States.Batches?.ItemProcessor?.States.Attempt?.Branches?.[0]?.States ?? {};
  };
  return {
    template,
    resources,
    broker: () => functionWith("LGTMOOSE_LEASE_TTL_SECONDS"),
    health: () => functionWith("LGTMOOSE_CREDENTIALS", "LGTMOOSE_LEASE_TTL_SECONDS"),
    statements,
    batchStates,
  };
}

const actions = (list: Statement[]) =>
  list.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

/** An environment value as text, with deploy-time references (an ARN, say) as "REF". */
function envText(value: unknown): string {
  if (typeof value === "string") return value;
  const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
  if (join === undefined) return "REF";
  return join[1].map((part) => (typeof part === "string" ? part : "REF")).join(join[0]);
}

describe("credential broker", () => {
  let stack: ReturnType<typeof synth>;
  beforeAll(() => {
    stack = synth([
      { id: "claude", harness: "claude-code", auth: "oauth-token" },
      { id: "bedrock", harness: "claude-code", auth: "bedrock" },
    ]);
  }, 120_000);

  it("leases the credential around each sandbox attempt, and gives it back either way", () => {
    const states = stack.batchStates();
    expect(states.Lease?.Next).toBe("Presign");
    expect(states.Presign?.Next).toBe("Review");
    expect(states.Review?.Next).toBe("Release");
    expect(states.Release?.Next).toBe("Released");
    for (const name of ["Presign", "Review"]) {
      expect(states[name]?.Catch).toEqual([
        expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "ReleaseAfterFailure" }),
      ]);
    }
    expect(states.ReleaseAfterFailure?.Next).toBe("AttemptFailed");
    expect(states.AttemptFailed).toMatchObject({ Type: "Fail", Error: "Lgtmoose.SandboxFailed" });
    // A release that keeps failing leaves the lease to expire; the review isn't run again.
    expect(states.Release?.Catch).toEqual([
      expect.objectContaining({ ErrorEquals: ["States.ALL"], Next: "Released" }),
    ]);
    const payload = (name: string) => states[name]?.Parameters;
    expect(payload("Lease")).toEqual({
      action: "acquire",
      providerId: "claude",
      "runId.$": "$.runId",
      "index.$": "$.index",
      "executionArn.$": "$$.Execution.Id",
    });
    expect(payload("Release")).toMatchObject({ action: "release", "lease.$": "$.lease" });
    // Only a ChatGPT sign-in's task gets a URL to hand a refreshed credential back.
    expect(payload("Presign")).toEqual({ "runId.$": "$.runId", "index.$": "$.index" });
  });

  it("waits for a free slot for hours, asking again up to two minutes apart", () => {
    const busy = stack
      .batchStates()
      .Lease?.Retry?.find((r) => (r.ErrorEquals as string[]).includes("Lgtmoose.CredentialBusy"));
    expect(busy).toMatchObject({
      ErrorEquals: ["Lgtmoose.CredentialBusy"],
      IntervalSeconds: 20,
      MaxDelaySeconds: 120,
    });
    expect(busy?.MaxAttempts).toBeGreaterThanOrEqual(90);
  });

  it("limits the credential to its concurrency, with a lease that outlives an attempt", () => {
    const env = stack.broker()?.env ?? {};
    const credentials = JSON.parse(envText(env.LGTMOOSE_CREDENTIALS)) as Record<string, unknown>;
    expect(Object.keys(credentials)).toEqual(["claude"]);
    expect(credentials.claude).toMatchObject({
      auth: "oauth-token",
      limit: 2,
      secretId: SECRET_NAMES.provider("claude"),
    });
    // An attempt may run 30 minutes.
    expect(Number(env.LGTMOOSE_LEASE_TTL_SECONDS)).toBeGreaterThan(30 * 60);
  });

  it("reaches only leases and batch objects, and never a credential's value", () => {
    const granted = stack.statements(stack.broker()!.fn);
    const s3 = granted.filter((s) => actions([s]).some((a) => a.startsWith("s3:")));
    expect(s3.length).toBeGreaterThan(0);
    for (const statement of s3) {
      for (const resource of [statement.Resource].flat()) {
        expect(JSON.stringify(resource)).toMatch(
          /credentials\/leases\/\*|runs\/\*\/batches\/\*\/(output|credential)\.json/,
        );
      }
    }
    const deletes = s3.filter((s) => actions([s]).includes("s3:DeleteObject"));
    expect(JSON.stringify(deletes.map((s) => s.Resource))).not.toContain("output.json");
    const secrets = granted.filter((s) =>
      actions([s]).some((a) => a.startsWith("secretsmanager:")),
    );
    expect(actions(secrets).sort()).toEqual([
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
    ]);
    for (const statement of secrets) {
      expect(JSON.stringify(statement.Resource)).toContain(
        `${SECRET_NAMES.provider("claude")}-??????`,
      );
    }
    // It tells a stopped holder by its execution: this state machine's executions only.
    const describe = granted.find((s) => actions([s]).includes("states:DescribeExecution"));
    expect(JSON.stringify(describe?.Resource)).toContain(":execution:");
    expect(JSON.stringify(describe?.Resource)).not.toContain('"*"');
  });

  it("keeps its audit log, and for longer than the other logs", () => {
    const fn = stack.broker()!.fn;
    const group = (fn.Properties.LoggingConfig as { LogGroup: { Ref: string } }).LogGroup.Ref;
    expect(stack.resources[group]).toMatchObject({
      Properties: { RetentionInDays: 90 },
      DeletionPolicy: "Retain",
    });
  });

  it("checks stored credentials every 6 hours without reading them, and alarms per provider", () => {
    const health = stack.health();
    const credentials = JSON.parse(envText(health?.env.LGTMOOSE_CREDENTIALS)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(credentials)).toEqual(["claude"]);
    expect(credentials.claude).toMatchObject({ secretId: SECRET_NAMES.provider("claude") });
    expect(actions(stack.statements(health!.fn)).sort()).toEqual([
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
    ]);
    stack.template.hasResourceProperties("AWS::Scheduler::Schedule", {
      ScheduleExpression: "rate(6 hours)",
    });
    // One alarm per stored credential: none for Bedrock, which has none.
    const alarms = Object.values(stack.resources).filter(
      (r) => r.Type === "AWS::CloudWatch::Alarm" && r.Properties.MetricName === "CredentialProblem",
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.Properties).toMatchObject({
      Namespace: "LGTMoose",
      Dimensions: [{ Name: "Provider", Value: "claude" }],
      Statistic: "Maximum",
      Period: 6 * 3600,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
  });

  it("checks pinned Bedrock models with a role that may describe them, never call them", () => {
    const pinned = synth([
      {
        id: "bedrock",
        harness: "claude-code",
        auth: "bedrock",
        models: {
          fast: "anthropic.claude-haiku-4-5-20251001-v1:0",
          standard: "us.anthropic.claude-sonnet-4-6",
          deep: "us.anthropic.claude-sonnet-4-6",
        },
      },
    ]);
    // A Bedrock-only deployment has no stored credential, and still gets the check.
    const health = pinned.health();
    expect(health).toBeDefined();
    expect(JSON.parse(envText(health?.env.LGTMOOSE_CREDENTIALS))).toEqual({});
    expect(JSON.parse(envText(health?.env.LGTMOOSE_MODEL_CHECKS))).toEqual([
      {
        providerId: "bedrock",
        kind: "bedrock",
        model: "anthropic.claude-haiku-4-5-20251001-v1:0",
        tiers: ["fast"],
      },
      {
        providerId: "bedrock",
        kind: "bedrock",
        model: "us.anthropic.claude-sonnet-4-6",
        tiers: ["standard", "deep"],
      },
    ]);
    const granted = pinned.statements(health!.fn);
    expect(actions(granted).sort()).toEqual([
      "bedrock:GetFoundationModel",
      "bedrock:GetFoundationModelAvailability",
      "bedrock:GetInferenceProfile",
    ]);
    const resources = (action: string) =>
      JSON.stringify(granted.filter((s) => actions([s]).includes(action)).map((s) => s.Resource));
    expect(resources("bedrock:GetInferenceProfile")).toContain(
      ":inference-profile/us.anthropic.claude-sonnet-4-6",
    );
    expect(resources("bedrock:GetFoundationModel")).toContain(
      "::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(resources("bedrock:GetFoundationModel")).not.toContain("*");
    const alarms = Object.values(pinned.resources).filter(
      (r) => r.Type === "AWS::CloudWatch::Alarm" && r.Properties.MetricName === "ModelUnavailable",
    );
    expect(alarms.map((alarm) => alarm.Properties.Dimensions)).toEqual([
      [{ Name: "Provider", Value: "bedrock" }],
    ]);
    // A check that couldn't run writes no point, which must leave the alarm as it is.
    expect(alarms[0]?.Properties).toMatchObject({
      Threshold: 1,
      Statistic: "Maximum",
      TreatMissingData: "ignore",
    });
  }, 120_000);

  it("has no health check for a deployment with nothing to check", () => {
    const none = synth([{ id: "bedrock", harness: "claude-code", auth: "bedrock" }]);
    expect(none.health()).toBeUndefined();
  }, 120_000);

  describe("with a ChatGPT sign-in reviewing", () => {
    let codex: ReturnType<typeof synth>;
    beforeAll(() => {
      codex = synth([
        { id: "codex", harness: "codex", auth: "chatgpt-login" },
        { id: "bedrock", harness: "claude-code", auth: "bedrock" },
      ]);
    }, 120_000);

    it("runs one task at a time, and may store the refreshed auth.json in that secret only", () => {
      const broker = codex.broker()!;
      expect(JSON.parse(envText(broker.env.LGTMOOSE_CREDENTIALS)).codex).toMatchObject({
        auth: "chatgpt-login",
        limit: 1,
        secretId: SECRET_NAMES.provider("codex"),
      });
      const values = codex
        .statements(broker.fn)
        .filter((s) =>
          actions([s]).some(
            (a) => a === "secretsmanager:GetSecretValue" || a === "secretsmanager:PutSecretValue",
          ),
        );
      expect(values).toHaveLength(1);
      expect(JSON.stringify(values[0]?.Resource)).toContain(
        `${SECRET_NAMES.provider("codex")}-??????`,
      );
      // The health check still never reads it.
      expect(actions(codex.statements(codex.health()!.fn))).not.toContain(
        "secretsmanager:GetSecretValue",
      );
    });

    it("gives the task a URL to hand the refreshed auth.json back", () => {
      expect(codex.batchStates().Presign?.Parameters).toMatchObject({
        credentialRefresh: true,
      });
    });
  });

  it("leases a fallback provider's own credential when a batch falls back to it", () => {
    const chain = synth([
      { id: "claude", harness: "claude-code", auth: "oauth-token" },
      { id: "codex", harness: "codex", auth: "chatgpt-login" },
    ]);
    const credentials = JSON.parse(envText(chain.broker()?.env.LGTMOOSE_CREDENTIALS)) as Record<
      string,
      { auth: string; limit: number }
    >;
    expect(Object.keys(credentials).sort()).toEqual(["claude", "codex"]);
    expect(credentials.codex).toMatchObject({ auth: "chatgpt-login", limit: 1 });
    const [machine] = Object.values(chain.resources).filter(
      (r) => r.Type === "AWS::StepFunctions::StateMachine",
    );
    const body = machine?.Properties.DefinitionString as { "Fn::Join": [string, unknown[]] };
    const text = body["Fn::Join"][1].map((p) => (typeof p === "string" ? p : "REF")).join("");
    const items =
      (JSON.parse(text) as { States: Record<string, State> }).States.Batches?.ItemProcessor
        ?.States ?? {};
    const codex = items["Attempt-codex"]?.Branches?.[0]?.States ?? {};
    expect(codex["Lease-codex"]?.Parameters).toMatchObject({
      action: "acquire",
      providerId: "codex",
    });
    expect(codex["Presign-codex"]?.Parameters).toMatchObject({ credentialRefresh: true });
    // Only the sign-in's secret may be read and written; the Claude token's is described only.
    const writes = chain
      .statements(chain.broker()!.fn)
      .filter((s) => actions([s]).includes("secretsmanager:PutSecretValue"));
    expect(JSON.stringify(writes.map((s) => s.Resource))).toContain(SECRET_NAMES.provider("codex"));
    expect(JSON.stringify(writes.map((s) => s.Resource))).not.toContain(
      SECRET_NAMES.provider("claude"),
    );
  }, 120_000);

  it("leases nothing for a Bedrock reviewer, which has no stored credential", () => {
    const bedrock = synth([{ id: "bedrock", harness: "claude-code", auth: "bedrock" }]);
    expect(bedrock.broker()).toBeUndefined();
    expect(bedrock.health()).toBeUndefined();
    expect(bedrock.batchStates().Lease).toBeUndefined();
    expect(JSON.stringify(bedrock.resources)).not.toContain("CredentialProblem");
  }, 120_000);
});
