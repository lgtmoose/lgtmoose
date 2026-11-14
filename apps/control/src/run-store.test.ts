import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq, sql } from "drizzle-orm";
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

function start(executionArn: string, number = 1, headSha = "a".repeat(40), eventAt?: Date) {
  return store.startRun({
    ...(eventAt === undefined ? {} : { eventAt }),
    installationId: 5,
    repo: "acme/shop",
    number,
    author: "dev",
    headSha,
    baseSha: "b".repeat(40),
    executionArn,
  });
}

async function loaded(runId: string) {
  const run = await store.getRun(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  return run;
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

  const posted = (sha: string, comment: number) => ({
    filesDone: 1,
    costUsd: undefined,
    headSha: sha,
    statusLabel: `label ${sha.slice(0, 1)}`,
    summaryCommentId: comment,
  });
  const prRow = async (id: string) =>
    (await db.select().from(pullRequests).where(eq(pullRequests.id, id)))[0];

  it("records a run that posted even if it was superseded while posting", async () => {
    const run = await start("arn:exec:9", 9);
    await store.supersedeRun(run.runId);
    await store.succeedRun(run.runId, posted("a".repeat(40), 5));
    expect(await runRow(run.runId)).toMatchObject({ status: "succeeded" });
    expect(await prRow(run.pullRequestId)).toMatchObject({
      lastReviewedSha: "a".repeat(40),
      summaryCommentId: 5,
    });
  });

  it("leaves the PR to a newer run that already posted", async () => {
    const older = await start("arn:exec:10", 10);
    const newer = await start("arn:exec:11", 10);
    expect(await store.newerRunPosted(await loaded(older.runId))).toBe(false);
    await store.succeedRun(newer.runId, posted("b".repeat(40), 7));
    // The older run can tell before it writes the PR's summary or label.
    expect(await store.newerRunPosted(await loaded(older.runId))).toBe(true);
    expect(await store.newerRunPosted(await loaded(newer.runId))).toBe(false);
    await store.succeedRun(older.runId, posted("a".repeat(40), 6));
    expect(await runRow(older.runId)).toMatchObject({ status: "succeeded" });
    expect(await prRow(newer.pullRequestId)).toMatchObject({
      lastReviewedSha: "b".repeat(40),
      statusLabel: "label b",
      summaryCommentId: 7,
    });
    // A newer run posting after an older one does take the PR over.
    const newest = await start("arn:exec:12", 10);
    await store.succeedRun(newest.runId, posted("c".repeat(40), 7));
    expect(await prRow(newer.pullRequestId)).toMatchObject({ lastReviewedSha: "c".repeat(40) });
  });

  it("marks a covered run covered, without touching its PR", async () => {
    const run = await start("arn:exec:15", 15);
    await store.coverRun(run.runId, { filesDone: 2, costUsd: 0.5 });
    expect(await runRow(run.runId)).toMatchObject({
      status: "covered",
      filesDone: 2,
      wrotePr: false,
    });
    expect(await prRow(run.pullRequestId)).toMatchObject({
      lastReviewedSha: null,
      statusLabel: null,
      summaryCommentId: null,
    });
  });

  it("lets the covering run finish when a newer run was covered by its review", async () => {
    // The older run posted its review, then failed on its check run; a newer run at the same
    // head found the review and was covered. The older run's retry must still finish.
    const older = await start("arn:exec:16", 16);
    const newer = await start("arn:exec:17", 16);
    await store.coverRun(newer.runId, { filesDone: 1, costUsd: undefined });
    expect(await store.newerRunPosted(await loaded(older.runId))).toBe(false);
    await store.succeedRun(older.runId, posted("a".repeat(40), 8));
    expect(await prRow(older.pullRequestId)).toMatchObject({ summaryCommentId: 8 });
  });

  it("orders a PR's runs by their event time, not by when their rows were made", async () => {
    // The later push's run was made first (its prepare was quicker).
    const later = await start("arn:exec:18", 18, "c".repeat(40), new Date("2026-11-14T00:00:02Z"));
    const earlier = await start(
      "arn:exec:19",
      18,
      "a".repeat(40),
      new Date("2026-11-14T00:00:01Z"),
    );
    await store.succeedRun(later.runId, posted("c".repeat(40), 9));
    // The earlier event's run defers to the later one, though its row is newer.
    expect(await store.newerRunPosted(await loaded(earlier.runId))).toBe(true);
    expect(await store.newerRunPosted(await loaded(later.runId))).toBe(false);
    await store.succeedRun(earlier.runId, posted("a".repeat(40), 9));
    expect(await prRow(later.pullRequestId)).toMatchObject({ lastReviewedSha: "c".repeat(40) });
    expect(await loaded(later.runId)).toMatchObject({
      headSha: "c".repeat(40),
      lastReviewedSha: "c".repeat(40),
    });
  });

  it("records a covered run's PR outputs on the PR, unless a newer run posted", async () => {
    const run = await start("arn:exec:21", 21, "d".repeat(40), new Date("2026-11-14T00:00:05Z"));
    await store.coverRun(run.runId, {
      filesDone: 1,
      costUsd: undefined,
      pr: { headSha: "d".repeat(40), statusLabel: "label d", summaryCommentId: 12 },
    });
    expect(await runRow(run.runId)).toMatchObject({ status: "covered" });
    expect(await prRow(run.pullRequestId)).toMatchObject({
      lastReviewedSha: "d".repeat(40),
      statusLabel: "label d",
      summaryCommentId: 12,
    });
    // A run for a later event has posted: a covered run's outputs don't overwrite its record.
    const newer = await start("arn:exec:22", 21, "e".repeat(40), new Date("2026-11-14T00:00:09Z"));
    await store.succeedRun(newer.runId, posted("e".repeat(40), 13));
    const old = await start("arn:exec:23", 21, "d".repeat(40), new Date("2026-11-14T00:00:06Z"));
    await store.coverRun(old.runId, {
      filesDone: 1,
      costUsd: undefined,
      pr: { headSha: "d".repeat(40), statusLabel: "label d", summaryCommentId: 12 },
    });
    expect(await prRow(run.pullRequestId)).toMatchObject({ lastReviewedSha: "e".repeat(40) });
  });

  it("leaves the PR to a newer covered run that caught it up", async () => {
    // Heads go A → B → A: the run at A's second event is covered by A's review and catches the
    // PR up to A. The run at B, older by event time, finishes later and must leave the PR be.
    const atB = await start("arn:exec:24", 24, "b".repeat(40), new Date("2026-11-14T00:00:02Z"));
    const backAtA = await start(
      "arn:exec:25",
      24,
      "a".repeat(40),
      new Date("2026-11-14T00:00:03Z"),
    );
    await store.coverRun(backAtA.runId, {
      filesDone: 1,
      costUsd: undefined,
      pr: { headSha: "a".repeat(40), statusLabel: "label a", summaryCommentId: 14 },
    });
    expect(await runRow(backAtA.runId)).toMatchObject({ status: "covered", wrotePr: true });
    // The older run sees it before it writes the summary or label, and its record defers too.
    expect(await store.newerRunPosted(await loaded(atB.runId))).toBe(true);
    await store.succeedRun(atB.runId, posted("b".repeat(40), 14));
    expect(await prRow(atB.pullRequestId)).toMatchObject({
      lastReviewedSha: "a".repeat(40),
      statusLabel: "label a",
    });
    // The same goes for an older covered run.
    const coveredAtB = await start(
      "arn:exec:26",
      24,
      "b".repeat(40),
      new Date("2026-11-14T00:00:02.5Z"),
    );
    await store.coverRun(coveredAtB.runId, {
      filesDone: 1,
      costUsd: undefined,
      pr: { headSha: "b".repeat(40), statusLabel: "label b", summaryCommentId: 14 },
    });
    expect(await prRow(atB.pullRequestId)).toMatchObject({ lastReviewedSha: "a".repeat(40) });
    // A retry of the newer run that records without `pr` doesn't undo what it wrote.
    await store.coverRun(backAtA.runId, { filesDone: 1, costUsd: undefined });
    expect(await runRow(backAtA.runId)).toMatchObject({ wrotePr: true });
    expect(await store.newerRunPosted(await loaded(atB.runId))).toBe(true);
  });

  it("never counts a run as newer than itself, whatever its row time's precision", async () => {
    // No event time: the run's order is its row time, which Postgres keeps to the microsecond
    // and a Date read back only to the millisecond.
    const run = await start("arn:exec:27", 27);
    await db
      .update(reviewRuns)
      .set({ createdAt: sql`'2026-11-14T00:00:00.123456Z'::timestamptz` })
      .where(eq(reviewRuns.id, run.runId));
    await store.succeedRun(run.runId, posted("a".repeat(40), 15));
    expect(await prRow(run.pullRequestId)).toMatchObject({ lastReviewedSha: "a".repeat(40) });
    expect(await store.newerRunPosted(await loaded(run.runId))).toBe(false);
    // A later run in the same millisecond, though, is newer.
    const later = await start("arn:exec:28", 27);
    await db
      .update(reviewRuns)
      .set({ createdAt: sql`'2026-11-14T00:00:00.123789Z'::timestamptz` })
      .where(eq(reviewRuns.id, later.runId));
    await store.succeedRun(later.runId, posted("b".repeat(40), 15));
    expect(await store.newerRunPosted(await loaded(run.runId))).toBe(true);
  });

  it("supersedes only a queued or running run", async () => {
    const failed = await start("arn:exec:13", 13);
    await store.failRun("arn:exec:13", "States.TaskFailed");
    await store.supersedeRun(failed.runId);
    expect(await runRow(failed.runId)).toMatchObject({ status: "failed" });
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
