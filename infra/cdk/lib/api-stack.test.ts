import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SECRET_NAMES } from "@lgtmoose/config";
import { ROUTES } from "@lgtmoose/gateway/paths";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiStack, JOB_VISIBILITY_TIMEOUT, MAX_JOB_ATTEMPTS } from "./api-stack.js";
import { appWithoutBundling } from "./test-utils.js";

type Resource = { Type: string; Properties: Record<string, unknown> };

let stack: ApiStack;
let template: Template;
let resources: Record<string, Resource>;

beforeAll(() => {
  stack = new ApiStack(appWithoutBundling(), "Api", {
    version: "1.2.3",
    allowedOrgs: ["acme-corp", "octo-dev"],
  });
  template = Template.fromStack(stack);
  resources = template.toJSON().Resources as Record<string, Resource>;
}, 60_000);

function logicalId(construct: { node: { defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as never);
}

describe("ApiStack", () => {
  it("has an encrypted, TLS-only FIFO job queue with a FIFO dead-letter queue", () => {
    const dlq = logicalId(stack.deadLetterQueue);
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: JOB_VISIBILITY_TIMEOUT.toSeconds(),
      RedrivePolicy: {
        deadLetterTargetArn: { "Fn::GetAtt": [dlq, "Arn"] },
        maxReceiveCount: MAX_JOB_ATTEMPTS,
      },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      MessageRetentionPeriod: 1_209_600,
    });
    // enforceSSL: both queues deny requests that aren't over TLS.
    const policies = Object.values(resources).filter((r) => r.Type === "AWS::SQS::QueuePolicy");
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(JSON.stringify(policy.Properties)).toContain('"aws:SecureTransport":"false"');
    }
  });

  it("alarms when a job lands in the dead-letter queue", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
    });
  });

  it("runs the gateway on Node 24 outside the VPC with the queue and secret it needs", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Timeout: 10,
      VpcConfig: Match.absent(),
      Environment: {
        Variables: {
          LGTMOOSE_VERSION: "1.2.3",
          JOB_QUEUE_URL: Match.anyValue(),
          GITHUB_WEBHOOK_SECRET_ID: SECRET_NAMES.githubWebhook,
          ALLOWED_ORGS: "acme-corp,octo-dev",
        },
      },
    });
  });

  it("refuses an empty allowed-org list", () => {
    expect(
      () => new ApiStack(appWithoutBundling(), "Api", { version: "1.2.3", allowedOrgs: [] }),
    ).toThrow(/allowed org/);
  });

  it("lets the gateway send jobs and read only the webhook secret", () => {
    const role = logicalId(stack.gatewayFunction.role as never);
    const policies = Object.values(resources).filter(
      (r) => r.Type === "AWS::IAM::Policy" && JSON.stringify(r.Properties.Roles).includes(role),
    );
    expect(policies).toHaveLength(1);
    const document = policies[0]?.Properties.PolicyDocument as
      { Statement: { Action: unknown; Resource: unknown }[] } | undefined;
    const statements = document?.Statement ?? [];
    const text = JSON.stringify(statements);

    expect(text).toContain("sqs:SendMessage");
    expect(text).toContain("lgtmoose/github-webhook-secret");
    // Never the App's private key, never receive or delete on the queue.
    expect(text).not.toContain("lgtmoose/github-app");
    expect(text).not.toContain("sqs:ReceiveMessage");
    expect(text).not.toContain("sqs:DeleteMessage");

    // Nothing beyond what sending a job and reading one secret take, now that the gateway does
    // real work.
    const actions = statements.flatMap((s) => [s.Action].flat() as string[]);
    expect(new Set(actions)).toEqual(
      new Set([
        "sqs:SendMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]),
    );
  });

  it("routes only the health and webhook paths to the gateway, with throttling", () => {
    const routes = Object.values(resources)
      .filter((r) => r.Type === "AWS::ApiGatewayV2::Route")
      .map((r) => String(r.Properties.RouteKey))
      .sort((a, b) => a.localeCompare(b));
    expect(routes).toEqual([`GET ${ROUTES.health}`, `POST ${ROUTES.githubWebhook}`]);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    });
  });

  it("has no CORS until the dashboard adds it for its own origin", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.absent(),
    });
  });

  it("outputs the webhook URL for `lgtmoose deploy`", () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs.GithubWebhookUrl?.Value)).toContain(ROUTES.githubWebhook);
  });

  it("bundles the gateway handler", () => {
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), "lgtmoose-api-")) });
    new ApiStack(app, "Api", { version: "1.2.3", allowedOrgs: ["acme-corp"] });
    const synthesized = app.synth();
    const bundle = readdirSync(synthesized.directory)
      .filter((name) => name.startsWith("asset."))
      .map((name) => join(synthesized.directory, name))
      .find((dir) => existsSync(join(dir, "index.mjs")));
    expect(bundle).toBeDefined();
  }, 60_000);
});
