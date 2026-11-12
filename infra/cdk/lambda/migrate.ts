import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from "aws-lambda";
import { runMigrations } from "@lgtmoose/db/migrate";

/** The bundler copies packages/db/migrations next to this handler. */
const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;

interface DatabaseSecret {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

type Response = Pick<CloudFormationCustomResourceResponse, "PhysicalResourceId" | "Data">;

/**
 * Custom resource handler that applies pending migrations on every create and update.
 * The resource's `migrationsHash` property changes whenever a migration file does, which
 * makes CloudFormation call this handler again. Deleting the resource leaves the database alone.
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<Response> {
  const physicalResourceId = "lgtmoose-migrations";
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalResourceId };

  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) throw new Error("DATABASE_SECRET_ARN is not set");

  const client = new SecretsManagerClient({});
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!SecretString) throw new Error("database secret has no value");
  const secret = JSON.parse(SecretString) as DatabaseSecret;

  await runMigrations({
    host: secret.host,
    port: secret.port,
    user: secret.username,
    password: secret.password,
    database: secret.dbname,
    ssl: true,
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { MigrationsHash: String(event.ResourceProperties.migrationsHash ?? "") },
  };
}
