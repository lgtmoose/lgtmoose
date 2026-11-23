import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Finding } from "@lgtmoose/core";
import { findingEvents, findings, pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleFindingStore, drizzleRunStore } from "./aws.js";

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleRunStore(db);
const findingStore = drizzleFindingStore(db);

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
  it("counts succeeded automatic reviews since the count was reset", async () => {
    const automatic = await start("arn:exec:auto-1", 90);
    const requested = await start("arn:exec:auto-full", 90, "c".repeat(40));
    await db
      .update(reviewRuns)
      .set({
        status: "succeeded",
        kind: "incremental",
        startedAt: new Date("2026-01-02T00:00:00Z"),
      })
      .where(eq(reviewRuns.id, automatic.runId));
    await db
      .update(reviewRuns)
      .set({ status: "succeeded", kind: "full", startedAt: new Date("2026-01-03T00:00:00Z") })
      .where(eq(reviewRuns.id, requested.runId));
    const failed = await start("arn:exec:auto-failed", 90, "f".repeat(40));
    await db
      .update(reviewRuns)
      .set({ status: "failed", kind: "incremental", startedAt: new Date("2026-01-04T00:00:00Z") })
      .where(eq(reviewRuns.id, failed.runId));
    expect(await store.automaticReviews("Acme/Shop", 90)).toBe(1);
    await store.resetAutomaticReviews("Acme/Shop", 90);
    expect(await store.automaticReviews("acme/shop", 90)).toBe(0);
    const later = await start("arn:exec:auto-2", 90, "d".repeat(40));
    await db
      .update(reviewRuns)
      .set({ status: "succeeded", kind: "first", startedAt: new Date("2099-01-01T00:00:00Z") })
      .where(eq(reviewRuns.id, later.runId));
    expect(await store.automaticReviews("acme/shop", 90)).toBe(1);
  });

  it("does not count the run that fulfills a review someone asked for", async () => {
    const head = "e".repeat(40);
    await store.armRequestedReview("Acme/Shop", 91, head);
    expect(await store.requestedReviewHead("acme/shop", 91)).toBe(head);
    const followUp = await start("arn:exec:auto-asked", 91, head);
    const other = await start("arn:exec:auto-other", 91, "f".repeat(40));
    await db
      .update(reviewRuns)
      .set({ status: "succeeded", kind: "incremental" })
      .where(eq(reviewRuns.id, followUp.runId));
    await db
      .update(reviewRuns)
      .set({ status: "succeeded", kind: "incremental" })
      .where(eq(reviewRuns.id, other.runId));
    expect(await store.automaticReviews("acme/shop", 91)).toBe(2);
    await store.noteRequestedRun("acme/shop", 91, followUp.runId);
    expect(await store.requestedReviewHead("acme/shop", 91)).toBeUndefined();
    expect(await store.automaticReviews("acme/shop", 91)).toBe(1);
  });

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
    await store.setPlan(run.runId, { filesTotal: 3, kind: "first", fromSha: undefined });
    await store.succeedRun(run.runId, {
      filesDone: 3,
      costUsd: 0.12345,
      headSha: "a".repeat(40),
      statusLabel: "lgtmoose: changes requested",
      summaryCommentId: 77,
      review: { event: "REQUEST_CHANGES", id: 501 },
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
    expect(next).toMatchObject({
      pullRequestId: run.pullRequestId,
      summaryCommentId: 77,
      lastReviewedSha: "a".repeat(40),
      statusLabel: "lgtmoose: changes requested",
      lastReviewEvent: "REQUEST_CHANGES",
    });
    expect(await runRow(next.runId)).toMatchObject({ kind: "incremental" });
    await store.setPlan(next.runId, { filesTotal: 1, kind: "full", fromSha: undefined });
    expect(await runRow(next.runId)).toMatchObject({ kind: "full", fromSha: null, filesTotal: 1 });

    // A run that posted no review keeps the last review's event and ID, but records its head.
    await store.succeedRun(next.runId, {
      filesDone: 0,
      costUsd: undefined,
      headSha: "c".repeat(40),
      statusLabel: "lgtmoose: changes requested",
      summaryCommentId: 77,
      review: undefined,
    });
    expect(await store.getRun(next.runId)).toMatchObject({
      lastReviewedSha: "c".repeat(40),
      lastReviewEvent: "REQUEST_CHANGES",
      lastReviewId: 501,
    });
  });

  it("records reviewed files once and lists those of the PR's posted runs", async () => {
    const succeed = (runId: string) =>
      store.succeedRun(runId, {
        filesDone: 1,
        costUsd: undefined,
        headSha: "a".repeat(40),
        statusLabel: undefined,
        summaryCommentId: undefined,
        review: undefined,
      });
    const first = await start("arn:exec:files:1", 120);
    const second = await start("arn:exec:files:2", 120);
    const file = {
      path: "src/a.ts",
      blobSha: "c".repeat(40),
      baseBlobSha: undefined,
      depth: "full" as const,
    };
    await store.recordFiles(first.runId, [file]);
    await store.recordFiles(first.runId, [file]);
    await store.recordFiles(second.runId, [file, { ...file, path: "src/b.ts" }]);
    const unposted = await start("arn:exec:files:3", 120);
    await store.recordFiles(unposted.runId, [{ ...file, path: "src/unposted.ts" }]);
    const other = await start("arn:exec:files:4", 121);
    await store.recordFiles(other.runId, [{ ...file, path: "src/other.ts" }]);
    for (const run of [first, second, other]) await succeed(run.runId);

    const files = await store.reviewedFiles(first.pullRequestId);
    // Each with the head of the run that recorded it.
    expect(files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "src/a.ts", blobSha: "c".repeat(40), depth: "full", reviewedAt: "a".repeat(40) },
      { path: "src/b.ts", blobSha: "c".repeat(40), depth: "full", reviewedAt: "a".repeat(40) },
    ]);

    // Only each path's latest posted record counts: after a fix (blob d) and a revert, the old
    // blob c isn't done any more. Its depth comes along.
    const fix = await start("arn:exec:files:5", 120);
    await store.recordFiles(fix.runId, [{ ...file, blobSha: "d".repeat(40), depth: "mechanical" }]);
    await succeed(fix.runId);
    await db
      .update(reviewRuns)
      .set({ createdAt: new Date(Date.UTC(2030, 0, 1)) })
      .where(eq(reviewRuns.id, fix.runId));
    expect(
      (await store.reviewedFiles(first.pullRequestId)).find((row) => row.path === "src/a.ts"),
    ).toEqual({
      path: "src/a.ts",
      blobSha: "d".repeat(40),
      depth: "mechanical",
      reviewedAt: "a".repeat(40),
    });
  });

  it("lists the runs since the last posted one that didn't post, newest first", async () => {
    const old = await start("arn:exec:unposted:1", 30);
    await store.supersedeRun(old.runId);
    const posted = await start("arn:exec:unposted:2", 30);
    await store.succeedRun(posted.runId, {
      filesDone: 1,
      costUsd: undefined,
      headSha: "a".repeat(40),
      statusLabel: undefined,
      summaryCommentId: undefined,
      review: undefined,
    });
    const stopped = await start("arn:exec:unposted:3", 30);
    const failed = await start("arn:exec:unposted:4", 30);
    await store.failRun("arn:exec:unposted:4", "States.TaskFailed");
    const current = await start("arn:exec:unposted:5", 30);
    // Rows created in quick succession can share a timestamp: space them apart.
    for (const [i, run] of [old, posted, stopped, failed, current].entries()) {
      await db
        .update(reviewRuns)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })
        .where(eq(reviewRuns.id, run.runId));
    }

    expect(await store.unpostedRuns(current.pullRequestId, current.runId, 3)).toEqual([
      failed.runId,
      stopped.runId,
    ]);
    expect(await store.unpostedRuns(current.pullRequestId, current.runId, 1)).toEqual([
      failed.runId,
    ]);
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
    expect(await loaded(later.runId)).toMatchObject({ headSha: "c".repeat(40) });
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

  it("leaves the PR's recorded label alone when a run records none", async () => {
    const run = await start("arn:exec:29", 29, "a".repeat(40), new Date("2026-11-14T00:00:01Z"));
    await store.succeedRun(run.runId, posted("a".repeat(40), 16));
    const covered = await start(
      "arn:exec:30",
      29,
      "a".repeat(40),
      new Date("2026-11-14T00:00:02Z"),
    );
    await store.coverRun(covered.runId, {
      filesDone: 1,
      costUsd: undefined,
      pr: { headSha: "a".repeat(40), statusLabel: undefined, summaryCommentId: 16 },
    });
    expect(await prRow(run.pullRequestId)).toMatchObject({ statusLabel: "label a" });
    // Nor does a posted run whose decision set no label (it was skipped).
    const next = await start("arn:exec:31", 29, "b".repeat(40), new Date("2026-11-14T00:00:03Z"));
    await store.succeedRun(next.runId, { ...posted("b".repeat(40), 16), statusLabel: undefined });
    expect(await prRow(run.pullRequestId)).toMatchObject({
      lastReviewedSha: "b".repeat(40),
      statusLabel: "label a",
    });
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

describe("drizzleFindingStore", () => {
  const sha = (c: string) => c.repeat(40);
  const finding = (title: string): Finding => ({
    rule_category: "correctness",
    severity: "blocking",
    path: "src/a.ts",
    line: 4,
    side: "RIGHT",
    title,
    body: "Body.",
    evidence: "code",
  });

  it("records findings, reopens outdated ones raised again, and leaves declined ones", async () => {
    const run = await start("arn:exec:findings:1", 40);
    const open = async () =>
      (await findingStore.trackedFindings(run.pullRequestId)).filter(
        (record) => record.status === "open",
      );
    await findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
      { finding: finding("First"), fingerprint: "fp1:a" },
      { finding: finding("Second"), fingerprint: "fp1:b" },
    ]);
    const saved = await open();
    expect(saved.map((record) => [record.fingerprint, record.raisedAtSha, record.line])).toEqual([
      ["fp1:a", sha("1"), 4],
      ["fp1:b", sha("1"), 4],
    ]);

    const [first, second] = saved;
    await findingStore.markOutdated([first?.id ?? ""], sha("2"));
    await db
      .update(findings)
      .set({ status: "declined" })
      .where(eq(findings.id, second?.id ?? ""));
    expect(await open()).toEqual([]);
    // Outdated ones are still tracked; declined ones aren't.
    expect(await findingStore.trackedFindings(run.pullRequestId)).toMatchObject([
      { fingerprint: "fp1:a", status: "outdated" },
    ]);

    // Only the declined one: no row changes, and nothing to record an event for.
    await findingStore.saveFindings(run.pullRequestId, run.runId, sha("3"), [
      { finding: finding("Second"), fingerprint: "fp1:b" },
    ]);
    expect(await open()).toEqual([]);

    await findingStore.saveFindings(run.pullRequestId, run.runId, sha("3"), [
      { finding: { ...finding("First"), line: 9 }, fingerprint: "fp1:a" },
      { finding: finding("Second"), fingerprint: "fp1:b" },
    ]);
    expect(await open()).toMatchObject([{ fingerprint: "fp1:a", raisedAtSha: sha("3"), line: 9 }]);

    // Outdated, then reopened in place when its line is back; reopening an open one is a no-op.
    await findingStore.markOutdated([first?.id ?? ""], sha("4"));
    await findingStore.reopen([first?.id ?? "", second?.id ?? ""], sha("5"));
    await findingStore.reopen([first?.id ?? ""], sha("5"));
    expect(await open()).toMatchObject([{ fingerprint: "fp1:a" }]);
    const events = await db
      .select({ type: findingEvents.type })
      .from(findingEvents)
      .where(eq(findingEvents.findingId, first?.id ?? ""));
    expect(events.map((event) => event.type).toSorted()).toEqual([
      "outdated",
      "outdated",
      "raised",
      "raised",
      "raised",
    ]);
  });

  it("keeps the comment ID and never lowers severity when a finding is saved again", async () => {
    const run = await start("arn:exec:findings:3", 42);
    const save = (severity: Finding["severity"], githubCommentId?: number) =>
      findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
        {
          finding: { ...finding("Kept"), severity },
          fingerprint: "fp1:kept",
          ...(githubCommentId === undefined ? {} : { githubCommentId }),
        },
      ]);
    const stored = async () =>
      (await findingStore.trackedFindings(run.pullRequestId)).map((record) => [
        record.severity,
        record.githubCommentId,
      ]);
    await save("should_fix", 501);
    expect(await stored()).toEqual([["should_fix", 501]]);
    await save("nit");
    expect(await stored()).toEqual([["should_fix", 501]]);
    await save("blocking", 502);
    expect(await stored()).toEqual([["blocking", 502]]);

    // Reopened from outdated without an inline comment: the old comment is on code that's gone,
    // so it no longer stands for the finding.
    const [record] = await findingStore.trackedFindings(run.pullRequestId);
    await findingStore.markOutdated([record?.id ?? ""], sha("2"));
    await save("blocking");
    expect(await stored()).toEqual([["blocking", undefined]]);
    // Reopened with one: that one.
    await findingStore.markOutdated([record?.id ?? ""], sha("3"));
    await save("blocking", 503);
    expect(await stored()).toEqual([["blocking", 503]]);
  });

  describe("findings raised in shadow mode (NIC-1141)", () => {
    const number = 47;
    const run = (arn: string, shadow?: boolean) =>
      store.startRun({
        installationId: 5,
        repo: "acme/shop",
        number,
        author: "dev",
        headSha: sha("1"),
        baseSha: sha("b"),
        executionArn: arn,
        ...(shadow === undefined ? {} : { shadow }),
      });
    const save = (runId: string, pr: string, title: string, githubCommentId?: number) =>
      findingStore.saveFindings(pr, runId, sha("1"), [
        {
          finding: finding(title),
          fingerprint: `fp:${title}`,
          ...(githubCommentId === undefined ? {} : { githubCommentId }),
        },
      ]);
    const row = async (title: string) =>
      (
        await db
          .select()
          .from(findings)
          .where(eq(findings.fingerprint, `fp:${title}`))
      )[0];
    const answer = (findingId: string, at: Date) =>
      db.insert(findingEvents).values({
        findingId,
        type: "replied",
        actor: "human",
        actorLogin: "dev",
        sha: sha("2"),
        createdAt: at,
      });

    it("retires unposted, unanswered ones once per run, and leaves the rest", async () => {
      const shadowRun = await run("arn:exec:shadow:1", true);
      const pr = shadowRun.pullRequestId;
      await save(shadowRun.runId, pr, "Shadow");
      await save(shadowRun.runId, pr, "Shadow outdated");
      await save(shadowRun.runId, pr, "Shadow answered");
      // Answered, then raised again in shadow mode: the answer was about the earlier finding.
      await save(shadowRun.runId, pr, "Answered before");
      // Recorded by control code older than the run's column: a succeeded run with no review ID.
      const oldShadow = await run("arn:exec:shadow:old");
      await db
        .update(reviewRuns)
        .set({ status: "succeeded" })
        .where(eq(reviewRuns.id, oldShadow.runId));
      await save(oldShadow.runId, pr, "Old shadow");
      // Live: outside the diff (no comment), or with one deleted on GitHub since (ID kept).
      const liveRun = await run("arn:exec:shadow:live", false);
      await save(liveRun.runId, pr, "Live outside diff");
      await save(liveRun.runId, pr, "Live", 901);
      // An old live run: it posted a review.
      const oldLive = await run("arn:exec:shadow:old-live");
      await db
        .update(reviewRuns)
        .set({ status: "succeeded", reviewId: 77 })
        .where(eq(reviewRuns.id, oldLive.runId));
      await save(oldLive.runId, pr, "Old live outside diff");

      const id = async (title: string) => (await row(title))?.id ?? "";
      await findingStore.markOutdated([await id("Shadow outdated")], sha("2"));
      await answer(await id("Shadow answered"), new Date(Date.now() + 60_000));
      const before = await id("Answered before");
      await answer(before, new Date(Date.now() - 60_000));

      const unposted = async () =>
        (await findingStore.trackedFindings(pr))
          .filter((record) => record.unpostedShadow === true)
          .map((record) => record.title)
          .toSorted();
      expect(await unposted()).toEqual([
        "Answered before",
        "Old shadow",
        "Shadow",
        "Shadow outdated",
      ]);

      // A live run that retires them but writes no summary (covered, or overtaken): the next run
      // that does reports them.
      const covered = await run("arn:exec:shadow:covered", false);
      expect(await findingStore.retireShadowFindings?.(pr, covered.runId, sha("3"))).toBe(4);
      const live = await run("arn:exec:shadow:going-live", false);
      expect(await findingStore.retireShadowFindings?.(pr, live.runId, sha("3"))).toBe(4);
      // A retry of the same run says the same and retires nothing more.
      expect(await findingStore.retireShadowFindings?.(pr, live.runId, sha("3"))).toBe(4);
      // Once it has written the PR's summary, they're reported: the next run has none to tell.
      await db.update(reviewRuns).set({ wrotePr: true }).where(eq(reviewRuns.id, live.runId));
      const next = await run("arn:exec:shadow:next", false);
      expect(await findingStore.retireShadowFindings?.(pr, next.runId, sha("3"))).toBe(0);
      // The run's mode as its post ran it, set again from the prepare step's.
      await store.recordShadow?.(next.runId, true);
      expect((await runRow(next.runId))?.shadow).toBe(true);

      for (const title of ["Shadow", "Shadow outdated", "Answered before", "Old shadow"]) {
        expect((await row(title))?.status).toBe("shadow");
      }
      for (const title of [
        "Shadow answered",
        "Live outside diff",
        "Live",
        "Old live outside diff",
      ]) {
        expect((await row(title))?.status).toBe("open");
      }
      const events = await db
        .select({ type: findingEvents.type })
        .from(findingEvents)
        .where(eq(findingEvents.findingId, await id("Shadow")));
      expect(events.map((event) => event.type).toSorted()).toEqual(["raised", "shadow_retired"]);
      // The answered one is still tracked, and a recheck may close it.
      expect(await unposted()).toEqual([]);
      expect((await findingStore.trackedFindings(pr)).map((record) => record.title)).toContain(
        "Shadow answered",
      );
      // Retired isn't closed by a person: a review raising one again isn't dropped.
      expect(await findingStore.closedFindings(pr)).toEqual([]);

      // Raised again by a live run: open, with its comment, and no longer a shadow finding.
      await save(live.runId, pr, "Shadow", 902);
      expect(await row("Shadow")).toMatchObject({ status: "open", githubCommentId: 902 });
      expect(await unposted()).toEqual([]);
      // A retired one was never shown: raised again less severely, it takes the new severity.
      await findingStore.saveFindings(pr, live.runId, sha("3"), [
        {
          finding: { ...finding("Shadow outdated"), severity: "nit" },
          fingerprint: "fp:Shadow outdated",
          githubCommentId: 903,
        },
      ]);
      expect(await row("Shadow outdated")).toMatchObject({ status: "open", severity: "nit" });
    });
  });

  it("keeps a finding's base-side name, unless a new one is given", async () => {
    const run = await start("arn:exec:findings:5", 44);
    const save = (basePath?: string) =>
      findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
        {
          finding: { ...finding("Based"), side: "LEFT" },
          fingerprint: "fp1:based",
          ...(basePath === undefined ? {} : { basePath }),
        },
      ]);
    const basePaths = async () =>
      (await findingStore.trackedFindings(run.pullRequestId)).map((record) => record.basePath);
    await save("src/total.ts");
    expect(await basePaths()).toEqual(["src/total.ts"]);
    await save();
    expect(await basePaths()).toEqual(["src/total.ts"]);
    await save("src/sum.ts");
    expect(await basePaths()).toEqual(["src/sum.ts"]);
  });

  it("follows review threads: resolved by a person, and open again when unresolved", async () => {
    const run = await start("arn:exec:findings:4", 43);
    await findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
      { finding: finding("Inline"), fingerprint: "fp1:inline", githubCommentId: 601 },
      { finding: finding("Other"), fingerprint: "fp1:other", githubCommentId: 602 },
      { finding: finding("In the body"), fingerprint: "fp1:body" },
    ]);
    const tracked = async () =>
      (await findingStore.trackedFindings(run.pullRequestId))
        .map((record) => record.fingerprint)
        .toSorted();
    const inline = (await findingStore.trackedFindings(run.pullRequestId)).find(
      (record) => record.fingerprint === "fp1:inline",
    );

    // 602's comment was deleted: not in the threads, left alone. 999 isn't ours.
    expect(
      await findingStore.syncThreads(
        run.pullRequestId,
        [
          { resolved: true, firstCommentId: 601 },
          { resolved: true, firstCommentId: 999 },
          { resolved: true, firstCommentId: undefined },
        ],
        sha("2"),
      ),
    ).toEqual({ resolved: 1, unresolved: 0 });
    expect(await tracked()).toEqual(["fp1:body", "fp1:other"]);
    expect(await findingStore.closedFindings(run.pullRequestId)).toMatchObject([
      { fingerprint: "fp1:inline", githubCommentId: 601 },
    ]);
    // Again: nothing more to do.
    expect(
      await findingStore.syncThreads(
        run.pullRequestId,
        [{ resolved: true, firstCommentId: 601 }],
        sha("3"),
      ),
    ).toEqual({ resolved: 0, unresolved: 0 });

    expect(
      await findingStore.syncThreads(
        run.pullRequestId,
        [{ resolved: false, firstCommentId: 601 }],
        sha("4"),
      ),
    ).toEqual({ resolved: 0, unresolved: 1 });
    expect(await tracked()).toEqual(["fp1:body", "fp1:inline", "fp1:other"]);

    const events = await db
      .select({ type: findingEvents.type, actor: findingEvents.actor, sha: findingEvents.sha })
      .from(findingEvents)
      .where(eq(findingEvents.findingId, inline?.id ?? ""));
    expect(events.filter((event) => event.actor === "human")).toEqual([
      { type: "resolved", actor: "human", sha: sha("2") },
      { type: "unresolved", actor: "human", sha: sha("4") },
    ]);
  });

  it("escalates an open finding's severity upwards only, with an event", async () => {
    const run = await start("arn:exec:findings:2", 41);
    await findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
      { finding: { ...finding("Minor"), severity: "nit" }, fingerprint: "fp1:nit" },
    ]);
    const [saved] = await findingStore.trackedFindings(run.pullRequestId);
    const id = saved?.id ?? "";
    const stored = async () =>
      (await findingStore.trackedFindings(run.pullRequestId)).map((record) => record.severity);

    await findingStore.escalate([{ id, severity: "should_fix" }], sha("2"));
    expect(await stored()).toEqual(["should_fix"]);
    // Never downwards, and not to the level it has.
    await findingStore.escalate([{ id, severity: "nit" }], sha("3"));
    await findingStore.escalate([{ id, severity: "should_fix" }], sha("4"));
    expect(await stored()).toEqual(["should_fix"]);
    // Only while open.
    await findingStore.markOutdated([id], sha("5"));
    await findingStore.escalate([{ id, severity: "blocking" }], sha("6"));
    expect(await stored()).toEqual(["should_fix"]);

    const events = await db
      .select({ type: findingEvents.type, sha: findingEvents.sha })
      .from(findingEvents)
      .where(eq(findingEvents.findingId, id));
    expect(events.filter((event) => event.type === "escalated")).toEqual([
      { type: "escalated", sha: sha("2") },
    ]);
  });
});
