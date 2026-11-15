import { Template } from "aws-cdk-lib/assertions";
import { SECRET_NAMES, isGitHubHost, parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { appWithoutBundling } from "./test-utils.js";

/**
 * The sandbox controls in SECURITY.md, checked on the synthesised stacks with a provider of each
 * harness and auth kind at once (Cursor's sandbox image needs its recorded checksum to synth, so
 * it's left out here): the model sandbox can't reach GitHub and can't read GitHub or database
 * secrets. The network side (no route out, only the proxy and VPC endpoints) is in
 * network-stack.test.ts, and the proxy's refusal of hosts off its list in
 * apps/egress-proxy/src/proxy.test.ts.
 */

type Resource = { Type: string; Properties: Record<string, unknown> };
type Resources = Record<string, Resource>;
type Statement = { Effect?: string; Action: string | string[]; Resource: unknown };

const PROVIDERS = [
  { id: "claude", harness: "claude-code", auth: "oauth-token" },
  { id: "claude-key", harness: "claude-code", auth: "api-key" },
  { id: "bedrock", harness: "claude-code", auth: "bedrock" },
  { id: "sdk", harness: "agent-sdk", auth: "api-key" },
  { id: "chatgpt", harness: "codex", auth: "chatgpt-login" },
  { id: "openai", harness: "codex", auth: "api-key" },
] as const;

let workflow: Resources;
let proxy: Resources;

beforeAll(() => {
  const config = parseDeployConfig({
    allowedOrgs: ["lgtmoose"],
    providers: PROVIDERS,
    extraEgressHosts: ["gateway.example.com"],
  });
  const stacks = buildApp(config, appWithoutBundling());
  workflow = Template.fromStack(stacks.workflow).toJSON().Resources as Resources;
  proxy = Template.fromStack(stacks.proxy).toJSON().Resources as Resources;
}, 120_000);

const ofType = (resources: Resources, type: string) =>
  Object.values(resources).filter((resource) => resource.Type === type);

/** Each sandbox task definition, by its LGTMOOSE_PROVIDER. */
function sandboxTasks(): { provider: string; properties: Record<string, unknown> }[] {
  return ofType(workflow, "AWS::ECS::TaskDefinition").flatMap((resource) => {
    const [container] = resource.Properties.ContainerDefinitions as {
      Environment?: { Name: string; Value: unknown }[];
    }[];
    const provider = container?.Environment?.find((e) => e.Name === "LGTMOOSE_PROVIDER")?.Value;
    return typeof provider === "string" ? [{ provider, properties: resource.Properties }] : [];
  });
}

function roleId(arn: unknown): string {
  const att = (arn as { "Fn::GetAtt"?: [string, string] })["Fn::GetAtt"];
  if (att === undefined) throw new Error(`not a GetAtt: ${JSON.stringify(arn)}`);
  return att[0];
}

/** The statements of every policy attached to a role, and the role's own managed policies. */
function grants(id: string): { statements: Statement[]; managed: unknown[] } {
  const statements = ofType(workflow, "AWS::IAM::Policy")
    .filter((policy) =>
      (policy.Properties.Roles as { Ref: string }[]).some((role) => role.Ref === id),
    )
    .flatMap(
      (policy) => (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement,
    );
  const role = workflow[id];
  const inline = (
    (role?.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]
  ).flatMap((policy) => policy.PolicyDocument.Statement);
  return {
    statements: [...statements, ...inline],
    managed: (role?.Properties.ManagedPolicyArns ?? []) as unknown[],
  };
}

const actionsOf = (statement: Statement) =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

describe("sandbox controls", () => {
  it("has a sandbox task for every provider", () => {
    expect(
      sandboxTasks()
        .map((task) => task.provider)
        .toSorted(),
    ).toEqual(PROVIDERS.map((provider) => provider.id).toSorted());
  });

  it("never lets the egress proxy through to GitHub, whatever the providers", () => {
    const [task] = ofType(proxy, "AWS::ECS::TaskDefinition");
    if (task === undefined) throw new Error("the Proxy stack has no task definition");
    const [container] = task.Properties.ContainerDefinitions as {
      Environment: { Name: string; Value: string }[];
    }[];
    const hosts = container?.Environment.find((e) => e.Name === "ALLOWED_HOSTS")?.Value ?? "";
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts.split(",").filter((host) => isGitHubHost(host))).toEqual([]);
  });

  it("refuses a GitHub host in extraEgressHosts at config time", () => {
    expect(() =>
      parseDeployConfig({ allowedOrgs: ["lgtmoose"], extraEgressHosts: ["api.github.com"] }),
    ).toThrow(/GitHub/);
  });

  it("gives no sandbox role GitHub, webhook, database or other providers' secrets", () => {
    for (const { provider, properties } of sandboxTasks()) {
      for (const arn of [properties.TaskRoleArn, properties.ExecutionRoleArn]) {
        const { statements, managed } = grants(roleId(arn));
        // No AWS-managed policy that could carry secret access (the execution role's ECR and
        // logs access is granted as statements).
        expect(JSON.stringify(managed)).not.toMatch(/SecretsManager|AdministratorAccess|PowerUser/);
        for (const statement of statements) {
          const secretActions = actionsOf(statement).filter(
            (action) => action.startsWith("secretsmanager:") || action === "*",
          );
          if (secretActions.length === 0) continue;
          const resource = JSON.stringify(statement.Resource);
          // Never every secret, and only this provider's own credential.
          expect(resource).not.toBe('"*"');
          expect(resource).not.toContain(SECRET_NAMES.githubApp);
          expect(resource).not.toContain(SECRET_NAMES.githubWebhook);
          expect(resource).not.toMatch(/DatabaseSecret|DbSecret|Database.*Secret/i);
          expect(resource).toContain(SECRET_NAMES.provider(provider));
        }
      }
    }
  });

  it("puts no GitHub credential in a sandbox task's environment or secrets", () => {
    for (const { properties } of sandboxTasks()) {
      const [container] = properties.ContainerDefinitions as {
        Environment?: { Name: string; Value: unknown }[];
        Secrets?: { Name: string; ValueFrom: unknown }[];
      }[];
      const names = [
        ...(container?.Environment ?? []).map((e) => e.Name),
        ...(container?.Secrets ?? []).map((s) => s.Name),
      ];
      expect(names.filter((name) => /GITHUB|GH_|DATABASE|WEBHOOK/.test(name))).toEqual([]);
      expect(JSON.stringify(container?.Secrets ?? [])).not.toContain(SECRET_NAMES.githubApp);
    }
  });
});
