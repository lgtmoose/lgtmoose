import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureGatewayRole } from "./gateway-role.js";
import {
  localExecutionArn,
  PostgresQueue,
  postgresArtifactStore,
  postgresExecutions,
} from "./local.js";
import { postgresRunners, runExclusive } from "./runners.js";
import { pullRequests, reviewRuns } from "./schema.js";
import { postgresSpend } from "./spend.js";
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
  /** This run's database, as the owner. */
  const databaseUrl = () => {
    const url = new URL(adminUrl ?? "");
    url.pathname = `/${database}`;
    return url.toString();
  };

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

  it("gives two runners distinct executions", async () => {
    const db = drizzle({ client: pool });
    const executions = postgresExecutions(db);
    const runners = postgresRunners(db);
    await runners.register("pair-a", "host-a");
    await runners.register("pair-b", "host-b");
    for (let n = 0; n < 6; n += 1) await executions.start(`pair-${n}-abc`, { n });
    const [a, b] = await Promise.all([
      executions.claim("pair-a", 3),
      executions.claim("pair-b", 3),
    ]);
    const arnsA = (a ?? []).map((execution) => execution.arn);
    const arnsB = (b ?? []).map((execution) => execution.arn);
    expect(arnsA.filter((arn) => arnsB.includes(arn))).toEqual([]);
    expect(new Set([...arnsA, ...arnsB]).size).toBe(arnsA.length + arnsB.length);
    for (const execution of a ?? []) expect(execution.owner).toBe("pair-a");
    for (const execution of b ?? []) expect(execution.owner).toBe("pair-b");
  });

  it("recovers a killed runner's executions only once its heartbeat is stale", async () => {
    const db = drizzle({ client: pool });
    const executions = postgresExecutions(db);
    const runners = postgresRunners(db);
    const staleMs = 60_000;
    await runners.register("killed", "host-a");
    await runners.register("survivor-1", "host-b");
    await runners.register("survivor-2", "host-c");
    for (let n = 0; n < 4; n += 1) await executions.start(`killed-${n}-abc`, { n });
    const mine = (await executions.claim("killed", 10)).map((execution) => execution.arn);
    expect(mine.length).toBeGreaterThanOrEqual(4);

    // Its heartbeat is recent: nobody takes its runs.
    const early = await Promise.all([
      executions.takeOrphans("survivor-1", staleMs),
      executions.takeOrphans("survivor-2", staleMs),
    ]);
    expect(early.flat().filter((orphan) => mine.includes(orphan.arn))).toEqual([]);
    expect((await runners.live(staleMs)).has("killed")).toBe(true);

    // It's killed: no more beats, and a minute later its heartbeat is stale.
    await pool.query(
      "update local_runners set last_seen = now() - interval '2 minutes' where id = 'killed'",
    );
    expect((await runners.live(staleMs)).has("killed")).toBe(false);
    // Its runs still count: it isn't pruned while it owns one.
    await runners.pruneStale(staleMs);
    expect((await pool.query("select 1 from local_runners where id = 'killed'")).rowCount).toBe(1);

    // Two survivors recover at once: each run is taken by one of them.
    const late = await Promise.all([
      executions.takeOrphans("survivor-1", staleMs),
      executions.takeOrphans("survivor-2", staleMs),
    ]);
    const taken = late.flat().filter((orphan) => mine.includes(orphan.arn));
    expect(taken.map((orphan) => orphan.arn).sort()).toEqual([...mine].sort());
    expect(taken.every((orphan) => orphan.previousOwner === "killed")).toBe(true);
    for (const orphan of taken) await executions.finish(orphan.arn, "FAILED", "runner stopped");
    // A survivor's own runs are never taken by the other.
    await executions.start("survivor-own-abc", {});
    await executions.claim("survivor-1", 10);
    expect(
      (await executions.takeOrphans("survivor-2", staleMs)).map((orphan) => orphan.arn),
    ).not.toContain(localExecutionArn("survivor-own-abc"));

    // Now it owns nothing: the stale row goes.
    expect(await runners.pruneStale(staleMs)).toBeGreaterThanOrEqual(1);
    expect((await pool.query("select 1 from local_runners where id = 'killed'")).rowCount).toBe(0);
  });

  it("runs an advisory-locked job once across two runners", async () => {
    // Each runner has its own pool, as each process does.
    const second = new pg.Pool({ connectionString: databaseUrl(), max: 4 });
    second.on("error", onError);
    try {
      let runs = 0;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const task = async () => {
        runs += 1;
        await held;
      };
      // Both runners' timers fire at once: one runs it, the other finds the lock taken.
      const first = runExclusive(pool, "reconcile-test", 60_000, task);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runExclusive(second, "reconcile-test", 60_000, task)).toBe(false);
      release();
      expect(await first).toBe(true);
      // Just after: it ran less than half an interval ago, so the other runner skips it.
      expect(await runExclusive(second, "reconcile-test", 60_000, task)).toBe(false);
      expect(runs).toBe(1);
      // A different job isn't held up by it.
      expect(await runExclusive(second, "sweep-test", 60_000, async () => undefined)).toBe(true);
      // Once the gap has passed it runs again, on whichever runner gets there.
      expect(await runExclusive(second, "reconcile-test", 0, task)).toBe(true);
      expect(runs).toBe(2);
      // The lock was released each time: nothing is still held.
      const locks = await pool.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())",
      );
      expect(locks.rows[0]?.n).toBe(0);
    } finally {
      await second.end();
    }
  });

  it("runs a failing job's lock free again", async () => {
    await expect(
      runExclusive(pool, "failing-test", 0, async () => {
        throw new Error("the job failed");
      }),
    ).rejects.toThrow("the job failed");
    expect(await runExclusive(pool, "failing-test", 0, async () => undefined)).toBe(true);
  });

  it("never lets runs prepared at once both reserve the same spend headroom", async () => {
    const db = drizzle({ client: pool });
    const [pull] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "acme/spend",
        number: 1,
        author: "dana",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      })
      .returning({ id: pullRequests.id });
    const runs = await db
      .insert(reviewRuns)
      .values(
        Array.from({ length: 8 }, () => ({
          pullRequestId: pull?.id ?? "",
          headSha: "a".repeat(40),
          kind: "first" as const,
        })),
      )
      .returning({ id: reviewRuns.id });
    const now = new Date();
    // Eight runs on their own connections, each costing $1, under a $3 monthly cap.
    const reserved = await Promise.all(
      runs.map(async (run) => {
        const own = postgresSpend(drizzle({ client: pool }));
        const { decision } = await own.reserve(
          run.id,
          { repo: "acme/spend", prNumber: 1 },
          now,
          (snapshot) => (snapshot.monthUsd + 1 <= 3 ? { costUsd: 1, batches: 1 } : undefined),
        );
        return decision !== undefined;
      }),
    );
    expect(reserved.filter(Boolean)).toHaveLength(3);
    const snapshot = await postgresSpend(db).snapshot({ repo: "acme/spend", prNumber: 1 }, now);
    expect(snapshot).toMatchObject({ monthUsd: 3, prDayRuns: 3 });
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
