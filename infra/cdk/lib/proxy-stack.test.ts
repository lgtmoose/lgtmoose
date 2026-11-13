import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { STACK_OUTPUTS } from "@lgtmoose/config";
import { NetworkStack, PROXY_PORT, type Profile } from "./network-stack.js";
import { PROXY_URL, ProxyStack } from "./proxy-stack.js";
import { memoizeByProfile } from "./test-utils.js";

const HOSTS = ["chatgpt.com", "api.anthropic.com", "api.anthropic.com"];

function build(profile: Profile) {
  const app = new App();
  const network = new NetworkStack(app, "Network", { profile });
  const stack = new ProxyStack(app, "Proxy", {
    profile,
    vpc: network.vpc,
    proxySecurityGroup: network.proxySecurityGroup,
    allowedHosts: HOSTS,
  });
  return { network, stack, template: Template.fromStack(stack) };
}

const synth = memoizeByProfile(build);

beforeAll(() => {
  synth("lean");
  synth("standard");
}, 60_000);

describe("ProxyStack", () => {
  it("runs the proxy with the allowlist, sorted and deduplicated", () => {
    synth("lean").template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "ALLOWED_HOSTS", Value: "api.anthropic.com,chatgpt.com" },
            { Name: "PORT", Value: String(PROXY_PORT) },
          ]),
          ReadonlyRootFilesystem: true,
          User: "node",
          PortMappings: [Match.objectLike({ ContainerPort: PROXY_PORT })],
          HealthCheck: Match.objectLike({ Command: Match.arrayWith(["CMD", "node"]) }),
        }),
      ],
    });
  });

  it("runs in the app subnets with the network's proxy group, without a public IP", () => {
    const { network, stack, template } = synth("lean");
    const groupId = stack.resolve(network.proxySecurityGroup.securityGroupId) as unknown;
    template.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
      DesiredCount: 1,
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: "DISABLED",
          SecurityGroups: [Match.objectLike({ "Fn::ImportValue": Match.anyValue() })],
        }),
      },
    });
    expect(groupId).toBeDefined();
  });

  it("runs two tasks in standard", () => {
    synth("standard").template.hasResourceProperties("AWS::ECS::Service", { DesiredCount: 2 });
  });

  it("registers a private DNS name and outputs the proxy URL", () => {
    const { template } = synth("lean");
    template.hasResourceProperties("AWS::ServiceDiscovery::PrivateDnsNamespace", {
      Name: "lgtmoose.internal",
    });
    template.hasResourceProperties("AWS::ServiceDiscovery::Service", {
      Name: "egress-proxy",
      DnsConfig: Match.objectLike({ DnsRecords: [{ TTL: 10, Type: "A" }] }),
    });
    template.hasOutput(STACK_OUTPUTS.proxy.proxyUrl, { Value: PROXY_URL });
    expect(PROXY_URL).toBe(`http://egress-proxy.lgtmoose.internal:${PROXY_PORT}`);
  });

  it("counts blocked requests from the proxy's log", () => {
    synth("lean").template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '{ $.event = "blocked" }',
      MetricTransformations: [
        Match.objectLike({ MetricName: "EgressBlocked", MetricNamespace: "LGTMoose" }),
      ],
    });
  });

  it("refuses an empty or malformed allowlist", () => {
    const app = new App();
    const network = new NetworkStack(app, "Network", { profile: "lean" });
    const props = {
      profile: "lean" as const,
      vpc: network.vpc,
      proxySecurityGroup: network.proxySecurityGroup,
    };
    expect(() => new ProxyStack(app, "Empty", { ...props, allowedHosts: [] })).toThrow(
      "at least one allowed host",
    );
    expect(() => new ProxyStack(app, "Bad", { ...props, allowedHosts: ["*.openai.com"] })).toThrow(
      "Not an exact hostname",
    );
  });
});
