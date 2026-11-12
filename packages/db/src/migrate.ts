import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/** Folder with the generated SQL migrations, shipped with this package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrateOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Require TLS. RDS for PostgreSQL 15+ forces TLS by default. */
  ssl?: boolean;
  migrationsFolder?: string;
}

/** Applies every pending migration. Safe to run repeatedly: applied migrations are skipped. */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const { migrationsFolder = MIGRATIONS_FOLDER, ssl, ...connection } = options;
  const client = new pg.Client({
    ...connection,
    ...(ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
