import { pullRequests, reviewRuns } from "@lgtmoose/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./database.js";
import type { RunRecord, RunStore } from "./ports.js";

/** `review_runs` and `pull_requests` with drizzle. */
export function drizzleRunStore(db: Db, now: () => Date = () => new Date()): RunStore {
  async function record(runId: string): Promise<RunRecord | undefined> {
    const [row] = await db
      .select({
        runId: reviewRuns.id,
        pullRequestId: reviewRuns.pullRequestId,
        summaryCommentId: pullRequests.summaryCommentId,
      })
      .from(reviewRuns)
      .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
      .where(eq(reviewRuns.id, runId));
    return row === undefined
      ? undefined
      : { ...row, summaryCommentId: row.summaryCommentId ?? undefined };
  }

  return {
    async startRun(input) {
      // A retried prepare step finds the run its first attempt recorded.
      const [existing] = await db
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(eq(reviewRuns.executionArn, input.executionArn));
      if (existing !== undefined) {
        const run = await record(existing.id);
        if (run !== undefined) return run;
      }
      const [pull] = await db
        .insert(pullRequests)
        .values({
          installationId: input.installationId,
          repo: input.repo,
          number: input.number,
          author: input.author,
          headSha: input.headSha,
          baseSha: input.baseSha,
        })
        .onConflictDoUpdate({
          target: [pullRequests.repo, pullRequests.number],
          set: {
            installationId: input.installationId,
            author: input.author,
            headSha: input.headSha,
            baseSha: input.baseSha,
            updatedAt: now(),
          },
        })
        .returning({
          id: pullRequests.id,
          lastReviewedSha: pullRequests.lastReviewedSha,
          summaryCommentId: pullRequests.summaryCommentId,
        });
      if (pull === undefined) throw new Error("The pull request wasn't recorded.");
      const [run] = await db
        .insert(reviewRuns)
        .values({
          pullRequestId: pull.id,
          headSha: input.headSha,
          // Every run reviews the whole PR until incremental reviews land.
          kind: pull.lastReviewedSha === null ? "first" : "full",
          status: "running",
          executionArn: input.executionArn,
          startedAt: now(),
        })
        .returning({ id: reviewRuns.id });
      if (run === undefined) throw new Error("The review run wasn't recorded.");
      return {
        runId: run.id,
        pullRequestId: pull.id,
        summaryCommentId: pull.summaryCommentId ?? undefined,
      };
    },
    getRun: record,
    async setFilesTotal(runId, filesTotal) {
      await db.update(reviewRuns).set({ filesTotal }).where(eq(reviewRuns.id, runId));
    },
    async succeedRun(runId, result) {
      const run = await record(runId);
      if (run === undefined) throw new Error(`No review run ${runId}.`);
      await db.transaction(async (tx) => {
        await tx
          .update(reviewRuns)
          .set({
            status: "succeeded",
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId));
        await tx
          .update(pullRequests)
          .set({
            lastReviewedSha: result.headSha,
            statusLabel: result.statusLabel ?? null,
            summaryCommentId: result.summaryCommentId ?? null,
            updatedAt: now(),
          })
          .where(eq(pullRequests.id, run.pullRequestId));
      });
    },
    async failRun(executionArn, error) {
      // A run that already finished (or was superseded) keeps its status.
      await db
        .update(reviewRuns)
        .set({ status: "failed", error, finishedAt: now() })
        .where(
          and(
            eq(reviewRuns.executionArn, executionArn),
            inArray(reviewRuns.status, ["queued", "running"]),
          ),
        );
    },
    async supersedeRun(runId) {
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(eq(reviewRuns.id, runId));
    },
    async supersedeExecutions(executionArns) {
      if (executionArns.length === 0) return;
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(
          and(
            inArray(reviewRuns.executionArn, [...executionArns]),
            inArray(reviewRuns.status, ["queued", "running"]),
          ),
        );
    },
  };
}
