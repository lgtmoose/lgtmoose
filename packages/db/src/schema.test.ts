import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { and, cosineDistance, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";
import * as schema from "./schema.js";

const { pullRequests, reviewRuns, findings, learnings, EMBEDDING_DIMENSIONS } = schema;

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client, { schema });

/** Drizzle wraps database errors; the Postgres message is on `cause`. */
async function expectDbError(query: PromiseLike<unknown>, pattern: RegExp) {
  const error = await Promise.resolve(query).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).cause ?? error)).toMatch(pattern);
}

/** A unit vector along one axis, so similarity ordering is easy to reason about. */
function axis(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
}

// Starting PGlite (Postgres compiled to WebAssembly) and migrating takes a few seconds alone,
// and much longer while turbo runs every other package's tests and typechecks alongside it.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("migrations", () => {
  it("enable pgvector and create every table", async () => {
    const extensions = await client.query<{ extname: string }>("select extname from pg_extension");
    expect(extensions.rows.map((row) => row.extname)).toContain("vector");

    const tables = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "artifacts",
      "dashboard_sessions",
      "dispatched_executions",
      "feedback",
      "files_reviewed",
      "finding_events",
      "findings",

      "job_queue",
      "learning_events",
      "learnings",

      "local_executions",
      "local_runners",
      "local_schedules",
      "pending_replies",
      "provider_cooldowns",
      "provider_usage",
      "pull_request_dispatches",
      "pull_requests",
      "review_runs",
      "spend_ledger",
    ]);
  });

  it("are safe to run again", async () => {
    await expect(migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.toBeUndefined();
  });
});

describe("schema", () => {
  it("keeps one row per pull request and one finding per fingerprint", async () => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "lgtmoose/lgtmoose",
        number: 7,
        author: "someone",
        headSha: "abc",
        baseSha: "def",
      })
      .returning();
    if (!pr) throw new Error("insert failed");

    await expectDbError(
      db.insert(pullRequests).values({ ...pr, id: undefined }),
      /pull_requests_repo_number_key/,
    );

    const [run] = await db
      .insert(reviewRuns)
      .values({ pullRequestId: pr.id, headSha: "abc", kind: "first" })
      .returning();
    const finding = {
      pullRequestId: pr.id,
      runId: run?.id,
      fingerprint: "fp-1",
      ruleCategory: "authz",
      severity: "blocking" as const,
      path: "src/routes.ts",
      line: 12,
      side: "RIGHT" as const,
      title: "Route has no auth check",
      body: "…",
      raisedAtSha: "abc",
    };
    await db.insert(findings).values(finding);
    await expectDbError(
      db.insert(findings).values(finding),
      /findings_pull_request_fingerprint_key/,
    );

    const open = await db
      .select()
      .from(findings)
      .where(and(eq(findings.pullRequestId, pr.id), eq(findings.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]?.source).toBe("self");
  });

  it("stores GitHub comment IDs above 2^31", async () => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "lgtmoose/big-ids",
        number: 1,
        author: "someone",
        headSha: "abc",
        baseSha: "def",
        summaryCommentId: 2_512_345_678,
      })
      .returning();
    expect(pr?.summaryCommentId).toBe(2_512_345_678);

    const [finding] = await db
      .insert(findings)
      .values({
        pullRequestId: pr?.id as string,
        fingerprint: "fp-big",
        ruleCategory: "correctness",
        severity: "nit",
        title: "t",
        body: "b",
        raisedAtSha: "abc",
        githubCommentId: 3_000_000_001,
      })
      .returning();
    expect(finding?.githubCommentId).toBe(3_000_000_001);
  });

  it("ranks learnings by embedding similarity", async () => {
    const base = {
      org: "lgtmoose",
      repo: "lgtmoose/lgtmoose",
      kind: "convention" as const,
      status: "active" as const,
      author: "someone",
      authorPermission: "write",
    };
    await db.insert(learnings).values([
      { ...base, text: "about auth", embedding: axis(0) },
      { ...base, text: "about payments", embedding: axis(1) },
    ]);

    const query = axis(1);
    const ranked = await db
      .select({ text: learnings.text, distance: cosineDistance(learnings.embedding, query) })
      .from(learnings)
      .orderBy(cosineDistance(learnings.embedding, query))
      .limit(2);
    expect(ranked.map((row) => row.text)).toEqual(["about payments", "about auth"]);
  });

  it("rejects embeddings of the wrong size", async () => {
    await expectDbError(
      db.execute(
        sql`insert into learnings (org, kind, text, author, author_permission, embedding)
            values ('o', 'convention', 't', 'a', 'write', '[1,2,3]')`,
      ),
      /expected 1024 dimensions/,
    );
  });
});
