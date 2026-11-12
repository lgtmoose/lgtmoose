import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { ALLOW_DATABASE_DELETION, buildApp } from "./app.js";
import { ARTIFACT_RETENTION_DAYS, MIGRATIONS_DIR, hashDirectory } from "./data-stack.js";
import type { Profile } from "./network-stack.js";
import { appWithoutBundling, memoizeByProfile } from "./test-utils.js";

function build(profile: Profile, app: App) {
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

const synth = memoizeByProfile((profile) => build(profile, appWithoutBundling()));

beforeAll(() => {
  synth("lean");
  synth("standard");
}, 60_000);

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

  it("lets `destroy` turn deletion protection off, and only then", () => {
    const allowed = build(
      "lean",
      new App({
        context: { "aws:cdk:bundling-stacks": [], [ALLOW_DATABASE_DELETION]: "true" },
      }),
    );
    allowed.template.hasResourceProperties("AWS::RDS::DBInstance", { DeletionProtection: false });
    // Still snapshotted on delete.
    allowed.template.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
    synth("lean").template.hasResourceProperties("AWS::RDS::DBInstance", {
      DeletionProtection: true,
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
    // The only secret this stack owns is the generated database credential, named by CDK.
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    const [secret] = Object.values(template.findResources("AWS::SecretsManager::Secret"));
    expect(secret?.Properties.Name).toBeUndefined();
    // Kept on stack deletion, like the database snapshot it unlocks.
    expect(secret?.DeletionPolicy).toBe("Retain");
    expect(secret?.UpdateReplacePolicy).toBe("Retain");
    expect(secret?.Properties.Tags).toEqual(
      expect.arrayContaining([{ Key: "lgtmoose:stack", Value: "Lgtmoose-Data" }]),
    );
    // The database (and so its snapshots, which copy its tags) names the secret that unlocks it.
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      CopyTagsToSnapshot: true,
      Tags: Match.arrayWith([
        Match.objectLike({ Key: "lgtmoose:credentials-secret", Value: Match.anyValue() }),
      ]),
    });
  });

  it("runs migrations through a Node 24 Lambda, keyed on the migrations and the database", () => {
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
      // A replaced database has a new endpoint, which re-runs the migrations on it.
      databaseEndpoint: { "Fn::GetAtt": [Match.stringLikeRegexp("^Database"), "Endpoint.Address"] },
    });
  });

  it("bundles the migration handler with the SQL migrations next to it", () => {
    const outdir = mkdtempSync(join(tmpdir(), "lgtmoose-cdk-"));
    const { app } = build("lean", new App({ outdir }));
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
