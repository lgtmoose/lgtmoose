import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpApi, HttpMethod, HttpStage, type IHttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { SECRET_NAMES, STACK_OUTPUTS } from "@lgtmoose/config";
import { ROUTES } from "@lgtmoose/gateway/paths";
import { lgtmooseFunction } from "./lambda.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GATEWAY_HANDLER = join(REPO_ROOT, "apps/gateway/src/lambda.ts");

/** A job is retried this many times before it goes to the dead-letter queue. */
export const MAX_JOB_ATTEMPTS = 5;
/** Longest a consumer may hold a job before SQS makes it visible again. */
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5);

export interface ApiStackProps extends StackProps {
  /** Reported by the gateway's health route. */
  version: string;
  /**
   * GitHub orgs or users whose repositories the gateway accepts webhooks for (the deploy
   * config's `allowedOrgs`). Deliveries for any other owner are ignored.
   */
  allowedOrgs: readonly string[];
  /** Steady-state requests per second the API accepts before returning 429. */
  rateLimit?: number;
  /** Requests the API accepts in a burst above the rate limit. */
  burstLimit?: number;
}

/**
 * The internet-facing entry point: an HTTP API in front of the gateway Lambda, and the FIFO job
 * queue the gateway writes to.
 *
 * The queue's message group is `owner/repo#pr` (set by the gateway), so jobs for one PR
 * are handled in order while different PRs run in parallel. The gateway runs outside the VPC: it
 * needs only SQS and its one secret, and it can't reach the database or the sandbox.
 */
export class ApiStack extends Stack {
  readonly api: IHttpApi;
  readonly jobQueue: Queue;
  readonly deadLetterQueue: Queue;
  readonly gatewayFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    // The gateway refuses to start without at least one; fail at synth, not on the first webhook.
    if (props.allowedOrgs.length === 0) throw new Error("ApiStack needs at least one allowed org");

    this.deadLetterQueue = new Queue(this, "JobDeadLetterQueue", {
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    this.jobQueue = new Queue(this, "JobQueue", {
      fifo: true,
      // The gateway sets the deduplication ID to GitHub's delivery ID.
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: JOB_VISIBILITY_TIMEOUT,
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_JOB_ATTEMPTS },
    });
    new Alarm(this, "DeadLetterAlarm", {
      alarmDescription:
        "LGTMoose jobs failed every attempt and are waiting in the dead-letter queue.",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const webhookSecret = Secret.fromSecretNameV2(
      this,
      "GithubWebhookSecret",
      SECRET_NAMES.githubWebhook,
    );

    this.gatewayFunction = lgtmooseFunction(this, "GatewayFunction", {
      entry: GATEWAY_HANDLER,
      memorySize: 256,
      // API Gateway gives up after 30s; GitHub after 10s. The gateway only verifies and enqueues.
      timeout: Duration.seconds(10),
      environment: {
        LGTMOOSE_VERSION: props.version,
        JOB_QUEUE_URL: this.jobQueue.queueUrl,
        // The name, not secretArn. A secret imported by name has an ARN without the random
        // suffix, and GetSecretValue rejects that (ResourceNotFound), so every webhook 500s.
        GITHUB_WEBHOOK_SECRET_ARN: webhookSecret.secretName,
        // Org names can't contain commas (the config schema allows letters, digits and hyphens).
        ALLOWED_ORGS: props.allowedOrgs.join(","),
      },
      logGroup: new LogGroup(this, "GatewayLogs", {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // Least privilege: send jobs and read the webhook secret. Nothing else, not even the App key.
    this.jobQueue.grantSendMessages(this.gatewayFunction);
    webhookSecret.grantRead(this.gatewayFunction);

    // No CORS: GitHub and the CLI don't need it. The dashboard (NIC-840) adds it, limited to the
    // dashboard's own origin, when it starts calling the API from the browser.
    const api = new HttpApi(this, "Api", {
      description: "LGTMoose webhooks and REST API",
      createDefaultStage: false,
    });
    new HttpStage(this, "DefaultStage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: props.rateLimit ?? 50, burstLimit: props.burstLimit ?? 100 },
    });
    const integration = new HttpLambdaIntegration("GatewayIntegration", this.gatewayFunction);
    api.addRoutes({ path: ROUTES.health, methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: ROUTES.githubWebhook, methods: [HttpMethod.POST], integration });
    this.api = api;

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, STACK_OUTPUTS.api.githubWebhookUrl, {
      value: `${api.apiEndpoint}${ROUTES.githubWebhook}`,
      description: "`lgtmoose deploy` points the GitHub App's webhook here.",
    });
    new CfnOutput(this, "JobQueueUrl", { value: this.jobQueue.queueUrl });
  }
}
