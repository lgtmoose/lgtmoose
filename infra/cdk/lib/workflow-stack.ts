import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type { ISecurityGroup, IVpc, SubnetSelection } from "aws-cdk-lib/aws-ec2";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  Capability,
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateTaskDefinition,
  LinuxParameters,
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
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { IQueue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { providerModelEnv, STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import { lgtmooseFunction } from "./lambda.js";
import type { Profile } from "./network-stack.js";
import { bedrockStatements } from "./bedrock.js";
import { BATCH_TIMEOUT, ReviewWorkflow } from "./review-workflow.js";
import { sandboxBuildArgs } from "./sandbox-image.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DISPATCH_HANDLER = join(REPO_ROOT, "apps/control/src/dispatch-lambda.ts");
const RECONCILE_HANDLER = join(REPO_ROOT, "apps/control/src/reconcile-lambda.ts");

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
  /**
   * Build the sandbox image with the Cursor CLI even though its checksum isn't recorded
   * (`sandboxBuildArgs`). Off by default.
   */
  allowUnverifiedCursor?: boolean;
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
 * Both run as a non-root user with a read-only root filesystem, all Linux capabilities dropped,
 * and writable volumes only at /work and /tmp. Networking is set when a task is started
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
  readonly reconcileFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);
    const lean = props.profile === "lean";
    const retention = lean ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH;

    this.cluster = new Cluster(this, "Cluster", { vpc: props.vpc });

    const controlImage = image("apps/control/Dockerfile");
    const sandboxImage = image(
      "infra/sandbox/Dockerfile",
      sandboxBuildArgs(props.providers, props.allowUnverifiedCursor ?? false),
    );

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
        GITHUB_APP_SECRET_ARN: props.githubAppSecret.secretArn,
        LGTMOOSE_REVIEWER_MODEL: props.reviewerModel,
        LGTMOOSE_BATCH_TIMEOUT_MS: String(BATCH_TIMEOUT.toMilliseconds()),
        LGTMOOSE_SHADOW: String(props.shadow),
      },
    });
    const controlRole = this.controlTaskDefinition.taskRole;
    props.githubAppSecret.grantRead(controlRole);
    props.databaseSecret.grantRead(controlRole);
    props.artifactBucket.grantReadWrite(controlRole);
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
          ...providerModelEnv(provider),
        },
        // The execution role reads the secret to start the task; the task's own role can't
        // read any secret.
        ...(secret === undefined
          ? {}
          : { secrets: { LGTMOOSE_PROVIDER_CREDENTIAL: EcsSecret.fromSecretsManager(secret) } }),
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

    const reviewerTask = sandboxes.get(props.reviewerProviderId);
    const reviewerContainer = sandboxContainers.get(props.reviewerProviderId);
    if (reviewerTask === undefined || reviewerContainer === undefined) {
      throw new Error(`No sandbox task for the reviewer provider ${props.reviewerProviderId}.`);
    }
    this.reviewWorkflow = new ReviewWorkflow(this, "Review", {
      cluster: this.cluster,
      retention,
      artifactBucket: props.artifactBucket,
      control: { taskDefinition: this.controlTaskDefinition, container: controlContainer },
      controlSubnets: props.controlSubnets,
      controlSecurityGroup: props.controlSecurityGroup,
      sandbox: { taskDefinition: reviewerTask, container: reviewerContainer },
      sandboxSubnets: props.sandboxSubnets,
      sandboxSecurityGroup: props.sandboxSecurityGroup,
      maxConcurrency: props.maxConcurrency,
    });

    this.dispatchFunction = this.dispatcher(props, retention);
    this.reconcileFunction = this.reconciler(props, retention);

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
        GITHUB_APP_SECRET_ARN: props.githubAppSecret.secretArn,
        ALLOWED_ORGS: props.allowedOrgs.join(","),
        LGTMOOSE_SHADOW: String(props.shadow),
        RECONCILE_LOOKBACK_HOURS: String(props.reconcileLookbackHours),
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
    new Schedule(this, "ReconcileSchedule", {
      description: "Runs the reconciler.",
      schedule: ScheduleExpression.rate(Duration.minutes(props.reconcileIntervalMinutes)),
      // The next run is soon; a failed one isn't retried.
      target: new LambdaInvoke(fn, { retryAttempts: 0 }),
    });
    return fn;
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
      // Reaps the processes the agent CLIs leave behind.
      initProcessEnabled: true,
    });
    linuxParameters.dropCapabilities(Capability.ALL);
    const container = definition.addContainer(name, {
      image: options.image,
      essential: true,
      readonlyRootFilesystem: true,
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
 * An image CDK builds from the repository root with the given Dockerfile, for arm64 (see
 * `IMAGE_ARCH`).
 */
function image(file: string, buildArgs: Record<string, string> = {}): ContainerImage {
  return ContainerImage.fromAsset(REPO_ROOT, { file, platform: Platform.LINUX_ARM64, buildArgs });
}
