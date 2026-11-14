import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

/**
 * Runs the real migration runner (node-postgres, as the migration Lambda does) against a real
 * Postgres with pgvector. Set LGTMOOSE_TEST_DATABASE_URL to an admin connection, for example
 * postgres://postgres:postgres@localhost:5432/postgres. Runs as `test:integration`, not with the
 * unit tests. CI's integration job always sets it, and fails if it's missing rather than skipping.
 */
const adminUrl = process.env.LGTMOOSE_TEST_DATABASE_URL;
if (adminUrl === undefined && process.env.CI === "true") {
  throw new Error("LGTMOOSE_TEST_DATABASE_URL must be set in CI");
}

describe.skipIf(adminUrl === undefined)("runMigrations on Postgres", () => {
  const database = `lgtmoose_test_${randomBytes(4).toString("hex")}`;
  let url = "";

  async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    const parsed = new URL(adminUrl ?? "");
    parsed.pathname = `/${database}`;
    url = parsed.toString();
  });

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("enables pgvector and creates every table", async () => {
    await runMigrations({ connectionString: url, migrationsFolder: MIGRATIONS_FOLDER });
    const extensions = await query<{ extname: string }>("select extname from pg_extension");
    expect(extensions.map((row) => row.extname)).toContain("vector");
    const tables = await query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(tables.map((row) => row.tablename)).toEqual([
      "dispatched_executions",
      "feedback",
      "files_reviewed",
      "finding_events",
      "findings",
      "learnings",
      "provider_cooldowns",
      "provider_usage",
      "pull_request_dispatches",
      "pull_requests",
      "review_runs",
    ]);
    const indexes = await query<{ indexdef: string }>(
      "select indexdef from pg_indexes where indexname = 'learnings_embedding_idx'",
    );
    expect(indexes[0]?.indexdef).toContain("USING hnsw");
  });

  it("is safe to run again", async () => {
    await expect(
      runMigrations({ connectionString: url, migrationsFolder: MIGRATIONS_FOLDER }),
    ).resolves.toBeUndefined();
    const applied = await query<{ count: string }>(
      "select count(*) from drizzle.__drizzle_migrations",
    );
    expect(Number(applied[0]?.count)).toBeGreaterThan(0);
  });
});
