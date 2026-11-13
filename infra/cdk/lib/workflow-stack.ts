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
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import type { Profile } from "./network-stack.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The S3 prefix sandbox tasks may read and write. Everything else in the bucket is control's. */
export const SANDBOX_PREFIX = "sandbox/";

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
  vpc: IVpc;
  /** Where control tasks run: the app subnets, with egress. */
  controlSubnets: SubnetSelection;
  controlSecurityGroup: ISecurityGroup;
  /** Where sandbox tasks run: isolated subnets whose only way out is the proxy. */
  sandboxSubnets: SubnetSelection;
  sandboxSecurityGroup: ISecurityGroup;
  /** The egress proxy, as sandbox tasks reach it (see `PROXY_URL` in the network stack). */
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
}

/**
 * The review workflow's compute: an ECS cluster, the control task and one sandbox task per model
 * provider. The Step Functions workflow that runs them comes with NIC-811.
 *
 * - The control task holds the GitHub App credentials and the database, and never runs a model.
 * - A sandbox task holds one provider's credential and no GitHub token. Its role can only read
 *   and write under `SANDBOX_PREFIX` in the artifact bucket, and call Bedrock when the provider
 *   uses it. One task definition per provider means a task can only ever see its own credential.
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

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);
    const lean = props.profile === "lean";
    const retention = lean ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH;

    this.cluster = new Cluster(this, "Cluster", { vpc: props.vpc });

    const controlImage = image("apps/control/Dockerfile");
    const sandboxImage = image("infra/sandbox/Dockerfile");

    this.controlTaskDefinition = this.taskDefinition("Control", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      // Clones of large repositories.
      ephemeralStorageGiB: 50,
    });
    this.container(this.controlTaskDefinition, "control", {
      image: controlImage,
      retention,
      environment: {
        ARTIFACT_BUCKET: props.artifactBucket.bucketName,
        DATABASE_SECRET_ARN: props.databaseSecret.secretArn,
        DATABASE_NAME: props.databaseName,
        GITHUB_APP_SECRET_ARN: props.githubAppSecret.secretArn,
      },
    });
    const controlRole = this.controlTaskDefinition.taskRole;
    props.githubAppSecret.grantRead(controlRole);
    props.databaseSecret.grantRead(controlRole);
    props.artifactBucket.grantReadWrite(controlRole);

    const sandboxes = new Map<string, FargateTaskDefinition>();
    for (const provider of props.providers) {
      const definition = this.taskDefinition(`Sandbox-${provider.id}`, {
        cpu: 2048,
        memoryLimitMiB: 4096,
        ephemeralStorageGiB: 30,
      });
      const secret = props.providerSecrets.get(provider.id);
      this.container(definition, "sandbox", {
        image: sandboxImage,
        retention,
        environment: {
          ARTIFACT_BUCKET: props.artifactBucket.bucketName,
          ARTIFACT_PREFIX: SANDBOX_PREFIX,
          LGTMOOSE_PROVIDER: provider.id,
          LGTMOOSE_HARNESS: provider.harness,
          LGTMOOSE_AUTH: provider.auth,
          HTTPS_PROXY: props.proxyUrl,
          NO_PROXY: noProxy(this.region),
          AWS_REGION: this.region,
        },
        // The execution role reads the secret to start the task; the task's own role can't
        // read any secret.
        ...(secret === undefined
          ? {}
          : { secrets: { LGTMOOSE_PROVIDER_CREDENTIAL: EcsSecret.fromSecretsManager(secret) } }),
      });
      this.grantSandboxStorage(definition, props.artifactBucket);
      if (provider.auth === "bedrock") this.grantBedrock(definition);
      sandboxes.set(provider.id, definition);
    }
    this.sandboxTaskDefinitions = sandboxes;

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

  /** Read and write under `SANDBOX_PREFIX` only: no listing, nothing else in the bucket. */
  private grantSandboxStorage(definition: FargateTaskDefinition, bucket: IBucket): void {
    definition.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
        resources: [bucket.arnForObjects(`${SANDBOX_PREFIX}*`)],
      }),
    );
  }

  /** Bedrock providers use the task role instead of a stored credential. */
  private grantBedrock(definition: FargateTaskDefinition): void {
    definition.taskRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:${this.partition}:bedrock:*::foundation-model/*`,
          `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );
  }
}

/** An image CDK builds from the repository root with the given Dockerfile. */
function image(file: string): ContainerImage {
  return ContainerImage.fromAsset(REPO_ROOT, { file, platform: Platform.LINUX_ARM64 });
}
