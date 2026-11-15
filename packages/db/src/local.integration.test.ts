import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresQueue, postgresArtifactStore, postgresExecutions } from "./local.js";
import { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

/**
 * The docker compose stand-ins (NIC-843) under real concurrency: several connections at once,
 * which PGlite (one connection) can't show. Set LGTMOOSE_TEST_DATABASE_URL as for
 * migrate.integration.test.ts; CI's integration job sets it.
 */
const adminUrl = process.env.LGTMOOSE_TEST_DATABASE_URL;
if (adminUrl === undefined && process.env.CI === "true") {
  throw new Error("LGTMOOSE_TEST_DATABASE_URL must be set in CI");
}

describe.skipIf(adminUrl === undefined)("local stand-ins on Postgres", () => {
  const database = `lgtmoose_local_${randomBytes(4).toString("hex")}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    const parsed = new URL(adminUrl ?? "");
    parsed.pathname = `/${database}`;
    await runMigrations({
      connectionString: parsed.toString(),
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 16 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("never hands one message, or two of one group, to concurrent receivers", async () => {
    const db = drizzle({ client: pool });
    const queue = new PostgresQueue(db, "concurrent");
    for (let group = 0; group < 20; group += 1) {
      for (let n = 0; n < 3; n += 1) {
        await queue.send({ groupId: `pr-${group}`, dedupeId: `${group}-${n}`, body: `${n}` });
      }
    }
    // Eight receivers at once, each on its own connection.
    const taken = (
      await Promise.all(Array.from({ length: 8 }, () => queue.receive(10, 60_000)))
    ).flat();
    const ids = taken.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    const groups = taken.map((message) => message.groupId);
    expect(new Set(groups).size).toBe(groups.length);
    // Each group's first message, never a later one.
    expect(taken.every((message) => message.body === "0")).toBe(true);
    expect(taken).toHaveLength(20);
  });

  it("lets exactly one of many concurrent writers create or replace an object", async () => {
    const store = postgresArtifactStore(drizzle({ client: pool }));
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.createText("claims/run", `attempt-${i}`)),
    );
    expect(created.filter((etag) => etag !== undefined)).toHaveLength(1);

    const current = await store.getTagged("claims/run");
    const replaced = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.replaceText("claims/run", `takeover-${i}`, current?.etag ?? ""),
      ),
    );
    expect(replaced.filter((etag) => etag !== undefined)).toHaveLength(1);
  });

  it("hands each execution to one of many concurrent runners", async () => {
    const executions = postgresExecutions(drizzle({ client: pool }));
    for (let n = 0; n < 10; n += 1) await executions.start(`pr-${n}-abc`, { n });
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => executions.claim(`runner-${i}`, 10)),
    );
    const arns = claims.flat().map((execution) => execution.arn);
    expect(new Set(arns).size).toBe(arns.length);
    expect(arns).toHaveLength(10);
  });
});
