import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import type { ISecurityGroup, IVpc, SubnetSelection } from "aws-cdk-lib/aws-ec2";
import {
  Capability,
  Cluster,
  CpuArchitecture,
  FargateTaskDefinition,
  LinuxParameters,
  type ContainerImage,
  LogDrivers,
  OperatingSystemFamily,
  Secret as EcsSecret,
  type ContainerDefinition,
} from "aws-cdk-lib/aws-ecs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Schedule, ScheduleExpression } from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue, QueueEncryption, type IQueue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  credentialConcurrency,
  BOOTSTRAP_REQUEST_PREFIX,
  FEEDBACK_REPORT_KEY,
  modelFor,
  providerModelEnv,
  SECRET_NAMES,
  STACK_OUTPUTS,
  type DeployConfig,
} from "@lgtmoose/config";
import { lgtmooseFunction } from "./lambda.js";
import type { Profile } from "./network-stack.js";
import { bedrockStatements } from "./bedrock.js";
import {
  BATCH_TIMEOUT,
  RUN_PREFIX,
  ReviewWorkflow,
  type ReviewProvider,
} from "./review-workflow.js";
import { partialArnHidesName, secretArnPattern, secretId } from "./secret-ref.js";
import { taskImage } from "./images.js";
import { sandboxBuildArgs } from "./sandbox-image.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Where the control image installs the RDS global bundle. The task passes this file only to
 * the Postgres client. It is not added to Node's trust store.
 */
export const DATABASE_CA_FILE = "/etc/ssl/rds-global-bundle.pem";
const DISPATCH_HANDLER = join(REPO_ROOT, "apps/control/src/dispatch-lambda.ts");
const CREDENTIAL_HEALTH_HANDLER = join(REPO_ROOT, "apps/control/src/credential-health-lambda.ts");
const RECONCILE_HANDLER = join(REPO_ROOT, "apps/control/src/reconcile-lambda.ts");
const CONVERSATION_HANDLER = join(REPO_ROOT, "apps/control/src/conversation-lambda.ts");

/** The conversation Lambda's limit per batch: a few GitHub calls per command. */
export const CONVERSATION_TIMEOUT = Duration.seconds(60);

/** Conversation Lambdas at once: each holds a database connection, like the dispatcher. */
export const CONVERSATION_CONCURRENCY = 2;

/** How often stored credentials are checked, and the period their alarms look at. */
export const CREDENTIAL_CHECK_INTERVAL = Duration.hours(6);

/** The reconciler's limit per run: listing every open PR of every installation. */
export const RECONCILE_TIMEOUT = Duration.minutes(10);

/**
 * The dispatcher's limit per batch. It's well under the job queue's visibility timeout (five
 * minutes), as Lambda wants for a queue source, so a slow batch isn't delivered twice.
 */
export const DISPATCH_TIMEOUT = Duration.seconds(45);
/** Dispatcher instances at once. Jobs are small; more PRs at once only wait a little. */
export const DISPATCH_CONCURRENCY = 5;

/** Where tasks may write: the root filesystem is read-only. */
const WRITABLE_MOUNTS = { work: "/work", tmp: "/tmp" } as const;

/**
 * Hosts sandbox tasks reach directly, not through the proxy: loopback, the ECS credential and
 * metadata endpoints, and the AWS services that have VPC endpoints in the sandbox subnets.
 * Everything else, model APIs and Bedrock included, goes through the proxy.
 */
function noProxy(region: string): string {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    "169.254.170.2",
    "169.254.169.254",
    `s3.${region}.amazonaws.com`,
    `.s3.${region}.amazonaws.com`,
    `secretsmanager.${region}.amazonaws.com`,
    `logs.${region}.amazonaws.com`,
  ].join(",");
}

