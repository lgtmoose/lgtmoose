import { fileURLToPath } from "node:url";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from "aws-lambda";
import { runMigrations } from "@lgtmoose/db/migrate";

/** The bundler copies packages/db/migrations next to this handler. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** The fields CDK's generated RDS secret and its target attachment provide. */
interface DatabaseSecret {
  host: string;
  port: number;
  username: string;
  password: string;
}

type Response = Pick<CloudFormationCustomResourceResponse, "PhysicalResourceId" | "Data">;

/**
 * Custom resource handler that applies pending migrations on every create and update.
 * CloudFormation sends an update when the resource's `migrationsHash` changes (a migration file
 * changed) or its `databaseEndpoint` changes (the database was replaced and is empty).
 * Deleting the resource leaves the database alone.
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<Response> {
  const physicalResourceId = "lgtmoose-migrations";
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalResourceId };

  const secretArn = process.env.DATABASE_SECRET_ARN;
  const database = process.env.DATABASE_NAME;
  if (!secretArn || !database) throw new Error("DATABASE_SECRET_ARN and DATABASE_NAME must be set");

  const client = new SecretsManagerClient({});
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!SecretString) throw new Error("database secret has no value");
  const secret = JSON.parse(SecretString) as DatabaseSecret;

  await runMigrations({
    host: secret.host,
    port: secret.port,
    user: secret.username,
    password: secret.password,
    database,
    ssl: true,
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { MigrationsHash: String(event.ResourceProperties.migrationsHash ?? "") },
  };
}
