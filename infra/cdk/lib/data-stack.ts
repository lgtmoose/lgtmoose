import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CfnOutput,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  Port,
  SecurityGroup,
  type ISecurityGroup,
  type Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  DatabaseInstance,
  DatabaseInstanceEngine,
  ParameterGroup,
  PostgresEngineVersion,
  StorageType,
} from "aws-cdk-lib/aws-rds";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Secret, type ISecret } from "aws-cdk-lib/aws-secretsmanager";
import { Provider } from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";
import { SECRET_NAMES, providerNeedsSecret, type DeployConfig } from "@lgtmoose/config";
import { POSTGRES_PORT, type Profile } from "./network-stack.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/migrations");
const MIGRATE_HANDLER = fileURLToPath(new URL("../lambda/migrate.ts", import.meta.url));

export const DATABASE_NAME = "lgtmoose";
/** Batches, findings and transcripts are working files; nothing in the bucket is kept long. */
export const ARTIFACT_RETENTION_DAYS = 30;

export interface DataStackProps extends StackProps {
  profile: Profile;
  providers: DeployConfig["providers"];
  vpc: Vpc;
  /** Control tasks and Lambdas; the only callers allowed to reach Postgres. */
  controlSecurityGroup: ISecurityGroup;
}

/**
 * State for LGTMoose: Postgres with pgvector, the artifact bucket, and references to the
 * secrets that `lgtmoose setup` and `lgtmoose auth` create.
 *
 * - lean: RDS PostgreSQL 18 on db.t4g.micro, single AZ
 * - standard: Aurora PostgreSQL Serverless v2 with a writer and a reader in different AZs
 *
 * Migrations run as a custom resource whenever a migration file changes, before any stack that
 * depends on this one is updated.
 */
export class DataStack extends Stack {
  readonly database: DatabaseInstance | DatabaseCluster;
  readonly databaseSecret: ISecret;
  readonly databaseSecurityGroup: ISecurityGroup;
  readonly artifactBucket: Bucket;
  readonly githubAppSecret: ISecret;
  /** Provider id → its credential secret. Bedrock providers have none. */
  readonly providerSecrets: ReadonlyMap<string, ISecret>;
  readonly migrations: CustomResource;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const lean = props.profile === "lean";
    const appSubnets = { subnetGroupName: "app" };

    this.databaseSecurityGroup = new SecurityGroup(this, "DatabaseSg", {
      vpc: props.vpc,
      description: "LGTMoose Postgres",
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      props.controlSecurityGroup,
      Port.tcp(POSTGRES_PORT),
      "Control tasks and Lambdas",
    );

    const credentials = Credentials.fromGeneratedSecret("lgtmoose", {
      secretName: SECRET_NAMES.database,
    });
    const common = {
      vpc: props.vpc,
      vpcSubnets: appSubnets,
      securityGroups: [this.databaseSecurityGroup],
      credentials,
      storageEncrypted: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: lean ? RetentionDays.ONE_WEEK : RetentionDays.ONE_MONTH,
    };

    if (lean) {
      const engine = DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_18 });
      const instance = new DatabaseInstance(this, "Database", {
        ...common,
        engine,
        databaseName: DATABASE_NAME,
        instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
        allocatedStorage: 20,
        maxAllocatedStorage: 100,
        storageType: StorageType.GP3,
        multiAz: false,
        publiclyAccessible: false,
        backupRetention: Duration.days(7),
        parameterGroup: new ParameterGroup(this, "DatabaseParams", {
          engine,
          parameters: { "rds.force_ssl": "1" },
        }),
      });
      this.database = instance;
    } else {
      const engine = DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_18_6,
      });
      const cluster = new DatabaseCluster(this, "Database", {
        ...common,
        engine,
        defaultDatabaseName: DATABASE_NAME,
        serverlessV2MinCapacity: 0.5,
        serverlessV2MaxCapacity: 4,
        writer: ClusterInstance.serverlessV2("writer"),
        readers: [ClusterInstance.serverlessV2("reader", { scaleWithWriter: true })],
        backup: { retention: Duration.days(14) },
        parameterGroup: new ParameterGroup(this, "DatabaseParams", {
          engine,
          parameters: { "rds.force_ssl": "1" },
        }),
      });
      this.database = cluster;
    }
    const secret = this.database.secret;
    if (!secret) throw new Error("database has no generated secret");
    this.databaseSecret = secret;

    this.artifactBucket = new Bucket(this, "Artifacts", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          expiration: Duration.days(ARTIFACT_RETENTION_DAYS),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.githubAppSecret = Secret.fromSecretNameV2(this, "GithubAppSecret", SECRET_NAMES.githubApp);
    this.providerSecrets = new Map(
      props.providers
        .filter(providerNeedsSecret)
        .map((provider) => [
          provider.id,
          Secret.fromSecretNameV2(
            this,
            `ProviderSecret-${provider.id}`,
            SECRET_NAMES.provider(provider.id),
          ),
        ]),
    );

    this.migrations = this.addMigrations(props, appSubnets);

    new CfnOutput(this, "ArtifactBucketName", { value: this.artifactBucket.bucketName });
    new CfnOutput(this, "DatabaseSecretArn", { value: this.databaseSecret.secretArn });
  }

  private addMigrations(
    props: DataStackProps,
    appSubnets: { subnetGroupName: string },
  ): CustomResource {
    const handler = new NodejsFunction(this, "MigrateFunction", {
      entry: MIGRATE_HANDLER,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: appSubnets,
      securityGroups: [props.controlSecurityGroup],
      depsLockFilePath: join(REPO_ROOT, "pnpm-lock.yaml"),
      projectRoot: REPO_ROOT,
      environment: {
        DATABASE_SECRET_ARN: this.databaseSecret.secretArn,
        // Lets Node verify the RDS server certificate.
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        // pg is CommonJS and requires Node built-ins; give the ESM bundle a real `require`.
        banner:
          "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        externalModules: ["@aws-sdk/*", "pg-native"],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            `cp -R "${MIGRATIONS_DIR}" "${outputDir}/migrations"`,
          ],
        },
      },
    });
    this.databaseSecret.grantRead(handler);

    const provider = new Provider(this, "MigrateProvider", { onEventHandler: handler });
    const migrations = new CustomResource(this, "Migrations", {
      serviceToken: provider.serviceToken,
      properties: { migrationsHash: hashDirectory(MIGRATIONS_DIR) },
    });
    migrations.node.addDependency(this.database);
    return migrations;
  }
}

/** Hash of every file in a directory tree, so any migration change re-runs the custom resource. */
export function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        hash.update(path.slice(dir.length));
        hash.update(readFileSync(path));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
