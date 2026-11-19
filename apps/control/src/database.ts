import { readFileSync } from "node:fs";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { z } from "zod";

/** Any drizzle Postgres database: node-postgres in AWS, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT>;

/** A secret's JSON value. Errors name the secret, never its value. */
export async function readSecret(client: SecretsManagerClient, secretId: string): Promise<unknown> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) throw new Error(`Secret ${secretId} has no string value.`);
  try {
    return JSON.parse(SecretString) as unknown;
  } catch {
    // The value is a credential: never echo it.
    throw new Error(`Secret ${secretId} isn't JSON.`);
  }
}

export function parseSecret<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  // Only the field paths: the issues could quote the values.
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`The ${what} secret is missing fields or has the wrong types: ${fields}.`);
  }
  return parsed.data;
}

const databaseSecretSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * TLS for one Postgres pool. With `caFile`, only that connection trusts the file.
 * Without it, verification uses Node's own trust store (the Lambda runtime bundle,
 * via `NODE_EXTRA_CA_CERTS`).
 */
export function databaseTls(caFile?: string): { rejectUnauthorized: true; ca?: string } {
  if (caFile === undefined) return { rejectUnauthorized: true };
  let ca: string;
  try {
    ca = readFileSync(caFile, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new Error(`Database CA file ${caFile} could not be read (${code}).`);
  }
  if (!ca.includes("BEGIN CERTIFICATE")) {
    throw new Error(`Database CA file ${caFile} has no certificate.`);
  }
  return { rejectUnauthorized: true, ca };
}

/** A TLS-verified pool on the database whose generated secret is `secretId`. */
export async function databasePool(
  client: SecretsManagerClient,
  secretId: string,
  databaseName: string,
  max: number,
): Promise<pg.Pool> {
  const database = parseSecret(
    databaseSecretSchema,
    await readSecret(client, secretId),
    "database",
  );
  return new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.username,
    password: database.password,
    database: databaseName,
    ssl: databaseTls(),
    max,
  });
}
