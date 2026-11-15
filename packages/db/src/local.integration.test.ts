import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureGatewayRole } from "./gateway-role.js";
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

/**
 * A pool or client's `error` listener. The teardown drops the database `with (force)`, which
 * terminates any connection still open (57P01, admin_shutdown); that's expected there and
 * ignored. Anything else is thrown, so the test fails on it rather than the process.
 */
function onError(error: Error & { code?: string }): void {
  if (error.code === "57P01") return;
  throw error;
}

describe.skipIf(adminUrl === undefined)("local stand-ins on Postgres", () => {
  const database = `lgtmoose_local_${randomBytes(4).toString("hex")}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", onError);
    await admin.connect();
    try {
      await admin.query(`create database ${database}`);
    } finally {
      await admin.end();
    }
    const parsed = new URL(adminUrl ?? "");
    parsed.pathname = `/${database}`;
    await runMigrations({
      connectionString: parsed.toString(),
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 16 });
    // Idle clients the server terminates at teardown emit here, not as an unhandled error.
    pool.on("error", onError);
  }, 60_000);

  afterAll(async () => {
    // Every client is released by then; end waits for them all to close.
    await pool.end();
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", onError);
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${database} with (force)`);
    } finally {
      await admin.end();
    }
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

  it("lets the gateway's login add jobs and nothing else", async () => {
    // Roles are cluster-wide: one of this run's own.
    const role = `lgtmoose_gateway_test_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    const owner = await pool.connect();
    try {
      await ensureGatewayRole(owner, password, role);
      // Again, as every runner start does: the password is set again, the grants stay.
      await ensureGatewayRole(owner, password, role);
    } finally {
      owner.release();
    }
    await postgresArtifactStore(drizzle({ client: pool })).putText("runs/secret.json", "{}");

    const url = new URL(adminUrl ?? "");
    url.pathname = `/${database}`;
    url.username = role;
    url.password = password;
    const gateway = new pg.Pool({ connectionString: url.toString(), max: 2 });
    gateway.on("error", onError);
    try {
      const queue = new PostgresQueue(drizzle({ client: gateway }), "jobs");
      expect(await queue.send({ groupId: "acme/shop#1", dedupeId: "d-1", body: "{}" })).toBe(true);
      // A redelivery is dropped, not an error.
      expect(await queue.send({ groupId: "acme/shop#1", dedupeId: "d-1", body: "{}" })).toBe(false);
      for (const sql of [
        "select body from job_queue",
        "update job_queue set body = 'x'",
        "delete from job_queue",
        "select * from artifacts",
        "select * from findings",
        "select * from local_executions",
        "insert into artifacts (key, body, etag) values ('k', 'x', 'e')",
      ]) {
        await expect(gateway.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      await gateway.end();
      const admin = await pool.connect();
      try {
        await admin.query(`drop owned by ${role}`);
        await admin.query(`drop role ${role}`);
      } finally {
        admin.release();
      }
    }
  });
});
