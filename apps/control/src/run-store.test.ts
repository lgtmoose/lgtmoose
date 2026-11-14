import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleRunStore } from "./aws.js";

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleRunStore(db);

// PGlite starts slowly, and more slowly while turbo runs other packages alongside.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

function start(executionArn: string, number = 1) {
  return store.startRun({
    installationId: 5,
    repo: "acme/shop",
    number,
    author: "dev",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    executionArn,
  });
}

async function runRow(runId: string) {
  const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, runId));
  return row;
}

describe("drizzleRunStore", () => {
  it("records a running run with its execution ARN, once per execution", async () => {
    const run = await start("arn:exec:1");
    expect(await start("arn:exec:1")).toEqual(run);
    expect(await runRow(run.runId)).toMatchObject({
      status: "running",
      kind: "first",
      executionArn: "arn:exec:1",
    });
    expect(run.summaryCommentId).toBeUndefined();
  });

  it("records the result on the run and the PR, and the next run edits the same comment", async () => {
    const run = await start("arn:exec:2", 2);
    await store.setFilesTotal(run.runId, 3);
    await store.succeedRun(run.runId, {
      filesDone: 3,
      costUsd: 0.12345,
      headSha: "a".repeat(40),
      statusLabel: "lgtmoose: changes requested",
      summaryCommentId: 77,
    });
    expect(await runRow(run.runId)).toMatchObject({
      status: "succeeded",
      filesTotal: 3,
      filesDone: 3,
      costUsd: "0.1235",
    });
    const [pr] = await db.select().from(pullRequests).where(eq(pullRequests.id, run.pullRequestId));
    expect(pr).toMatchObject({ lastReviewedSha: "a".repeat(40), summaryCommentId: 77 });

    const next = await start("arn:exec:3", 2);
    expect(next).toMatchObject({ pullRequestId: run.pullRequestId, summaryCommentId: 77 });
    expect(await runRow(next.runId)).toMatchObject({ kind: "full" });
  });

  it("fails only an unfinished run of the execution", async () => {
    const run = await start("arn:exec:4", 4);
    await store.failRun("arn:exec:4", "States.TaskFailed");
    expect(await runRow(run.runId)).toMatchObject({ status: "failed", error: "States.TaskFailed" });

    const superseded = await start("arn:exec:5", 5);
    await store.supersedeRun(superseded.runId);
    await store.failRun("arn:exec:5", "States.Timeout");
    expect(await runRow(superseded.runId)).toMatchObject({ status: "superseded", error: null });
  });

  it("returns nothing for an unknown run", async () => {
    expect(await store.getRun("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });
});
