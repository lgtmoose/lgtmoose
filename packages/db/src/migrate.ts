import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * The migrations folder inside this package, for callers that run from the source tree (tests,
 * local scripts). Bundled callers must pass their own path: once bundled, this resolves relative
 * to the bundle, not the package.
 */
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
  /** Folder holding the SQL files and meta/_journal.json. Required: see MIGRATIONS_FOLDER. */
  migrationsFolder: string;
}

/** Applies every pending migration. Safe to run repeatedly: applied migrations are skipped. */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const { migrationsFolder, ssl, ...connection } = options;
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
