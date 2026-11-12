import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  HttpStage,
  type IHttpApi,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { SECRET_NAMES } from "@lgtmoose/config";
import { ROUTES } from "@lgtmoose/gateway";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GATEWAY_HANDLER = join(REPO_ROOT, "apps/gateway/src/lambda.ts");

/** A job is retried this many times before it goes to the dead-letter queue. */
export const MAX_JOB_ATTEMPTS = 5;
/** Longest a consumer may hold a job before SQS makes it visible again. */
export const JOB_VISIBILITY_TIMEOUT = Duration.minutes(5);

export interface ApiStackProps extends StackProps {
  /** Reported by the gateway's health route. */
  version: string;
  /** Steady-state requests per second the API accepts before returning 429. */
  rateLimit?: number;
  /** Requests the API accepts in a burst above the rate limit. */
  burstLimit?: number;
}

/**
 * The internet-facing entry point: an HTTP API in front of the gateway Lambda, and the FIFO job
 * queue the gateway writes to.
 *
 * The queue's message group is `owner/repo#pr` (set by the gateway, NIC-804), so jobs for one PR
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

    this.gatewayFunction = new NodejsFunction(this, "GatewayFunction", {
      entry: GATEWAY_HANDLER,
      handler: "handler",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      // API Gateway gives up after 30s; GitHub after 10s. The gateway only verifies and enqueues.
      timeout: Duration.seconds(10),
      depsLockFilePath: join(REPO_ROOT, "pnpm-lock.yaml"),
      projectRoot: REPO_ROOT,
      environment: {
        LGTMOOSE_VERSION: props.version,
        JOB_QUEUE_URL: this.jobQueue.queueUrl,
        GITHUB_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        externalModules: ["@aws-sdk/*"],
      },
      logGroup: new LogGroup(this, "GatewayLogs", {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // Least privilege: send jobs and read the webhook secret. Nothing else, not even the App key.
    this.jobQueue.grantSendMessages(this.gatewayFunction);
    webhookSecret.grantRead(this.gatewayFunction);

    const api = new HttpApi(this, "Api", {
      description: "LGTMoose webhooks and REST API",
      createDefaultStage: false,
      corsPreflight: {
        // The dashboard (NIC-840) will call the REST API from the browser.
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT],
        allowHeaders: ["content-type", "authorization"],
        allowOrigins: ["*"],
        maxAge: Duration.hours(1),
      },
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
    new CfnOutput(this, "GithubWebhookUrl", {
      value: `${api.apiEndpoint}${ROUTES.githubWebhook}`,
      description: "`lgtmoose deploy` points the GitHub App's webhook here.",
    });
    new CfnOutput(this, "JobQueueUrl", { value: this.jobQueue.queueUrl });
  }
}
