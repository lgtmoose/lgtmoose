import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig } from "@lgtmoose/config";
import { beforeAll, describe, expect, it } from "vitest";
import { ALLOW_DATABASE_DELETION, PURGE_DATA, buildApp } from "./app.js";
import {
  ARTIFACT_RETENTION_DAYS,
  FREE_STORAGE_ALARM_BYTES,
  MIGRATIONS_DIR,
  hashDirectory,
} from "./data-stack.js";
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

  it("keeps the bucket and the database secret by default", () => {
    const { template } = synth("lean");
    template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
    template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Retain" });
    template.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
  });

  it("lets `destroy --purge` delete the database, its secret and the bucket", () => {
    const purged = build(
      "lean",
      new App({ context: { "aws:cdk:bundling-stacks": [], [PURGE_DATA]: "true" } }),
    );
    purged.template.hasResource("AWS::RDS::DBInstance", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({ DeletionProtection: false }),
    });
    purged.template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete" });
    purged.template.hasResource("AWS::SecretsManager::Secret", { DeletionPolicy: "Delete" });
    purged.template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  });

  it("standard: db.t4g.small PostgreSQL 18 with a Multi-AZ standby and 14 days of backups", () => {
    const { template } = synth("standard");
    template.resourceCountIs("AWS::RDS::DBCluster", 0);
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      DBInstanceClass: "db.t4g.small",
      MultiAZ: true,
      BackupRetentionPeriod: 14,
      StorageEncrypted: true,
      DeletionProtection: true,
    });
    template.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
  });

  it("standard alarms on database CPU and free storage; lean doesn't", () => {
    const names = (profile: Profile) =>
      Object.keys(synth(profile).template.findResources("AWS::CloudWatch::Alarm"));
    expect(names("standard").some((id) => id.startsWith("DatabaseCpuAlarm"))).toBe(true);
    expect(names("standard").some((id) => id.startsWith("DatabaseStorageAlarm"))).toBe(true);
    expect(names("lean")).toHaveLength(0);
    synth("standard").template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "FreeStorageSpace",
      ComparisonOperator: "LessThanThreshold",
      Threshold: FREE_STORAGE_ALARM_BYTES,
    });
  });

  // Switching profile is a redeploy. CloudFormation replaces a resource whose logical ID or type
  // changes, or when a property that "requires replacement" changes; a replaced database is a new,
  // empty one. These properties all require replacement on AWS::RDS::DBInstance.
  const REPLACING_PROPERTIES = [
    "Engine",
    "DBName",
    "StorageEncrypted",
    "KmsKeyId",
    "MasterUsername",
    "DBSubnetGroupName",
    "DBInstanceIdentifier",
    "DBClusterIdentifier",
    "SourceDBInstanceIdentifier",
    "DBSnapshotIdentifier",
    "CharacterSetName",
    "Timezone",
    "AvailabilityZone",
  ];

  it("switching profile modifies the database in place: same resource, nothing that replaces it", () => {
    const databaseOf = (profile: Profile) => {
      const found = synth(profile).template.findResources("AWS::RDS::DBInstance");
      const entries = Object.entries(found);
      expect(entries).toHaveLength(1);
      const [logicalId, resource] = entries[0] ?? [];
      return { logicalId, resource };
    };
    const lean = databaseOf("lean");
    const standard = databaseOf("standard");
    expect(standard.logicalId).toBe(lean.logicalId);
    expect(standard.resource?.Type).toBe(lean.resource?.Type);
    for (const name of REPLACING_PROPERTIES) {
      expect(standard.resource?.Properties?.[name], name).toEqual(
        lean.resource?.Properties?.[name],
      );
    }
    // Snapshot on delete, protected from deletion, in both.
    expect(standard.resource?.DeletionPolicy).toBe("Snapshot");
    expect(lean.resource?.DeletionPolicy).toBe("Snapshot");
    expect(standard.resource?.UpdateReplacePolicy).toBe("Snapshot");
    expect(lean.resource?.UpdateReplacePolicy).toBe("Snapshot");
  });

  it("switching profile keeps the subnet group, the parameter group family and the bucket", () => {
    for (const type of [
      "AWS::RDS::DBSubnetGroup",
      "AWS::RDS::DBParameterGroup",
      "AWS::S3::Bucket",
    ]) {
      const ids = (profile: Profile) =>
        Object.keys(synth(profile).template.findResources(type)).sort();
      expect(ids("standard"), type).toEqual(ids("lean"));
    }
    const family = (profile: Profile) =>
      Object.values(synth(profile).template.findResources("AWS::RDS::DBParameterGroup")).map(
        (group) => group.Properties?.Family,
      );
    expect(family("standard")).toEqual(family("lean"));
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
      // The app bundles several Lambdas; the migration handler is the one with migrations/.
      .find((dir) => existsSync(join(dir, "index.mjs")) && existsSync(join(dir, "migrations")));
    expect(bundle).toBeDefined();
    const bundled = readdirSync(join(bundle as string, "migrations"));
    expect(bundled).toEqual(expect.arrayContaining(readdirSync(MIGRATIONS_DIR)));
  }, 60_000);
});