export interface WorkflowStackProps extends StackProps {
  profile: Profile;
  providers: DeployConfig["providers"];
  /** The provider that reviews the batches; it must be one of `providers`. */
  reviewerProviderId: string;
  /** The reviewer's model; empty for the harness's default. */
  reviewerModel: string;
  /** Sandbox tasks per review at once. */
  maxConcurrency: number;
  /** How long batches after the first wait, so they can read its prompt cache. */
  batchStaggerSeconds: number;
  /** Record reviews instead of posting them to GitHub. */
  shadow: boolean;
  vpc: IVpc;
  /** Where control tasks run: the app subnets, with egress. */
  controlSubnets: SubnetSelection;
  controlSecurityGroup: ISecurityGroup;
  /** Where sandbox tasks run: isolated subnets whose only way out is the proxy. */
  sandboxSubnets: SubnetSelection;
  sandboxSecurityGroup: ISecurityGroup;
  /** The egress proxy, as sandbox tasks reach it (`proxyUrl` of the proxy stack). */
  proxyUrl: string;
  artifactBucket: IBucket;
  /**
   * The database's generated secret. It holds the host and port too, so the endpoint isn't
   * passed separately: a cross-stack reference to it would block replacing the database.
   */
  databaseSecret: ISecret;
  databaseName: string;
  githubAppSecret: ISecret;
  /** Provider id → its credential secret, for providers that have one (not Bedrock). */
  providerSecrets: ReadonlyMap<string, ISecret>;
  /** The gateway's FIFO job queue, which the dispatcher consumes. */
  jobQueue: IQueue;
  /** The job queue's dead-letter queue, where the dispatcher puts messages that aren't jobs. */
  deadLetterQueue: IQueue;
  /** GitHub orgs or users whose repositories may be reviewed (the reconciler checks these). */
  allowedOrgs: readonly string[];
  /** Minutes between reconciler runs. */
  reconcileIntervalMinutes: number;
  /** Hours back the reconciler queues reviews for. */
  reconcileLookbackHours: number;
  /** Feedback signals (NIC-841), read by the reconciler. Defaults when left out. */
  feedback?: { acceptanceThreshold: number; minSamples: number; maxCommentsPerRun: number };
  /** The most replies the reply judge reads per run (`maxReplyJudgements`). Left out: 10. */
  maxReplyJudgements?: number;
  /** The most `explain`s the explainer answers per PR per run (`maxExplanations`). Left out: 5. */
  maxExplanations?: number;
  /** How long a push's review waits for the next push (`reviewDebounceSeconds`). Left out: 60. */
  reviewDebounceSeconds?: number;
  /**
   * Spend caps and prices (`budgets`, NIC-1079), passed to the control task as JSON. With a
   * monthly cap, CloudWatch alarms at 50%, 80% and 100% of it. Left out: no caps.
   */
  budgets?: DeployConfig["budgets"];
  /**
   * How the control task ranks learnings (`learnings.embeddings`): none (keywords), Bedrock in
   * this account, or OpenAI with the key in `SECRET_NAMES.openAiEmbeddings`. Left out: none.
   */
  embeddings?: DeployConfig["learnings"]["embeddings"];
  /** `learnings.maxPendingPerAuthor`: the most pending learnings one author may have. */
  maxPendingLearnings?: number;
  /** `learnings.bootstrapMaxCostUsd`: the cost cap of one bootstrap from review history. */
  bootstrapMaxCostUsd?: number;
  /** `learnings.repeatThreshold` (NIC-1081): rejections on how many PRs make a learning. */
  repeatThreshold?: number;
  /**
   * Ticket coverage (`tickets`): the control task reads linked tickets with the key in
   * `SECRET_NAMES.linearTickets`. Left out: off. Sandbox tasks never get the key.
   */
  tickets?: DeployConfig["tickets"];
  /**
   * Build the sandbox image with the Cursor CLI even though its checksum isn't recorded
   * (`sandboxBuildArgs`). Off by default.
   */
  allowUnverifiedCursor?: boolean;
  /** Where the control and sandbox images come from (`images` in the deploy config). */
  images?: DeployConfig["images"];
}

/**
 * The review workflow: an ECS cluster, the control task, one sandbox task per model provider,
 * the Step Functions state machine that runs them (`ReviewWorkflow`), and the dispatcher Lambda
 * that starts and supersedes its executions from the job queue.
 *
 * - The control task holds the GitHub App credentials and the database, and never runs a model.
 * - A sandbox task holds one provider's credential and no GitHub token. Its role has no S3
 *   access at all: one role is shared by every run, so it couldn't be limited to a run's own
 *   files. The workflow passes each task presigned URLs for its batch input and its output
 *   instead. It can call Bedrock when the provider uses it. One task definition per
 *   provider means a task can only ever see its own credential.
 *
 * Both run as a non-root user with a read-only root filesystem and writable volumes only at
 * /work and /tmp. Fargate mounts those volumes owned by root, so the task starts as root. Fargate
 * can drop capabilities and can only add SYS_PTRACE, so the task keeps SETUID, SETGID and SETPCAP
 * from Docker's defaults and drops the rest. The entrypoint uses them to open the volumes and
 * become uid 10001, then clears them and execs tini. The platform init stays off, because that
 * init would keep running as root. Networking is set when a task is started
 * (RunTask), so the workflow must start sandbox tasks in `sandboxSubnets` with the sandbox
 * security group and no public IP; the outputs give both.
 */
