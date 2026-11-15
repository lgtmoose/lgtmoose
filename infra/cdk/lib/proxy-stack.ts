import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import type { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import { SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import { FilterPattern, LogGroup, MetricFilter, RetentionDays } from "aws-cdk-lib/aws-logs";
import { DnsRecordType, PrivateDnsNamespace } from "aws-cdk-lib/aws-servicediscovery";
import type { Construct } from "constructs";
import { STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import { taskImage } from "./images.js";
import { PROXY_PORT, type Profile } from "./network-stack.js";

const PROXY_DIR = fileURLToPath(new URL("../../../apps/egress-proxy/", import.meta.url));

/** The private DNS namespace for LGTMoose services inside the VPC. */
export const SERVICE_NAMESPACE = "lgtmoose.internal";
/** The proxy's name in that namespace. */
export const PROXY_SERVICE_NAME = "egress-proxy";
/** What sandbox tasks set HTTPS_PROXY (and https_proxy) to. */
export const PROXY_URL = `http://${PROXY_SERVICE_NAME}.${SERVICE_NAMESPACE}:${PROXY_PORT}`;

export interface ProxyStackProps extends StackProps {
  profile: Profile;
  vpc: IVpc;
  /** The network stack's proxy group: sandbox tasks may connect to it on PROXY_PORT. */
  proxySecurityGroup: ISecurityGroup;
  /** Exact hostnames the proxy lets through (see `egressAllowlist` in @lgtmoose/config). */
  allowedHosts: readonly string[];
  /** Where the proxy image comes from (`images` in the deploy config). */
  images?: DeployConfig["images"];
}

/**
 * The egress proxy: a small Fargate service in the app subnets that sandbox tasks must use to
 * reach the internet. It allows `CONNECT host:443` for the allowlisted model APIs only, and logs
 * every refusal. Sandbox tasks find it at `PROXY_URL` through a Cloud Map private DNS name.
 *
 * lean runs one task; standard runs two, in different AZs.
 */
export class ProxyStack extends Stack {
  /** Set sandbox tasks' HTTPS_PROXY to this. */
  readonly proxyUrl = PROXY_URL;
  readonly namespace: PrivateDnsNamespace;
  readonly service: FargateService;
  readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: ProxyStackProps) {
    super(scope, id, props);
    const hosts = [...new Set(props.allowedHosts)].sort();
    if (hosts.length === 0) throw new Error("ProxyStack needs at least one allowed host");
    for (const host of hosts) {
      if (!/^[a-z0-9.-]+$/.test(host) || host.includes("..")) {
        throw new Error(`Not an exact hostname for the egress allowlist: ${JSON.stringify(host)}`);
      }
    }

    const cluster = new Cluster(this, "Cluster", { vpc: props.vpc });
    this.namespace = new PrivateDnsNamespace(this, "Namespace", {
      name: SERVICE_NAMESPACE,
      vpc: props.vpc,
      description: "LGTMoose services inside the VPC",
    });

    this.logGroup = new LogGroup(this, "Logs", { retention: RetentionDays.ONE_MONTH });
    // Refusals as a metric, so a sandbox that keeps trying to reach somewhere else stands out.
    new MetricFilter(this, "BlockedRequests", {
      logGroup: this.logGroup,
      metricNamespace: "LGTMoose",
      metricName: "EgressBlocked",
      filterPattern: FilterPattern.stringValue("$.event", "=", "blocked"),
      metricValue: "1",
    });

    const task = new FargateTaskDefinition(this, "Task", {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer("Proxy", {
      image: taskImage(props.images ?? { source: "build" }, "egressProxy", {
        directory: PROXY_DIR,
      }),
      environment: { ALLOWED_HOSTS: hosts.join(","), PORT: String(PROXY_PORT) },
      portMappings: [{ containerPort: PROXY_PORT }],
      readonlyRootFilesystem: true,
      user: "node",
      logging: LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: "egress-proxy" }),
      healthCheck: {
        command: [
          "CMD",
          "node",
          "-e",
          `fetch("http://127.0.0.1:${PROXY_PORT}/healthz").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(10),
      },
    });

    this.service = new FargateService(this, "Service", {
      cluster,
      taskDefinition: task,
      desiredCount: props.profile === "lean" ? 1 : 2,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.proxySecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      // Keep the old task until the new one is healthy, so sandbox runs keep their way out.
      minHealthyPercent: 100,
      cloudMapOptions: {
        cloudMapNamespace: this.namespace,
        name: PROXY_SERVICE_NAME,
        dnsRecordType: DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
        containerPort: PROXY_PORT,
      },
    });

    new CfnOutput(this, STACK_OUTPUTS.proxy.proxyUrl, { value: PROXY_URL });
  }
}
