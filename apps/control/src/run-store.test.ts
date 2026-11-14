import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Finding } from "@lgtmoose/core";
import { findingEvents, findings, pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
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
    await store.setPlan(run.runId, { filesTotal: 3, kind: "first", fromSha: undefined });
    await store.succeedRun(run.runId, {
      filesDone: 3,
      costUsd: 0.12345,
      reviewedSha: "a".repeat(40),
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
      reviewedSha: "c".repeat(40),
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
        reviewedSha: "a".repeat(40),
        statusLabel: undefined,
        summaryCommentId: undefined,
        review: undefined,
      });
    const first = await start("arn:exec:files:1", 20);
    const second = await start("arn:exec:files:2", 20);
    const file = {
      path: "src/a.ts",
      blobSha: "c".repeat(40),
      baseBlobSha: undefined,
      depth: "full" as const,
    };
    await store.recordFiles(first.runId, [file]);
    await store.recordFiles(first.runId, [file]);
    await store.recordFiles(second.runId, [file, { ...file, path: "src/b.ts" }]);
    const unposted = await start("arn:exec:files:3", 20);
    await store.recordFiles(unposted.runId, [{ ...file, path: "src/unposted.ts" }]);
    const other = await start("arn:exec:files:4", 21);
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
    const fix = await start("arn:exec:files:5", 20);
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
      reviewedSha: "a".repeat(40),
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

  it("keeps a finding's base-side name unless a new one is given, and takes its new lines", async () => {
    const run = await start("arn:exec:findings:5", 44);
    const save = (basePath?: string, lineText?: string) =>
      findingStore.saveFindings(run.pullRequestId, run.runId, sha("1"), [
        {
          finding: { ...finding("Based"), side: "LEFT" },
          fingerprint: "fp1:based",
          ...(basePath === undefined ? {} : { basePath }),
          ...(lineText === undefined ? {} : { lineText }),
        },
      ]);
    const stored = async () =>
      (await findingStore.trackedFindings(run.pullRequestId)).map((record) => [
        record.basePath,
        record.lineText,
      ]);
    await save("src/total.ts", "return sum;");
    expect(await stored()).toEqual([["src/total.ts", "return sum;"]]);
    // Raised again on lines it couldn't record: its old lines go with its old place.
    await save();
    expect(await stored()).toEqual([["src/total.ts", undefined]]);
    await save("src/sum.ts", "return total;");
    expect(await stored()).toEqual([["src/sum.ts", "return total;"]]);
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
