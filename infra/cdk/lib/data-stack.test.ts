import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ARTIFACT_RETENTION_DAYS, MIGRATIONS_DIR, hashDirectory } from "./data-stack.js";
import type { Profile } from "./network-stack.js";
import { appWithoutBundling } from "./test-utils.js";

function synth(profile: Profile, app: App = appWithoutBundling()) {
  const config = parseDeployConfig({
    profile,
    allowedOrgs: ["lgtmoose"],
    providers: [
      { id: "claude", harness: "claude-code", auth: "oauth-token" },
      { id: "bedrock", harness: "claude-code", auth: "bedrock" },
    ],
  });
  const stacks = buildApp(config, app);
  return { ...stacks, template: Template.fromStack(stacks.data) };
}

describe("DataStack", () => {
  it("lean: an encrypted, private db.t4g.micro PostgreSQL 18 instance with TLS forced", () => {
    const { template } = synth("lean");
    template.resourceCountIs("AWS::RDS::DBCluster", 0);
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: Match.stringLikeRegexp("^18"),
      DBInstanceClass: "db.t4g.micro",
      StorageEncrypted: true,
      PubliclyAccessible: false,
      DeletionProtection: true,
      MultiAZ: false,
      DBName: "lgtmoose",
    });
    template.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
    template.hasResourceProperties("AWS::RDS::DBParameterGroup", {
      Parameters: { "rds.force_ssl": "1" },
    });
  });

  it("standard: Aurora Serverless v2 with a writer and a reader", () => {
    const { template } = synth("standard");
    template.resourceCountIs("AWS::RDS::DBInstance", 2);
    template.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      DeletionProtection: true,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
    });
  });

  it.each<Profile>(["lean", "standard"])(
    "%s: only the control security group can reach Postgres",
    (profile) => {
      const { template, network } = synth(profile);
      const ingress = Object.values(template.findResources("AWS::EC2::SecurityGroupIngress"));
      const toDatabase = ingress.filter((rule) =>
        JSON.stringify(rule.Properties.GroupId).includes("DatabaseSg"),
      );
      expect(toDatabase).toHaveLength(1);
      expect(toDatabase[0]?.Properties).toMatchObject({ FromPort: 5432, ToPort: 5432 });
      // The source is the Network stack's control security group, imported across stacks.
      const source = JSON.stringify(toDatabase[0]?.Properties.SourceSecurityGroupId);
      expect(source).toContain(`${network.stackName}:`);
      expect(source).toContain("ControlSg");
    },
  );

  it("artifact bucket blocks public access, forces TLS, expires objects and is retained", () => {
    const { template } = synth("lean");
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: {
          Rules: [
            Match.objectLike({ ExpirationInDays: ARTIFACT_RETENTION_DAYS, Status: "Enabled" }),
          ],
        },
      }),
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("references provider secrets for every provider except Bedrock, and never creates them", () => {
    const { data, template } = synth("lean");
    expect([...data.providerSecrets.keys()]).toEqual(["claude"]);
    // The only secret this stack owns is the generated database credential.
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "lgtmoose/database" });
  });

  it("runs migrations through a Node 24 Lambda in the VPC, keyed on the migrations hash", () => {
    const { template } = synth("lean");
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      VpcConfig: Match.anyValue(),
      Environment: {
        Variables: Match.objectLike({ NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem" }),
      },
    });
    template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      migrationsHash: hashDirectory(MIGRATIONS_DIR),
    });
  });

  it("bundles the migration handler with the SQL migrations next to it", () => {
    const outdir = mkdtempSync(join(tmpdir(), "lgtmoose-cdk-"));
    const { app } = synth("lean", new App({ outdir }));
    const assembly = app.synth();
    const assetDirs = readdirSync(assembly.directory).filter((name) => name.startsWith("asset."));
    const bundle = assetDirs
      .map((name) => join(assembly.directory, name))
      .find((dir) => existsSync(join(dir, "index.mjs")));
    expect(bundle).toBeDefined();
    const bundled = readdirSync(join(bundle as string, "migrations"));
    expect(bundled).toEqual(expect.arrayContaining(readdirSync(MIGRATIONS_DIR)));
  }, 60_000);
});