export class WorkflowStack extends Stack {
  readonly cluster: Cluster;
  readonly controlTaskDefinition: FargateTaskDefinition;
  /** Provider id → its sandbox task definition. */
  readonly sandboxTaskDefinitions: ReadonlyMap<string, FargateTaskDefinition>;
  readonly reviewWorkflow: ReviewWorkflow;
  readonly dispatchFunction: NodejsFunction;
  /** Provider id → the alarm on its credential's `CredentialProblem`. */
  readonly credentialAlarms: ReadonlyMap<string, Alarm>;
  readonly reconcileFunction: NodejsFunction;
  /** Comment jobs the dispatcher forwards, for the conversation Lambda. */
  readonly conversationQueue: Queue;
  readonly conversationFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);
    const lean = props.profile === "lean";
    const retention = lean ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH;
    const embeddings = props.embeddings ?? { provider: "none" };

    this.cluster = new Cluster(this, "Cluster", { vpc: props.vpc });

    const images = props.images ?? { source: "build" };
    const controlImage = taskImage(images, "control", {
      directory: REPO_ROOT,
      file: "apps/control/Dockerfile",
    });
    const sandboxImage = taskImage(images, "sandbox", {
      directory: REPO_ROOT,
      file: "infra/sandbox/Dockerfile",
      buildArgs:
        images.source === "build"
          ? sandboxBuildArgs(props.providers, props.allowUnverifiedCursor ?? false)
          : {},
    });

    this.controlTaskDefinition = this.taskDefinition("Control", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      // Clones of large repositories.
      ephemeralStorageGiB: 50,
    });
    const controlContainer = this.container(this.controlTaskDefinition, "control", {
      image: controlImage,
      retention,
      environment: {
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        LGTMOOSE_DATABASE_CA_FILE: DATABASE_CA_FILE,
        GITHUB_APP_SECRET_ARN: secretId(props.githubAppSecret),
        LGTMOOSE_REVIEWER_MODEL: props.reviewerModel,
        LGTMOOSE_BATCH_TIMEOUT_MS: String(BATCH_TIMEOUT.toMilliseconds()),
        LGTMOOSE_SHADOW: String(props.shadow),
        LGTMOOSE_MAX_REPLY_JUDGEMENTS: String(props.maxReplyJudgements ?? 10),
        LGTMOOSE_MAX_EXPLANATIONS: String(props.maxExplanations ?? 5),
        ...embeddingsEnvironment(embeddings),
        ...ticketsEnvironment(props.tickets),
        LGTMOOSE_MAX_PENDING_LEARNINGS: String(props.maxPendingLearnings ?? 5),
        LGTMOOSE_BOOTSTRAP_MAX_COST_USD: String(props.bootstrapMaxCostUsd ?? 5),
        LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD: String(props.repeatThreshold ?? 2),
        LGTMOOSE_BUDGETS: JSON.stringify(props.budgets ?? {}),
      },
    });
    const controlRole = this.controlTaskDefinition.taskRole;
    props.githubAppSecret.grantRead(controlRole);
    props.databaseSecret.grantRead(controlRole);
    props.artifactBucket.grantReadWrite(controlRole);
    // Learnings are ranked in the control task, never in the sandbox: only it may embed.
    if (embeddings.provider === "bedrock") {
      controlRole.addToPrincipalPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["bedrock:InvokeModel"],
          resources: [
            `arn:${this.partition}:bedrock:${this.region}::foundation-model/${embeddings.model}`,
          ],
        }),
      );
    } else if (embeddings.provider === "openai") {
      Secret.fromSecretNameV2(this, "OpenAiEmbeddingsKey", SECRET_NAMES.openAiEmbeddings).grantRead(
        controlRole,
      );
    }
    // Linked tickets are read in the control task, never in the sandbox: only it gets the key.
    if (props.tickets?.provider === "linear") {
      Secret.fromSecretNameV2(this, "LinearTicketsKey", SECRET_NAMES.linearTickets).grantRead(
        controlRole,
      );
    }
    // Post's review claim names the claiming task; a later attempt asks whether it still runs.
    controlRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ecs:DescribeTasks"],
        resources: [
          `arn:${this.partition}:ecs:${this.region}:${this.account}:task/${this.cluster.clusterName}/*`,
        ],
      }),
    );

    const sandboxes = new Map<string, FargateTaskDefinition>();
    const sandboxContainers = new Map<string, ContainerDefinition>();
    for (const provider of props.providers) {
      const definition = this.taskDefinition(`Sandbox-${provider.id}`, {
        cpu: 2048,
        memoryLimitMiB: 4096,
        ephemeralStorageGiB: 30,
      });
      const secret = props.providerSecrets.get(provider.id);
      const sandboxContainer = this.container(definition, "sandbox", {
        image: sandboxImage,
        retention,
        environment: {
          LGTMOOSE_PROVIDER: provider.id,
          LGTMOOSE_HARNESS: provider.harness,
          LGTMOOSE_AUTH: provider.auth,
          HTTPS_PROXY: props.proxyUrl,
          NO_PROXY: noProxy(this.region),
          AWS_REGION: this.region,
          // The model this provider reviews with, so a batch that falls back to it runs its
          // own model (`default`: the harness's).
          LGTMOOSE_MODEL: modelFor(provider, "standard") ?? "default",
          // Its fast-tier model, for the reply judge.
          LGTMOOSE_FAST_MODEL: modelFor(provider, "fast") ?? "default",
          ...(provider.thinkingTokens?.standard === undefined
            ? {}
            : { LGTMOOSE_THINKING_TOKENS: String(provider.thinkingTokens.standard) }),
          ...(provider.thinkingTokens?.fast === undefined
            ? {}
            : { LGTMOOSE_FAST_THINKING_TOKENS: String(provider.thinkingTokens.fast) }),
          ...(provider.effort?.standard === undefined
            ? {}
            : { LGTMOOSE_EFFORT: provider.effort.standard }),
          ...(provider.effort?.fast === undefined
            ? {}
            : { LGTMOOSE_FAST_EFFORT: provider.effort.fast }),
          ...providerModelEnv(provider),
        },
        // The execution role reads the secret to start the task; the task's own role can't
        // read any secret.
        ...(secret === undefined
          ? {}
          : { secrets: { LGTMOOSE_PROVIDER_CREDENTIAL: sandboxCredential(provider.id, secret) } }),
      });
      if (provider.auth === "bedrock") {
        for (const statement of bedrockStatements(provider, this.partition, this.account)) {
          definition.taskRole.addToPrincipalPolicy(statement);
        }
      }
      sandboxes.set(provider.id, definition);
      sandboxContainers.set(provider.id, sandboxContainer);
    }
    this.sandboxTaskDefinitions = sandboxes;

    // A batch is reviewed on the reviewer's provider, then on the others in config order when it
    // hits a limit there (`providerChain` in @lgtmoose/config).
    const reviewer = props.providers.find((provider) => provider.id === props.reviewerProviderId);
    if (reviewer === undefined) {
      throw new Error(`No sandbox task for the reviewer provider ${props.reviewerProviderId}.`);
    }
    const chain = [reviewer, ...props.providers.filter((provider) => provider.id !== reviewer.id)];
    const reviewProviders: ReviewProvider[] = chain.map((provider) => {
      const taskDefinition = sandboxes.get(provider.id);
      const container = sandboxContainers.get(provider.id);
      if (taskDefinition === undefined || container === undefined) {
        throw new Error(`No sandbox task for the provider ${provider.id}.`);
      }
      const secret = props.providerSecrets.get(provider.id);
      return {
        providerId: provider.id,
        sandbox: { taskDefinition, container },
        ...(secret === undefined
          ? {}
          : {
              credential: {
                auth: provider.auth,
                limit: credentialConcurrency(provider),
                secret,
              },
            }),
      };
    });
    this.reviewWorkflow = new ReviewWorkflow(this, "Review", {
      cluster: this.cluster,
      retention,
      artifactBucket: props.artifactBucket,
      control: { taskDefinition: this.controlTaskDefinition, container: controlContainer },
      controlSubnets: props.controlSubnets,
      controlSecurityGroup: props.controlSecurityGroup,
      providers: reviewProviders,
      sandboxSubnets: props.sandboxSubnets,
      sandboxSecurityGroup: props.sandboxSecurityGroup,
      maxConcurrency: props.maxConcurrency,
      batchStaggerSeconds: props.batchStaggerSeconds,
      auditRetention: lean ? RetentionDays.THREE_MONTHS : RetentionDays.ONE_YEAR,
    });

    this.credentialAlarms = this.credentialHealth(props, retention);
    if (!lean) {
      // Standard only. A stopped (superseded) execution is ABORTED, not FAILED, so this counts
      // reviews that broke, not ones a newer push replaced.
      new Alarm(this, "ReviewFailuresAlarm", {
        alarmDescription:
          "3 or more LGTMoose review executions failed in the last hour. See the review workflow's failed executions.",
        metric: this.reviewWorkflow.stateMachine.metricFailed({
          period: Duration.hours(1),
          statistic: "Sum",
        }),
        threshold: 3,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    }

    this.budgetAlarms(props.budgets);

    this.conversationQueue = this.conversationQueueOf();
    this.dispatchFunction = this.dispatcher(props, retention);
    this.reconcileFunction = this.reconciler(props, retention);
    this.conversationFunction = this.conversation(props, retention);

    const subnetIds = (selection: SubnetSelection) =>
      Fn.join(",", props.vpc.selectSubnets(selection).subnetIds);
    const out = STACK_OUTPUTS.workflow;
    new CfnOutput(this, out.clusterArn, { value: this.cluster.clusterArn });
    new CfnOutput(this, out.controlTaskDefinitionArn, {
      value: this.controlTaskDefinition.taskDefinitionArn,
    });
    new CfnOutput(this, out.controlSubnetIds, { value: subnetIds(props.controlSubnets) });
    new CfnOutput(this, out.controlSecurityGroupId, {
      value: props.controlSecurityGroup.securityGroupId,
    });
    new CfnOutput(this, out.sandboxSubnetIds, { value: subnetIds(props.sandboxSubnets) });
    new CfnOutput(this, out.sandboxSecurityGroupId, {
      value: props.sandboxSecurityGroup.securityGroupId,
    });
    new CfnOutput(this, out.stateMachineArn, {
      value: this.reviewWorkflow.stateMachine.stateMachineArn,
    });
    new CfnOutput(this, out.sandboxTaskDefinitionArns, {
      value: this.toJsonString(
        Object.fromEntries(
          [...sandboxes].map(([providerId, def]) => [providerId, def.taskDefinitionArn]),
        ),
      ),
    });
  }

  /**
   * The dispatcher: jobs from the queue become executions (`dispatch` in @lgtmoose/control). It
   * runs in the app subnets with the control security group to mark stopped runs in the
   * database; it holds no GitHub or model credential. A job that keeps failing goes to the
   * queue's dead-letter queue, whose alarm is in the API stack.
   */
  private dispatcher(props: WorkflowStackProps, retention: RetentionDays): NodejsFunction {
    const stateMachine = this.reviewWorkflow.stateMachine;
    const fn = lgtmooseFunction(this, "DispatchFunction", {
      entry: DISPATCH_HANDLER,
      description: "Starts and supersedes review workflow executions from the job queue.",
      memorySize: 256,
      timeout: DISPATCH_TIMEOUT,
      vpc: props.vpc,
      vpcSubnets: props.controlSubnets,
      securityGroups: [props.controlSecurityGroup],
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
        DEAD_LETTER_QUEUE_URL: props.deadLetterQueue.queueUrl,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        CONVERSATION_QUEUE_URL: this.conversationQueue.queueUrl,
        LGTMOOSE_REVIEW_DEBOUNCE_SECONDS: String(props.reviewDebounceSeconds ?? 60),
        // Lets Node verify the RDS server certificate.
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
      bundling: { externalModules: ["pg-native"] },
      logGroup: new LogGroup(this, "DispatchLogs", {
        retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    props.databaseSecret.grantRead(fn);
    props.deadLetterQueue.grantSendMessages(fn);
    this.conversationQueue.grantSendMessages(fn);
    stateMachine.grantStartExecution(fn);
    stateMachine.grantExecution(fn, "states:StopExecution", "states:DescribeExecution");
    fn.addEventSource(
      new SqsEventSource(props.jobQueue, {
        batchSize: 10,
        // A failed job and the ones after it are retried; the rest of the batch isn't.
        reportBatchItemFailures: true,
        // Each instance holds a database connection; the lean database has few to spare.
        maxConcurrency: DISPATCH_CONCURRENCY,
      }),
    );
    return fn;
  }

  /**
   * The conversation queue (FIFO, one message group per PR) and its dead-letter queue, with an
   * alarm. Jobs that fail every attempt wait there for someone to look at them.
   */
  private conversationQueueOf(): Queue {
    const deadLetter = new Queue(this, "ConversationDeadLetterQueue", {
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    new Alarm(this, "ConversationDeadLetterAlarm", {
      alarmDescription:
        "LGTMoose comment jobs failed every attempt and wait in the dead-letter queue.",
      metric: deadLetter.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    return new Queue(this, "ConversationQueue", {
      fifo: true,
      // The dispatcher sets the deduplication ID to the job's delivery ID.
      contentBasedDeduplication: false,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // Well over the Lambda's timeout, as SQS event sources need.
      visibilityTimeout: Duration.seconds(CONVERSATION_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: deadLetter, maxReceiveCount: 5 },
    });
  }

  /**
   * The conversation Lambda: `@lgtmoose` commands in PR comments (`handleConversation` in
   * @lgtmoose/control). It reads and answers comments as the GitHub App, so it holds the App's
   * credentials and runs in the app subnets with the control security group, for the database
   * and GitHub. It holds no model credential, and can't start executions: a review a command
   * asks for goes on the job queue for the dispatcher.
   */
  private conversation(props: WorkflowStackProps, retention: RetentionDays): NodejsFunction {
    const fn = lgtmooseFunction(this, "ConversationFunction", {
      entry: CONVERSATION_HANDLER,
      description: "Handles @lgtmoose commands in pull request comments.",
      memorySize: 256,
      timeout: CONVERSATION_TIMEOUT,
      vpc: props.vpc,
      vpcSubnets: props.controlSubnets,
      securityGroups: [props.controlSecurityGroup],
      environment: {
        JOB_QUEUE_URL: props.jobQueue.queueUrl,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        GITHUB_APP_SECRET_ARN: secretId(props.githubAppSecret),
        LGTMOOSE_SHADOW: String(props.shadow),
        LGTMOOSE_MAX_PENDING_LEARNINGS: String(props.maxPendingLearnings ?? 5),
        LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD: String(props.repeatThreshold ?? 2),
        // Whether `explain` asks the explainer (in a run) or replies with the stored finding.
        LGTMOOSE_MAX_EXPLANATIONS: String(props.maxExplanations ?? 5),
        // Lets Node verify the RDS server certificate.
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
      bundling: { externalModules: ["pg-native"] },
      logGroup: new LogGroup(this, "ConversationLogs", {
        retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    props.databaseSecret.grantRead(fn);
    props.githubAppSecret.grantRead(fn);
    props.jobQueue.grantSendMessages(fn);
    fn.addEventSource(
      new SqsEventSource(this.conversationQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: CONVERSATION_CONCURRENCY,
      }),
    );
    return fn;
  }

  /**
   * The reconciler: on a schedule, compares open PRs with the database, queues reviews and
   * comments a missed webhook lost, and syncs drifted status labels (`reconcile` in
   * @lgtmoose/control). It runs in the app subnets with the control security group, for the
   * database and GitHub, and holds the GitHub App's credentials but no model credential. One
   * at a time: a slow run isn't overtaken by the next.
   */
  private reconciler(props: WorkflowStackProps, retention: RetentionDays): NodejsFunction {
    const fn = lgtmooseFunction(this, "ReconcileFunction", {
      entry: RECONCILE_HANDLER,
      description: "Queues missed reviews and syncs drifted status labels, on a schedule.",
      memorySize: 256,
      timeout: RECONCILE_TIMEOUT,
      reservedConcurrentExecutions: 1,
      vpc: props.vpc,
      vpcSubnets: props.controlSubnets,
      securityGroups: [props.controlSecurityGroup],
      environment: {
        JOB_QUEUE_URL: props.jobQueue.queueUrl,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        GITHUB_APP_SECRET_ARN: secretId(props.githubAppSecret),
        ALLOWED_ORGS: props.allowedOrgs.join(","),
        LGTMOOSE_SHADOW: String(props.shadow),
        RECONCILE_LOOKBACK_HOURS: String(props.reconcileLookbackHours),
        // Spend caps' prices, to settle runs post never reached (NIC-1079).
        LGTMOOSE_BUDGETS: JSON.stringify(props.budgets ?? {}),
        // Feedback signals: the acceptance report goes to the artifact bucket.
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        // Bootstraps from review history (NIC-1080) run on the review workflow.
        STATE_MACHINE_ARN: this.reviewWorkflow.stateMachine.stateMachineArn,
        LGTMOOSE_BOOTSTRAP_MAX_COST_USD: String(props.bootstrapMaxCostUsd ?? 5),
        ...(props.feedback === undefined
          ? {}
          : {
              FEEDBACK_ACCEPTANCE_THRESHOLD: String(props.feedback.acceptanceThreshold),
              FEEDBACK_MIN_SAMPLES: String(props.feedback.minSamples),
              FEEDBACK_MAX_COMMENTS: String(props.feedback.maxCommentsPerRun),
            }),
        // A newly 👎'd finding may complete a repeated rejection, which proposes a learning.
        LGTMOOSE_MAX_PENDING_LEARNINGS: String(props.maxPendingLearnings ?? 5),
        LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD: String(props.repeatThreshold ?? 2),
        // Lets Node verify the RDS server certificate.
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
      bundling: { externalModules: ["pg-native"] },
      logGroup: new LogGroup(this, "ReconcileLogs", {
        retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    props.databaseSecret.grantRead(fn);
    props.githubAppSecret.grantRead(fn);
    props.jobQueue.grantSendMessages(fn);
    // The feedback report only: nothing else in the bucket.
    props.artifactBucket.grantPut(fn, FEEDBACK_REPORT_KEY);
    // The CLI's bootstrap requests (NIC-1080): listed, read and removed under their prefix only.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [props.artifactBucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${BOOTSTRAP_REQUEST_PREFIX}*`] } },
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:DeleteObject"],
        resources: [props.artifactBucket.arnForObjects(`${BOOTSTRAP_REQUEST_PREFIX}*`)],
      }),
    );
    if (props.artifactBucket.encryptionKey !== undefined) {
      props.artifactBucket.encryptionKey.grantDecrypt(fn);
    }
    this.reviewWorkflow.stateMachine.grantStartExecution(fn);
    // Batch outputs only, read-only: their reported usage settles runs post never reached
    // (NIC-1079). Not inputs, checkouts or transcripts.
    props.artifactBucket.grantRead(fn, `${RUN_PREFIX}*/batches/*/output.json`);
    new Schedule(this, "ReconcileSchedule", {
      description: "Runs the reconciler.",
      schedule: ScheduleExpression.rate(Duration.minutes(props.reconcileIntervalMinutes)),
      // The next run is soon; a failed one isn't retried.
      target: new LambdaInvoke(fn, { retryAttempts: 0 }),
    });
    return fn;
  }

  /**
   * Alarms as the deployment's estimated spend passes 50%, 80% and 100% of its monthly cap, from
   * the `BudgetUsed` metric the post step writes (NIC-1079). Missing data keeps the alarm where
   * it is: the metric is only written when a run settles, and spend doesn't go down mid-month.
   * Without a monthly cap there's nothing to alarm on.
   */
  private budgetAlarms(budgets: DeployConfig["budgets"] | undefined): void {
    const cap = budgets?.monthlyUsd;
    if (cap === undefined) return;
    for (const percent of [50, 80, 100]) {
      new Alarm(this, `BudgetAlarm${percent}`, {
        alarmDescription: `LGTMoose's estimated model spend this month passed ${percent}% of its $${cap} cap (budgets.monthlyUsd).`,
        metric: new Metric({
          namespace: "LGTMoose",
          metricName: "BudgetUsed",
          statistic: "Maximum",
          period: Duration.hours(1),
        }),
        threshold: percent,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.IGNORE,
      });
    }
  }

  /**
   * The credential health check and an alarm per stored credential. The check runs every
   * `CREDENTIAL_CHECK_INTERVAL` and describes each provider's secret, never reading its value;
   * the broker also reports a run refused for auth (an expired or revoked token). Either sets
   * the provider's `CredentialProblem` metric to 1, which alarms until a check finds it fine.
   */
  private credentialHealth(
    props: WorkflowStackProps,
    retention: RetentionDays,
  ): Map<string, Alarm> {
    const alarms = new Map<string, Alarm>();
    const stored = props.providers.flatMap((provider) => {
      const secret = props.providerSecrets.get(provider.id);
      return secret === undefined ? [] : [{ provider, secret }];
    });
    if (stored.length === 0) return alarms;
    const fn = lgtmooseFunction(this, "CredentialHealthFunction", {
      entry: CREDENTIAL_HEALTH_HANDLER,
      description: "Checks each model provider's stored credential, without reading it.",
      memorySize: 256,
      timeout: Duration.minutes(1),
      environment: {
        LGTMOOSE_CREDENTIALS: JSON.stringify(
          Object.fromEntries(
            stored.map(({ provider, secret }) => [
              provider.id,
              {
                secretId: secretId(secret),
                auth: provider.auth,
                limit: credentialConcurrency(provider),
              },
            ]),
          ),
        ),
      },
      logGroup: new LogGroup(this, "CredentialHealthLogs", {
        retention,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:DescribeSecret", "secretsmanager:ListSecretVersionIds"],
        resources: stored.map(({ secret }) => secretArnPattern(secret)),
      }),
    );
    new Schedule(this, "CredentialHealthSchedule", {
      description: "Runs the credential health check.",
      schedule: ScheduleExpression.rate(CREDENTIAL_CHECK_INTERVAL),
      target: new LambdaInvoke(fn, { retryAttempts: 2 }),
    });
    for (const { provider } of stored) {
      alarms.set(
        provider.id,
        new Alarm(this, `CredentialAlarm-${provider.id}`, {
          alarmDescription: `The ${provider.id} provider's credential is missing, being deleted, expiring, or was refused for auth. Run lgtmoose auth for it.`,
          metric: new Metric({
            namespace: "LGTMoose",
            metricName: "CredentialProblem",
            dimensionsMap: { Provider: provider.id },
            statistic: "Maximum",
            period: CREDENTIAL_CHECK_INTERVAL,
          }),
          threshold: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );
    }
    return alarms;
  }

  private taskDefinition(
    id: string,
    size: { cpu: number; memoryLimitMiB: number; ephemeralStorageGiB: number },
  ): FargateTaskDefinition {
    const definition = new FargateTaskDefinition(this, `${id}Task`, {
      ...size,
      // Matches the Lambdas; images are built for ARM64.
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    for (const name of Object.keys(WRITABLE_MOUNTS)) definition.addVolume({ name });
    return definition;
  }

  private container(
    definition: FargateTaskDefinition,
    name: string,
    options: {
      image: ContainerImage;
      retention: RetentionDays;
      environment: Record<string, string>;
      secrets?: Record<string, EcsSecret>;
    },
  ): ContainerDefinition {
    const linuxParameters = new LinuxParameters(this, `${definition.node.id}Linux`, {
      // The entrypoint execs tini after it drops privileges. The platform init would stay
      // root with the capabilities below, so it stays off.
      initProcessEnabled: false,
    });
    // Fargate rejects adding SETUID. These three stay because they are Docker defaults and are
    // not in this list. The entrypoint clears them before tini runs.
    linuxParameters.dropCapabilities(
      Capability.AUDIT_WRITE,
      Capability.CHOWN,
      Capability.DAC_OVERRIDE,
      Capability.FOWNER,
      Capability.FSETID,
      Capability.KILL,
      Capability.MKNOD,
      Capability.NET_BIND_SERVICE,
      Capability.NET_RAW,
      Capability.SETFCAP,
      Capability.SYS_CHROOT,
    );
    const container = definition.addContainer(name, {
      image: options.image,
      essential: true,
      readonlyRootFilesystem: true,
      user: "0",
      linuxParameters,
      environment: options.environment,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      logging: LogDrivers.awsLogs({
        streamPrefix: name,
        logGroup: new LogGroup(this, `${definition.node.id}Logs`, {
          retention: options.retention,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });
    for (const [volume, path] of Object.entries(WRITABLE_MOUNTS)) {
      container.addMountPoints({ sourceVolume: volume, containerPath: path, readOnly: false });
    }
    return container;
  }
}

/**
 * The sandbox task's provider credential. ECS injects a secret only by ARN, and a secret imported
 * by name has no full ARN. A partial ARN is fine unless the name ends in a hyphen and six
 * characters: Secrets Manager then looks up a different secret and the task never starts.
 */
function sandboxCredential(providerId: string, secret: ISecret): EcsSecret {
  if (partialArnHidesName(secret.secretName)) {
    throw new Error(
      `The sandbox for provider "${providerId}" can't be given secret "${secret.secretName}" by ARN. ` +
        "The name ends in a hyphen and six characters, so Secrets Manager reads that ending as the " +
        "secret's random suffix and looks up a different secret. Choose a provider id that doesn't end that way.",
    );
  }
  return EcsSecret.fromSecretsManager(secret);
}

/**
 * The control task's embeddings settings (`readEmbeddingsSettings` in @lgtmoose/control). The
 * OpenAI key is passed by its secret's name, never its value.
 */
export function embeddingsEnvironment(
  embeddings: DeployConfig["learnings"]["embeddings"],
): Record<string, string> {
  switch (embeddings.provider) {
    case "none":
      return { LGTMOOSE_EMBEDDINGS: "none" };
    case "bedrock":
      return { LGTMOOSE_EMBEDDINGS: `bedrock:${embeddings.model}` };
    case "openai":
      return {
        LGTMOOSE_EMBEDDINGS: `openai:${embeddings.model}`,
        LGTMOOSE_EMBEDDINGS_SECRET_ID: SECRET_NAMES.openAiEmbeddings,
      };
  }
}

/**
 * The control task's ticket settings (`readTicketSettings` in @lgtmoose/control). The API key
 * is passed by its secret's name, never its value.
 */
export function ticketsEnvironment(tickets: DeployConfig["tickets"]): Record<string, string> {
  if (tickets === undefined) return { LGTMOOSE_TICKETS: "none" };
  return {
    LGTMOOSE_TICKETS: tickets.provider,
    LGTMOOSE_TICKETS_SECRET_ID: SECRET_NAMES.linearTickets,
    LGTMOOSE_TICKETS_MAX: String(tickets.maxPerPullRequest),
    LGTMOOSE_TICKETS_TEAMS: tickets.teamKeys.map((team) => team.toUpperCase()).join(","),
    LGTMOOSE_TICKETS_PUBLIC_DETAILS: String(tickets.detailsOnPublicRepos),
  };
}
