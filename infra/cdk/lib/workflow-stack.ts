import { fileURLToPath } from "node:url";
import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { providerModelEnv, STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import type { Profile } from "./network-stack.js";
import { bedrockStatements } from "./bedrock.js";
import { BATCH_TIMEOUT, ReviewWorkflow } from "./review-workflow.js";
import { sandboxBuildArgs } from "./sandbox-image.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
  /**
   * Build the sandbox image with the Cursor CLI even though its checksum isn't recorded
   * (`sandboxBuildArgs`). Off by default.
   */
  allowUnverifiedCursor?: boolean;
}

/**
 * The review workflow: an ECS cluster, the control task, one sandbox task per model provider, and
 * the Step Functions state machine that runs them (`ReviewWorkflow`).
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
