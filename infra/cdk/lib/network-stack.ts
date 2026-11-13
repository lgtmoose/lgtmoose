import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import {
  AmazonLinuxCpuType,
  GatewayVpcEndpointAwsService,
  InstanceClass,
  InstanceSize,
  InstanceType,
  InterfaceVpcEndpointAwsService,
  MachineImage,
  NatProvider,
  NatTrafficDirection,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  type ISecurityGroup,
  type SubnetSelection,
} from "aws-cdk-lib/aws-ec2";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export type Profile = "lean" | "standard";

export interface NetworkStackProps extends StackProps {
  profile: Profile;
}

/** Port the egress proxy (NIC-813) listens on. */
export const PROXY_PORT = 3128;

export const POSTGRES_PORT = 5432;

/**
 * Where sandbox tasks send model API traffic: the egress proxy's private DNS name. The proxy
 * stack (NIC-813) owns the `lgtmoose.internal` Cloud Map namespace and registers the proxy in it
 * as `egress-proxy`; keep this in step with its `PROXY_URL`.
 */
export const PROXY_URL = `http://egress-proxy.lgtmoose.internal:${PROXY_PORT}`;

/** AWS services sandbox tasks reach through interface endpoints instead of the internet. */
const SANDBOX_INTERFACE_ENDPOINTS = {
  EcrApi: InterfaceVpcEndpointAwsService.ECR,
  EcrDocker: InterfaceVpcEndpointAwsService.ECR_DOCKER,
  SecretsManager: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  Logs: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
};

/**
 * VPC and security groups for LGTMoose.
 *
 * Subnets:
 * - public: NAT (instance or gateways)
 * - app (private, with egress): control tasks, Lambdas, the egress proxy, the database
 * - sandbox (isolated, no route to the internet): sandbox tasks. They reach model APIs only
 *   through the proxy, and AWS services only through VPC endpoints.
 *
 * Both profiles span two AZs, because an RDS subnet group needs two.
 * - lean: one NAT instance (t4g.nano); sandbox subnet and interface endpoints in one AZ
 * - standard: a NAT gateway, sandbox subnet and interface endpoints in each AZ
 */
export class NetworkStack extends Stack {
  readonly vpc: Vpc;
  /** Control tasks and Lambdas. They hold GitHub credentials and may send HTTPS anywhere. */
  readonly controlSecurityGroup: ISecurityGroup;
  /** Sandbox tasks. Outbound only to the proxy, the interface endpoints and S3. */
  readonly sandboxSecurityGroup: ISecurityGroup;
  /** The egress proxy. Accepts sandbox tasks on PROXY_PORT and sends HTTPS out. */
  readonly proxySecurityGroup: ISecurityGroup;
  /** Where sandbox tasks run. */
  readonly sandboxSubnets: SubnetSelection;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const lean = props.profile === "lean";

    const natInstance = lean
      ? NatProvider.instanceV2({
          instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
          machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
          defaultAllowedTraffic: NatTrafficDirection.OUTBOUND_ONLY,
        })
      : undefined;

    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: lean ? 1 : 2,
      natGatewayProvider: natInstance ?? NatProvider.gateway(),
      subnetConfiguration: [
        { name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: "app", subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: "sandbox", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
    });
    this.vpc = vpc;

    // The NAT instance accepts traffic from inside the VPC only, never from the internet.
    natInstance?.connections.allowFrom(Peer.ipv4(vpc.vpcCidrBlock), Port.allTraffic());

    this.controlSecurityGroup = this.securityGroup("ControlSg", "control tasks and Lambdas");
    this.controlSecurityGroup.addEgressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      "HTTPS to GitHub and AWS",
    );
    // Declared here rather than in the Data stack, so the rule doesn't create a cross-stack cycle.
    this.controlSecurityGroup.addEgressRule(
      Peer.ipv4(vpc.vpcCidrBlock),
      Port.tcp(POSTGRES_PORT),
      "Postgres inside the VPC",
    );

    this.proxySecurityGroup = this.securityGroup("ProxySg", "egress proxy");
    this.proxySecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS to model APIs");

    this.sandboxSecurityGroup = this.securityGroup("SandboxSg", "sandbox tasks");
    this.sandboxSecurityGroup.connections.allowTo(
      this.proxySecurityGroup,
      Port.tcp(PROXY_PORT),
      "Model APIs through the egress proxy",
    );

    const firstAz = vpc.availabilityZones[0];
    this.sandboxSubnets =
      lean && firstAz !== undefined
        ? { subnetGroupName: "sandbox", availabilityZones: [firstAz] }
        : { subnetGroupName: "sandbox" };

    const endpointSecurityGroup = this.securityGroup("EndpointSg", "VPC interface endpoints");
    this.sandboxSecurityGroup.connections.allowTo(
      endpointSecurityGroup,
      Port.tcp(443),
      "AWS services through VPC endpoints",
    );
    for (const [name, service] of Object.entries(SANDBOX_INTERFACE_ENDPOINTS)) {
      vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        subnets: this.sandboxSubnets,
        securityGroups: [endpointSecurityGroup],
        privateDnsEnabled: true,
        open: false,
      });
    }

    // ECR image layers and the S3 batch files go through the free gateway endpoint.
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetGroupName: "sandbox" }, { subnetGroupName: "app" }],
    });
    this.sandboxSecurityGroup.addEgressRule(
      Peer.prefixList(this.s3PrefixListId()),
      Port.tcp(443),
      "S3 through the gateway endpoint",
    );

    new CfnOutput(this, "VpcId", { value: vpc.vpcId });
    new CfnOutput(this, "SandboxSecurityGroupId", {
      value: this.sandboxSecurityGroup.securityGroupId,
    });
  }

  private securityGroup(id: string, purpose: string): SecurityGroup {
    return new SecurityGroup(this, id, {
      vpc: this.vpc,
      description: `LGTMoose ${purpose}`,
      allowAllOutbound: false,
    });
  }

  /**
   * The AWS-managed S3 prefix list for this region. CloudFormation has no intrinsic for it, so a
   * small custom resource looks it up at deploy time and synth needs no AWS credentials.
   */
  private s3PrefixListId(): string {
    const lookup = new AwsCustomResource(this, "S3PrefixListLookup", {
      onUpdate: {
        service: "EC2",
        action: "describeManagedPrefixLists",
        parameters: {
          Filters: [{ Name: "prefix-list-name", Values: [`com.amazonaws.${this.region}.s3`] }],
        },
        physicalResourceId: PhysicalResourceId.of("s3-prefix-list"),
        outputPaths: ["PrefixLists.0.PrefixListId"],
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });
    return lookup.getResponseField("PrefixLists.0.PrefixListId");
  }
}
