import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { NetworkStack, PROXY_PORT, type Profile } from "./network-stack.js";
import { memoizeByProfile } from "./test-utils.js";

type Resource = { Type: string; Properties?: Record<string, unknown> };

function build(profile: Profile) {
  const stack = new NetworkStack(new App(), "Network", { profile });
  const template = Template.fromStack(stack);
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const logicalId = (resolved: string) =>
    (stack.resolve(resolved) as { "Fn::GetAtt": [string] })["Fn::GetAtt"][0];
  return {
    stack,
    template,
    resources,
    sandboxSgId: logicalId(stack.sandboxSecurityGroup.securityGroupId),
  };
}

const synth = memoizeByProfile(build);

beforeAll(() => {
  synth("lean");
  synth("standard");
}, 60_000);

function ofType(resources: Record<string, Resource>, type: string) {
  return Object.entries(resources).filter(([, resource]) => resource.Type === type);
}

/** Every egress rule of a security group, inline or as a separate resource. */
function egressRules(resources: Record<string, Resource>, groupLogicalId: string) {
  const inline = (resources[groupLogicalId]?.Properties?.SecurityGroupEgress ?? []) as Record<
    string,
    unknown
  >[];
  const separate = ofType(resources, "AWS::EC2::SecurityGroupEgress")
    .map(([, resource]) => resource.Properties as Record<string, unknown>)
    .filter((rule) => JSON.stringify(rule.GroupId).includes(groupLogicalId));
  return [...inline, ...separate];
}

describe("NetworkStack", () => {
  describe.each<Profile>(["lean", "standard"])("%s profile", (profile) => {
    it("gives sandbox subnets no route to the internet", () => {
      const { resources } = synth(profile);
      const defaultRoutes = ofType(resources, "AWS::EC2::Route").filter(
        ([, route]) => route.Properties?.DestinationCidrBlock === "0.0.0.0/0",
      );
      // Two AZs: one internet route per public subnet and one NAT route per app subnet.
      expect(defaultRoutes).toHaveLength(4);
      for (const [, route] of defaultRoutes) {
        expect(JSON.stringify(route.Properties?.RouteTableId)).not.toMatch(/sandbox/i);
      }
    });

    it("lets sandbox tasks out only to the proxy, the VPC endpoints and S3", () => {
      const { resources, sandboxSgId } = synth(profile);
      const rules = egressRules(resources, sandboxSgId);

      expect(rules.length).toBe(3);
      for (const rule of rules) {
        expect(rule.CidrIp).toBeUndefined();
        expect(rule.CidrIpv6).toBeUndefined();
      }
      expect(rules.map((rule) => rule.FromPort).sort((a, b) => Number(a) - Number(b))).toEqual([
        443,
        443,
        PROXY_PORT,
      ]);
      expect(rules.filter((rule) => rule.DestinationPrefixListId !== undefined)).toHaveLength(1);
    });

    it("creates private interface endpoints for ECR, Secrets Manager and Logs, plus S3", () => {
      const { resources } = synth(profile);
      const endpoints = ofType(resources, "AWS::EC2::VPCEndpoint").map(([, r]) => r.Properties);
      const interfaces = endpoints.filter((e) => e?.VpcEndpointType === "Interface");
      expect(interfaces).toHaveLength(4);
      for (const endpoint of interfaces) expect(endpoint?.PrivateDnsEnabled).toBe(true);
      expect(endpoints.filter((e) => e?.VpcEndpointType === "Gateway")).toHaveLength(1);
    });

    it("lets everything in the VPC reach the interface endpoints over HTTPS", () => {
      const { resources } = synth(profile);
      const [, endpointSg] =
        ofType(resources, "AWS::EC2::SecurityGroup").find(
          ([, group]) => group.Properties?.GroupDescription === "LGTMoose VPC interface endpoints",
        ) ?? [];
      const ingress = (endpointSg?.Properties?.SecurityGroupIngress ?? []) as Record<
        string,
        unknown
      >[];
      expect(ingress).toContainEqual(
        expect.objectContaining({
          FromPort: 443,
          ToPort: 443,
          CidrIp: { "Fn::GetAtt": [expect.stringMatching(/^Vpc/), "CidrBlock"] },
        }),
      );
    });
  });

  it("lean: one t4g.nano NAT instance and no NAT gateways", () => {
    const { template, resources } = synth("lean");
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::Instance", 1);
    template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.nano" });

    // The NAT instance never accepts connections from the internet.
    const ingress = ofType(resources, "AWS::EC2::SecurityGroup").flatMap(
      ([, group]) => (group.Properties?.SecurityGroupIngress ?? []) as Record<string, unknown>[],
    );
    expect(ingress.some((rule) => rule.CidrIp === "0.0.0.0/0")).toBe(false);
  });

  it("lean: puts the sandbox subnet and interface endpoints in one AZ", () => {
    const { stack } = synth("lean");
    expect(stack.vpc.selectSubnets(stack.sandboxSubnets).subnets).toHaveLength(1);
  });

  it("standard: a NAT gateway per AZ and no NAT instance", () => {
    const { template, stack } = synth("standard");
    template.resourceCountIs("AWS::EC2::NatGateway", 2);
    template.resourceCountIs("AWS::EC2::Instance", 0);
    expect(stack.vpc.selectSubnets(stack.sandboxSubnets).subnets).toHaveLength(2);
  });

  it("looks up the S3 prefix list at deploy time instead of synth time", () => {
    const { resources } = synth("lean");
    const lookups = ofType(resources, "Custom::AWS");
    expect(lookups).toHaveLength(1);
    expect(JSON.stringify(lookups[0]?.[1].Properties?.Create)).toContain(
      "describeManagedPrefixLists",
    );
  });
});
