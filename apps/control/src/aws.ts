import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { SEVERITIES, severityRank, type ReviewEvent } from "@lgtmoose/core";
import {
  filesReviewed,
  findingEvents,
  findings,
  postgresSpend,
  pullRequestDispatches,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { budgetsSchema, type Budgets } from "@lgtmoose/config";
import { cloneAtSha, githubCloneUrl } from "@lgtmoose/git";
import { githubPullReader } from "@lgtmoose/pipeline";
import { graphQlThreadReader, resolveReviewThread } from "./threads.js";
import {
  GitHubClient,
  GitHubLabelClient,
  GitHubPoster,
  ShadowPoster,
  installationTokenProvider,
  appJwt,
  repoPath,
} from "@lgtmoose/poster";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  max,
  ne,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import pg from "pg";
import { z } from "zod";
import { drizzleLearningStore, proposeLearning } from "@lgtmoose/learnings";
import { drizzleReplyStore } from "./replies-aws.js";
import { BOOTSTRAP_DEFAULTS } from "./bootstrap.js";
import { githubBootstrap } from "./bootstrap-github.js";
import { drizzleBootstrapStore } from "./bootstrap-store.js";
import { databaseTls } from "./database.js";
import { unpostedShadow } from "./shadow-findings.js";
import type { ControlEnv, EmbeddingsSettings, TicketSettings } from "./env.js";
import { ticketSourceFor } from "./tickets.js";
import { embedderFor, learningsRetriever } from "./learnings.js";
import type { ControlDeps, FindingStore, RunRecord, RunStore, TaskTokens } from "./ports.js";
import { collaboratorPermission, orgRole } from "./github-access.js";
import { outcomeLearner } from "./outcome-learning-aws.js";
import { s3ArtifactStore } from "./s3-store.js";
import { drizzleChecksWaits } from "./dispatch-aws.js";

export { s3ArtifactStore };

/** Longest a GitHub request may take: well under the post step's 5-minute heartbeat timeout. */
export const GITHUB_TIMEOUT_MS = 60_000;

export function sfnTaskTokens(client: SFNClient): TaskTokens {
  return {
    async succeed(token, output) {
      await client.send(
        new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(output) }),
      );
    },
    async fail(token, error, cause) {
      await client.send(new SendTaskFailureCommand({ taskToken: token, error, cause }));
    },
  };
}

async function readSecret(client: SecretsManagerClient, secretId: string): Promise<unknown> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) throw new Error(`Secret ${secretId} has no string value.`);
  try {
    return JSON.parse(SecretString) as unknown;
  } catch {
    // The value is a credential: never echo it.
    throw new Error(`Secret ${secretId} isn't JSON.`);
  }
}

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

const databaseSecretSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
});

function parseSecret<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  // Only the field paths: the issues could quote the values.
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`The ${what} secret is missing fields or has the wrong types: ${fields}.`);
  }
  return parsed.data;
}

/** Any drizzle Postgres database: node-postgres in the task, PGlite in tests. */
type Db = PgDatabase<PgQueryResultHKT>;

const REVIEW_EVENTS: readonly ReviewEvent[] = ["APPROVE", "COMMENT", "REQUEST_CHANGES"];

/** `review_runs` again, for the run a query compares the others with. */
const self = alias(reviewRuns, "self");
/** A run's place among its PR's runs: its event time, else when its row was made. */
const orderOf = (runs: typeof reviewRuns | typeof self) =>
  sql<Date>`coalesce(${runs.eventAt}, ${runs.createdAt})`;
const runOrder = orderOf(reviewRuns);

async function newerRunPosted(
  db: Pick<Db, "select">,
  run: { runId: string; pullRequestId: string },
): Promise<boolean> {
  // Another run that wrote PR-level state: it succeeded, or it was covered and wrote the PR's
  // outputs. A covered run that wrote nothing doesn't count: it never stands in for the run
  // that posted.
  const [newer] = await db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.pullRequestId, run.pullRequestId),
        ne(reviewRuns.id, run.runId),
        eq(reviewRuns.wrotePr, true),
        // Against the run's own row, at Postgres's precision: its order read back into a Date
        // (or a driver's string) can be coarser than the column.
        gt(
          runOrder,
          sql`(${db
            .select({ order: orderOf(self) })
            .from(self)
            .where(eq(self.id, run.runId))})`,
        ),
      ),
    )
    .limit(1);
  return newer !== undefined;
}

/**
 * Records a posted run's outputs on its PR, unless a newer run of the PR has posted. The PR's
 * row is locked first, so two runs finishing at once take turns, and the newer-run check sees
 * the other's committed status (each statement reads afresh under READ COMMITTED).
 */
async function recordOnPr(
  tx: Pick<Db, "select" | "update">,
  run: { runId: string; pullRequestId: string },
  pr: {
    headSha: string;
    /** The PR's label; undefined leaves the recorded one as it is. */
    statusLabel: string | undefined;
    summaryCommentId: number | undefined;
    /** The review the run posted; undefined leaves the PR's last review as it is. */
    review?: { event: ReviewEvent; id: number | undefined } | undefined;
  },
  now: () => Date,
): Promise<void> {
  await tx
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.id, run.pullRequestId))
    .for("update");
  if (await newerRunPosted(tx, run)) return;
  await tx
    .update(pullRequests)
    .set({
      lastReviewedSha: pr.headSha,
      ...(pr.review === undefined
        ? {}
        : { lastReviewEvent: pr.review.event, lastReviewId: pr.review.id ?? null }),
      ...(pr.statusLabel === undefined ? {} : { statusLabel: pr.statusLabel }),
      summaryCommentId: pr.summaryCommentId ?? null,
      updatedAt: now(),
    })
    .where(eq(pullRequests.id, run.pullRequestId));
}

/** `review_runs` and `pull_requests` with drizzle. */
export function drizzleRunStore(db: Db, now: () => Date = () => new Date()): RunStore {
  async function record(runId: string): Promise<RunRecord | undefined> {
    const [row] = await db
      .select({
        runId: reviewRuns.id,
        pullRequestId: reviewRuns.pullRequestId,
        summaryCommentId: pullRequests.summaryCommentId,
        lastReviewedSha: pullRequests.lastReviewedSha,
        statusLabel: pullRequests.statusLabel,
        lastReviewEvent: pullRequests.lastReviewEvent,
        lastReviewId: pullRequests.lastReviewId,
        headSha: reviewRuns.headSha,
        executionArn: reviewRuns.executionArn,
      })
      .from(reviewRuns)
      .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
      .where(eq(reviewRuns.id, runId));
    return row === undefined
      ? undefined
      : {
          runId: row.runId,
          pullRequestId: row.pullRequestId,
          summaryCommentId: row.summaryCommentId ?? undefined,
          lastReviewedSha: row.lastReviewedSha ?? undefined,
          statusLabel: row.statusLabel ?? undefined,
          lastReviewEvent: REVIEW_EVENTS.find((event) => event === row.lastReviewEvent),
          lastReviewId: row.lastReviewId ?? undefined,
          headSha: row.headSha,
          executionArn: row.executionArn ?? undefined,
        };
  }

  const writeReviewCount = (
    repo: string,
    number: number,
    values: {
      reviewCountResetAt: Date;
      reviewRequestHead: string | null;
      excludedAutomaticRunId: string | null;
    },
  ) =>
    db
      .insert(pullRequestDispatches)
      .values({ repo: repo.toLowerCase(), number, lastEventAt: new Date(0), ...values })
      .onConflictDoUpdate({
        target: [pullRequestDispatches.repo, pullRequestDispatches.number],
        set: { ...values, updatedAt: now() },
      });

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
        .returning({ id: pullRequests.id, lastReviewedSha: pullRequests.lastReviewedSha });
      if (pull === undefined) throw new Error("The pull request wasn't recorded.");
      const [run] = await db
        .insert(reviewRuns)
        .values({
          pullRequestId: pull.id,
          headSha: input.headSha,
          // Until the prepare step has diffed the PR (see `setPlan`).
          kind: pull.lastReviewedSha === null ? "first" : "incremental",
          status: "running",
          executionArn: input.executionArn,
          eventAt: input.eventAt ?? null,
          ...(input.shadow === undefined ? {} : { shadow: input.shadow }),
          startedAt: now(),
        })
        .returning({ id: reviewRuns.id });
      const recorded = run === undefined ? undefined : await record(run.id);
      if (recorded === undefined) throw new Error("The review run wasn't recorded.");
      return recorded;
    },
    getRun: record,
    async setPlan(runId, plan) {
      await db
        .update(reviewRuns)
        .set({ filesTotal: plan.filesTotal, kind: plan.kind, fromSha: plan.fromSha ?? null })
        .where(eq(reviewRuns.id, runId));
    },
    async reviewedFiles(pullRequestId) {
      // The latest posted run's record of each path.
      const rows = await db
        .selectDistinctOn([filesReviewed.path], {
          path: filesReviewed.path,
          blobSha: filesReviewed.blobSha,
          baseBlobSha: filesReviewed.baseBlobSha,
          depth: filesReviewed.depth,
          reviewedAt: reviewRuns.headSha,
        })
        .from(filesReviewed)
        .innerJoin(reviewRuns, eq(filesReviewed.runId, reviewRuns.id))
        .where(and(eq(reviewRuns.pullRequestId, pullRequestId), eq(reviewRuns.status, "succeeded")))
        .orderBy(filesReviewed.path, desc(reviewRuns.createdAt), desc(filesReviewed.createdAt));
      // Runs never record "skipped"; the enum has it for files the planner left out.
      return rows.flatMap((row) =>
        row.depth === "skipped"
          ? []
          : [{ ...row, baseBlobSha: row.baseBlobSha ?? undefined, depth: row.depth }],
      );
    },
    async recordFiles(runId, files) {
      for (let i = 0; i < files.length; i += INSERT_CHUNK) {
        await db
          .insert(filesReviewed)
          .values(
            files
              .slice(i, i + INSERT_CHUNK)
              .map((file) => ({ runId, ...file, baseBlobSha: file.baseBlobSha ?? null })),
          )
          .onConflictDoNothing();
      }
    },
    async unpostedRuns(pullRequestId, exceptRunId, limit) {
      const [posted] = await db
        .select({ at: max(reviewRuns.createdAt) })
        .from(reviewRuns)
        .where(
          and(eq(reviewRuns.pullRequestId, pullRequestId), eq(reviewRuns.status, "succeeded")),
        );
      const since = posted?.at ?? undefined;
      const rows = await db
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(
          and(
            eq(reviewRuns.pullRequestId, pullRequestId),
            ne(reviewRuns.id, exceptRunId),
            ne(reviewRuns.status, "succeeded"),
            ...(since === undefined ? [] : [gt(reviewRuns.createdAt, since)]),
          ),
        )
        .orderBy(desc(reviewRuns.createdAt))
        .limit(limit);
      return rows.map((row) => row.id);
    },
    async succeedRun(runId, result) {
      await db.transaction(async (tx) => {
        // It posted, so it succeeded, even if it was superseded or failed while posting.
        const [run] = await tx
          .update(reviewRuns)
          .set({
            status: "succeeded",
            wrotePr: true,
            // What it set on the PR, for the reconciler to restore (see the columns).
            ...(result.statusLabel === undefined ? {} : { statusLabel: result.statusLabel }),
            ...(result.review === undefined
              ? {}
              : { reviewEvent: result.review.event, reviewId: result.review.id ?? null }),
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId))
          .returning({ runId: reviewRuns.id, pullRequestId: reviewRuns.pullRequestId });
        if (run === undefined) throw new Error(`No review run ${runId}.`);
        // The PR's record is the newest posted run's: an older run that finished posting later
        // (stopped mid-post, say) leaves it to the newer one.
        await recordOnPr(tx, run, result, now);
      });
    },
    async coverRun(runId, result) {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .update(reviewRuns)
          .set({
            status: "covered",
            // Once set, kept: a later call without `pr` (a retry) doesn't undo what was written.
            ...(result.pr === undefined ? {} : { wrotePr: true }),
            ...(result.pr?.statusLabel === undefined ? {} : { statusLabel: result.pr.statusLabel }),
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId))
          .returning({ runId: reviewRuns.id, pullRequestId: reviewRuns.pullRequestId });
        if (run === undefined) throw new Error(`No review run ${runId}.`);
        if (result.pr !== undefined) await recordOnPr(tx, run, result.pr, now);
      });
    },
    async newerRunPosted(run) {
      return newerRunPosted(db, run);
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
      // A run that already finished (or failed) keeps its status.
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(and(eq(reviewRuns.id, runId), inArray(reviewRuns.status, ["queued", "running"])));
    },
    async automaticReviews(repo, number) {
      const [dispatch] = await db
        .select({
          resetAt: pullRequestDispatches.reviewCountResetAt,
          excludedRunId: pullRequestDispatches.excludedAutomaticRunId,
        })
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, repo.toLowerCase()),
            eq(pullRequestDispatches.number, number),
          ),
        );
      const [row] = await db
        .select({ reviews: count() })
        .from(reviewRuns)
        .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
        .where(
          and(
            sql`lower(${pullRequests.repo}) = ${repo.toLowerCase()}`,
            eq(pullRequests.number, number),
            eq(reviewRuns.status, "succeeded"),
            inArray(reviewRuns.kind, ["first", "incremental"]),
            isNull(reviewRuns.spendCap),
            ...(dispatch?.resetAt == null ? [] : [gt(reviewRuns.startedAt, dispatch.resetAt)]),
            ...(dispatch?.excludedRunId == null ? [] : [ne(reviewRuns.id, dispatch.excludedRunId)]),
          ),
        );
      return row?.reviews ?? 0;
    },
    async resetAutomaticReviews(repo, number) {
      await writeReviewCount(repo, number, {
        reviewCountResetAt: now(),
        reviewRequestHead: null,
        excludedAutomaticRunId: null,
      });
    },
    async armRequestedReview(repo, number, headSha) {
      await writeReviewCount(repo, number, {
        reviewCountResetAt: now(),
        reviewRequestHead: headSha,
        excludedAutomaticRunId: null,
      });
    },
    async requestedReviewHead(repo, number) {
      const [row] = await db
        .select({ head: pullRequestDispatches.reviewRequestHead })
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, repo.toLowerCase()),
            eq(pullRequestDispatches.number, number),
          ),
        );
      return row?.head ?? undefined;
    },
    async forgetRequestedReview(repo, number) {
      await db
        .update(pullRequestDispatches)
        .set({ reviewRequestHead: null, updatedAt: now() })
        .where(
          and(
            eq(pullRequestDispatches.repo, repo.toLowerCase()),
            eq(pullRequestDispatches.number, number),
          ),
        );
    },
    async noteRequestedRun(repo, number, runId) {
      await db
        .update(pullRequestDispatches)
        .set({ excludedAutomaticRunId: runId, reviewRequestHead: null, updatedAt: now() })
        .where(
          and(
            eq(pullRequestDispatches.repo, repo.toLowerCase()),
            eq(pullRequestDispatches.number, number),
          ),
        );
    },
  };
}

/** Rows per insert, to stay well under Postgres's limit on bound parameters. */
const INSERT_CHUNK = 500;

/** Our own findings in `findings`, with a `finding_events` row for each change. */
export function drizzleFindingStore(db: Db, now: () => Date = () => new Date()): FindingStore {
  return {
    async closedFindings(pullRequestId) {
      const rows = await db
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.pullRequestId, pullRequestId),
            // A dispute the judge upheld is closed like a declined finding: raised again, dropped.
            inArray(findings.status, ["resolved_by_human", "declined", "disputed"]),
            eq(findings.source, "self"),
          ),
        )
        .orderBy(asc(findings.createdAt));
      return rows.flatMap((row) =>
        row.path === null || row.line === null || row.side === null
          ? []
          : [
              {
                id: row.id,
                fingerprint: row.fingerprint,
                ruleCategory: row.ruleCategory,
                severity: row.severity,
                path: row.path,
                line: row.line,
                startLine: row.startLine ?? undefined,
                side: row.side,
                title: row.title,
                body: row.body,
                raisedAtSha: row.raisedAtSha,
                githubCommentId: row.githubCommentId ?? undefined,
                basePath: row.basePath ?? undefined,
              },
            ],
      );
    },
    async trackedFindings(pullRequestId) {
      const rows = await db
        .select({ ...getTableColumns(findings), unpostedShadow: unpostedShadow() })
        .from(findings)
        .where(
          and(
            eq(findings.pullRequestId, pullRequestId),
            inArray(findings.status, ["open", "outdated"]),
            eq(findings.source, "self"),
          ),
        )
        .orderBy(asc(findings.createdAt));
      return rows.flatMap((row) =>
        row.path === null ||
        row.line === null ||
        row.side === null ||
        (row.status !== "open" && row.status !== "outdated")
          ? []
          : [
              {
                id: row.id,
                fingerprint: row.fingerprint,
                ruleCategory: row.ruleCategory,
                severity: row.severity,
                path: row.path,
                line: row.line,
                startLine: row.startLine ?? undefined,
                side: row.side,
                title: row.title,
                body: row.body,
                raisedAtSha: row.raisedAtSha,
                status: row.status,
                githubCommentId: row.githubCommentId ?? undefined,
                basePath: row.basePath ?? undefined,
                ...(row.unpostedShadow === true ? { unpostedShadow: true } : {}),
              },
            ],
      );
    },
    async saveFindings(pullRequestId, runId, headSha, posted) {
      if (posted.length === 0) return;
      await db.transaction(async (tx) => {
        for (let i = 0; i < posted.length; i += INSERT_CHUNK) {
          const rows = await tx
            .insert(findings)
            .values(
              posted
                .slice(i, i + INSERT_CHUNK)
                .map(({ finding, fingerprint, githubCommentId, basePath, learningIds }) => ({
                  pullRequestId,
                  runId,
                  fingerprint,
                  ruleCategory: finding.rule_category,
                  severity: finding.severity,
                  path: finding.path,
                  line: finding.line,
                  startLine: finding.start_line ?? null,
                  side: finding.side,
                  title: finding.title,
                  body: finding.body,
                  raisedAtSha: headSha,
                  githubCommentId: githubCommentId ?? null,
                  basePath: basePath ?? null,
                  learningIds:
                    learningIds === undefined || learningIds.length === 0 ? null : [...learningIds],
                })),
            )
            .onConflictDoUpdate({
              target: [findings.pullRequestId, findings.fingerprint],
              set: {
                runId,
                // Never lowered: the enum runs from blocking to nit, so the least is the most
                // severe.
                severity: sql`least(${findings.severity}, excluded.severity)`,
                // Reopened (from outdated): the new comment's ID, or none if it wasn't posted
                // inline, since the old comment is on code that's gone. Still open: kept unless
                // there's a new one.
                githubCommentId: sql`case when ${findings.status} = 'open' then coalesce(excluded.github_comment_id, ${findings.githubCommentId}) else excluded.github_comment_id end`,
                path: sql`excluded.path`,
                basePath: sql`coalesce(excluded.base_path, ${findings.basePath})`,
                // The batch that raised it this time: its learnings are the ones that count.
                learningIds: sql`excluded.learning_ids`,
                line: sql`excluded.line`,
                startLine: sql`excluded.start_line`,
                side: sql`excluded.side`,
                title: sql`excluded.title`,
                body: sql`excluded.body`,
                raisedAtSha: headSha,
                status: "open",
                updatedAt: now(),
              },
              // A finding someone declined, disputed or resolved stays that way. One retired from
              // shadow mode (NIC-1141) is raised again, now as a posted finding.
              setWhere: inArray(findings.status, ["open", "outdated", "fixed", "shadow"]),
            })
            .returning({ id: findings.id });
          // Every row may have hit a declined, disputed or resolved finding, left as it was.
          if (rows.length === 0) continue;
          await tx.insert(findingEvents).values(
            rows.map((row) => ({
              findingId: row.id,
              type: "raised" as const,
              actor: "self",
              sha: headSha,
            })),
          );
        }
      });
    },
    async retireShadowFindings(pullRequestId, runId, sha) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(findings)
          .set({ status: "shadow", updatedAt: now() })
          .where(and(eq(findings.pullRequestId, pullRequestId), unpostedShadow()))
          .returning({ id: findings.id });
        if (rows.length > 0) {
          await tx.insert(findingEvents).values(
            rows.map((row) => ({
              findingId: row.id,
              type: "shadow_retired" as const,
              actor: "self",
              sha,
            })),
          );
        }
        // This run's count, kept on it: a retry adds none and says the same; another run at the
        // same head keeps its own.
        const [run] = await tx
          .update(reviewRuns)
          .set({ shadowRetired: sql`coalesce(${reviewRuns.shadowRetired}, 0) + ${rows.length}` })
          .where(eq(reviewRuns.id, runId))
          .returning({ retired: reviewRuns.shadowRetired });
        return run?.retired ?? rows.length;
      });
    },
    markOutdated: (ids, sha) => moveStatus(ids, "open", "outdated", "outdated", sha),
    reopen: (ids, sha) => moveStatus(ids, "outdated", "open", "raised", sha),
    async syncThreads(pullRequestId, threads, sha) {
      const ids = (resolved: boolean) =>
        threads.flatMap((thread) =>
          thread.resolved === resolved && thread.firstCommentId !== undefined
            ? [thread.firstCommentId]
            : [],
        );
      const move = async (
        commentIds: number[],
        from: ("open" | "outdated" | "resolved_by_human")[],
        to: "open" | "resolved_by_human",
        type: "resolved" | "unresolved",
      ) => {
        if (commentIds.length === 0) return 0;
        return db.transaction(async (tx) => {
          const rows = await tx
            .update(findings)
            .set({ status: to, updatedAt: now() })
            .where(
              and(
                eq(findings.pullRequestId, pullRequestId),
                eq(findings.source, "self"),
                inArray(findings.status, from),
                inArray(findings.githubCommentId, commentIds),
              ),
            )
            .returning({ id: findings.id, commentId: findings.githubCommentId });
          if (rows.length > 0) {
            await tx.insert(findingEvents).values(
              rows.map((row) => ({
                findingId: row.id,
                type,
                actor: "human",
                sha,
                githubCommentId: row.commentId,
              })),
            );
          }
          return rows.length;
        });
      };
      const resolved = await move(ids(true), ["open", "outdated"], "resolved_by_human", "resolved");
      // Unresolved again: open again (the next follow decides whether its line still stands).
      // Only findings a resolved thread closed: a thread that's unresolved now may never have
      // been resolved, so findings closed after a reply are reopened only by the unresolve
      // webhook itself (`followThread`).
      const unresolved = await move(ids(false), ["resolved_by_human"], "open", "unresolved");
      return { resolved, unresolved };
    },
    async escalate(changes, sha) {
      if (changes.length === 0) return;
      await db.transaction(async (tx) => {
        for (const { id, severity } of changes) {
          // Upwards only: from a less severe level than the new one.
          const lower = SEVERITIES.slice(severityRank(severity) + 1);
          if (lower.length === 0) continue;
          const rows = await tx
            .update(findings)
            .set({ severity, updatedAt: now() })
            .where(
              and(
                eq(findings.id, id),
                eq(findings.status, "open"),
                inArray(findings.severity, lower),
              ),
            )
            .returning({ id: findings.id });
          if (rows.length === 0) continue;
          await tx
            .insert(findingEvents)
            .values({ findingId: id, type: "escalated", actor: "self", sha });
        }
      });
    },
    async closeForReply(findingId, status, reply, sha) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(findings)
          .set({ status, updatedAt: now() })
          .where(and(eq(findings.id, findingId), inArray(findings.status, ["open", "outdated"])))
          .returning({ id: findings.id });
        if (row === undefined) return false;
        await tx.insert(findingEvents).values({
          findingId,
          // A declined finding is the person's decision; fixed and disputed are ours, on the
          // judge's answer and the checks around it.
          type: status === "disputed" ? "dispute_answered" : status,
          actor: status === "declined" ? "human" : "self",
          actorLogin: reply.login,
          sha,
          githubCommentId: reply.commentId,
        });
        return true;
      });
    },
    async closeFixed(findingId, sha) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(findings)
          .set({ status: "fixed", updatedAt: now() })
          .where(and(eq(findings.id, findingId), inArray(findings.status, ["open", "outdated"])))
          .returning({ id: findings.id, commentId: findings.githubCommentId });
        if (row === undefined) {
          // Closed already: ours if it's `fixed` by our own event at this commit, the recheck's
          // (no person's login: a judged fix carries the replier's).
          const [ours] = await tx
            .select({ id: findingEvents.id })
            .from(findingEvents)
            .innerJoin(findings, eq(findings.id, findingEvents.findingId))
            .where(
              and(
                eq(findingEvents.findingId, findingId),
                eq(findings.status, "fixed"),
                eq(findingEvents.type, "fixed"),
                eq(findingEvents.actor, "self"),
                eq(findingEvents.sha, sha),
                isNull(findingEvents.actorLogin),
              ),
            )
            .limit(1);
          return ours === undefined ? "theirs" : "ours";
        }
        // Ours, on the recheck's verdict and the checks around it: no person's reply.
        await tx.insert(findingEvents).values({
          findingId,
          type: "fixed",
          actor: "self",
          sha,
          githubCommentId: row.commentId,
        });
        return "closed" as const;
      });
    },
    async recordReply(findingId, type, commentId, sha) {
      await db
        .insert(findingEvents)
        .values({ findingId, type, actor: "self", sha, githubCommentId: commentId });
    },
    async fixedCommentIds(pullRequestId) {
      const rows = await db
        .select({ id: findings.githubCommentId })
        .from(findings)
        .where(
          and(
            eq(findings.pullRequestId, pullRequestId),
            eq(findings.source, "self"),
            eq(findings.status, "fixed"),
          ),
        );
      return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
    },
    async disputesAnswered(ids) {
      if (ids.length === 0) return new Set();
      const rows = await db
        .selectDistinct({ id: findingEvents.findingId })
        .from(findingEvents)
        .where(
          and(
            inArray(findingEvents.findingId, [...ids]),
            eq(findingEvents.type, "dispute_answered"),
          ),
        );
      return new Set(rows.map((row) => row.id));
    },
  };

  /** Moves findings still in status `from` to `to`, with an event for each one that moved. */
  async function moveStatus(
    ids: readonly string[],
    from: "open" | "outdated",
    to: "open" | "outdated",
    event: "outdated" | "raised",
    sha: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
        const rows = await tx
          .update(findings)
          .set({ status: to, updatedAt: now() })
          .where(
            and(inArray(findings.id, ids.slice(i, i + INSERT_CHUNK)), eq(findings.status, from)),
          )
          .returning({ id: findings.id });
        if (rows.length === 0) continue;
        await tx
          .insert(findingEvents)
          .values(rows.map((row) => ({ findingId: row.id, type: event, actor: "self", sha })));
      }
    });
  }
}

/** Writes a gzip tarball of `dir`, hidden files included. */
export function tarArchive(dir: string, archive: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "-C", dir, "."], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
}

/**
 * The control task's real dependencies: S3, Step Functions, the database and GitHub as the App.
 * `close` ends the database pool.
 */
export async function awsControlDeps(
  env: ControlEnv,
  options: {
    shadow: boolean;
    embeddings?: EmbeddingsSettings;
    tickets?: TicketSettings;
    maxPendingLearnings?: number;
    bootstrapMaxCostUsd?: number;
    repeatThreshold?: number;
    /** The deploy config's `budgets` (`LGTMOOSE_BUDGETS`). Left out: no caps. */
    budgets?: Budgets;
    /** `commandAliases` (`LGTMOOSE_COMMAND_ALIASES`), for check runs that name the handle. */
    commandAliases?: readonly string[];
  },
): Promise<ControlDeps & { close(): Promise<void> }> {
  const secrets = new SecretsManagerClient({});
  const app = parseSecret(
    appSecretSchema,
    await readSecret(secrets, env.githubAppSecretArn),
    "GitHub App",
  );
  const database = parseSecret(
    databaseSecretSchema,
    await readSecret(secrets, env.databaseSecretArn),
    "database",
  );
  const pool = new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.username,
    password: database.password,
    database: env.databaseName,
    ssl: databaseTls(env.databaseCaFile),
    max: 2,
  });
  const store = s3ArtifactStore(new S3Client({}), env.artifactBucket);
  const db = drizzle({ client: pool });
  const bedrock = new BedrockRuntimeClient({});
  const embedder = await embedderFor(options.embeddings ?? { provider: "none" }, {
    bedrock: () => async (modelId, body) => {
      const reply = await bedrock.send(
        new InvokeModelCommand({
          modelId,
          body,
          contentType: "application/json",
          accept: "application/json",
        }),
      );
      return new TextDecoder().decode(reply.body);
    },
    // A plain-text key: never echoed.
    secret: async (arn) => {
      const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
      if (!SecretString) throw new Error(`Secret ${arn} has no string value.`);
      return SecretString;
    },
  });
  // Ticket coverage: the provider's key is read here, in the control task, on first use only.
  const tickets = ticketSourceFor(options.tickets ?? { provider: "none" }, async (arn) => {
    const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!SecretString) throw new Error(`Secret ${arn} has no string value.`);
    return SecretString;
  });
  // The App's slug, read once with the App's own JWT.
  return {
    ...controlDepsFor({
      app,
      db,
      store,
      tokens: sfnTaskTokens(new SFNClient({})),
      shadow: options.shadow,
      embedder,
      ...(tickets === undefined ? {} : { tickets }),
      ...(options.maxPendingLearnings === undefined
        ? {}
        : { maxPendingLearnings: options.maxPendingLearnings }),
      ...(options.bootstrapMaxCostUsd === undefined
        ? {}
        : { bootstrapMaxCostUsd: options.bootstrapMaxCostUsd }),
      ...(options.repeatThreshold === undefined
        ? {}
        : { repeatThreshold: options.repeatThreshold }),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.commandAliases === undefined ? {} : { commandAliases: options.commandAliases }),
    }),
    close: () => pool.end(),
  };
}

/** What `controlDepsFor` builds the control task's dependencies from. */
export interface ControlParts {
  app: { appId: number; privateKey: string };
  db: PgDatabase<PgQueryResultHKT>;
  store: ControlDeps["store"];
  tokens: TaskTokens;
  shadow: boolean;
  embedder: Parameters<typeof learningsRetriever>[1];
  tickets?: NonNullable<ControlDeps["tickets"]>;
  /** `learnings.maxPendingPerAuthor`; left out, the policy's default. */
  maxPendingLearnings?: number;
  /** `learnings.bootstrapMaxCostUsd`; left out, `BOOTSTRAP_DEFAULTS.maxCostUsd`. */
  bootstrapMaxCostUsd?: number;
  /** `learnings.repeatThreshold` (NIC-1081); left out, the default. */
  repeatThreshold?: number;
  /** The deploy config's `budgets` (NIC-1079); left out, no caps, but spend is still recorded. */
  budgets?: Budgets;
  /** `commandAliases` (NIC-1119): a check run names the first when the App's slug can't be read. */
  commandAliases?: readonly string[];
}

/**
 * The control task's dependencies from its parts: GitHub as the App, the database's stores and
 * the artifact store. AWS (`awsControlDeps`) and the docker compose runner build the parts
 * their own way and share the rest.
 */
export function controlDepsFor(parts: ControlParts): ControlDeps {
  const { app, db, store, embedder, tickets, maxPendingLearnings } = parts;
  const options = { shadow: parts.shadow };
  const learningStore = drizzleLearningStore(db);

  let slugOnce: Promise<string> | undefined;
  const slug = () => {
    slugOnce ??= new GitHubClient({
      token: async () => appJwt(app.appId, app.privateKey),
      timeoutMs: GITHUB_TIMEOUT_MS,
    })
      .request<{ slug?: unknown }>("GET", "/app")
      .then((reply) => {
        if (typeof reply.slug !== "string") throw new Error("GET /app returned no slug.");
        return reply.slug;
      });
    slugOnce.catch(() => {
      slugOnce = undefined;
    });
    return slugOnce;
  };

  return {
    store,
    runs: drizzleRunStore(db),
    findings: drizzleFindingStore(db),
    tokens: parts.tokens,
    ...(parts.commandAliases === undefined ? {} : { commandAliases: parts.commandAliases }),
    shadow: parts.shadow,
    async github(installationId) {
      const token = installationTokenProvider({
        appId: app.appId,
        privateKey: app.privateKey,
        installationId,
        timeoutMs: GITHUB_TIMEOUT_MS,
      });
      // Bounded well under the post step's heartbeat timeout: a hung write fails the attempt.
      const client = new GitHubClient({ token, timeoutMs: GITHUB_TIMEOUT_MS });
      return {
        reader: githubPullReader((path) => client.request("GET", path)),
        appId: app.appId,
        slug,
        permission: (target, login) => collaboratorPermission(client, target, login, log),
        // GitHub Apps can call GraphQL with the installation token.
        threads: graphQlThreadReader(
          (query, variables) => client.graphql(query, variables),
          (errors) => log("review threads partly unread", { errors }),
        ),
        conversation: options.shadow
          ? {
              async reply(target, commentId, body) {
                log("shadow: reply not posted", { pr: target.number, commentId, body });
              },
              async comment(target, body) {
                log("shadow: comment not posted", { pr: target.number, body });
              },
              async resolveThread(threadId) {
                log("shadow: review thread not resolved", { threadId });
              },
            }
          : {
              async reply(target, commentId, body) {
                await client.request(
                  "POST",
                  `${repoPath(target)}/pulls/${target.number}/comments/${commentId}/replies`,
                  { body },
                );
              },
              async comment(target, body) {
                await client.request(
                  "POST",
                  `${repoPath(target)}/issues/${target.number}/comments`,
                  { body },
                );
              },
              resolveThread: (threadId) =>
                resolveReviewThread(
                  (query, variables) => client.graphql(query, variables),
                  threadId,
                ),
            },
        token,
        poster: (runId, pull) =>
          options.shadow
            ? new ShadowPoster({
                store: { put: (key, body) => store.putText(key, body) },
                runId,
                log,
                labelReader: new GitHubLabelClient(client, pull),
              })
            : new GitHubPoster(client, {
                appId: app.appId,
                // Its bot is `<slug>[bot]`: how its own reviews are told from others'.
                appSlug: slug,
              }),
      };
    },
    clone: cloneAtSha,
    cloneUrl: githubCloneUrl,
    async workDir() {
      const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lgtmoose-"));
      return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
    },
    archive: tarArchive,
    log,
    replies: drizzleReplyStore(db),
    async proposeLearning(installationId, proposal) {
      const client = new GitHubClient({
        token: installationTokenProvider({
          appId: app.appId,
          privateKey: app.privateKey,
          installationId,
          timeoutMs: GITHUB_TIMEOUT_MS,
        }),
        timeoutMs: GITHUB_TIMEOUT_MS,
      });
      const [owner = "", name = ""] = proposal.repo.split("/");
      const result = await proposeLearning(
        {
          store: learningStore,
          permissions: (_repo, login) =>
            collaboratorPermission(client, { owner, repo: name }, login, log),
          orgRoles: (org, login) => orgRole(client, org, login, log),
          ...(maxPendingLearnings === undefined
            ? {}
            : { maxPendingPerAuthor: maxPendingLearnings }),
        },
        // A repo-wide convention from the person's reason, as `learn:` makes by default.
        { kind: "convention", text: proposal.text, scope: { level: "repo" } },
        {
          repo: proposal.repo,
          pr: proposal.prNumber,
          commentId: proposal.commentId,
          author: proposal.author,
        },
      );
      log("learning proposed from a reply", {
        commentId: proposal.commentId,
        outcome: result.outcome,
        ...(result.outcome === "refused" ? { reason: result.reason } : {}),
      });
    },
    learnings: learningsRetriever(learningStore, embedder, log),
    outcomes: outcomeLearner({
      db,
      learnings: learningStore,
      client: (installationId) =>
        new GitHubClient({
          token: installationTokenProvider({
            appId: app.appId,
            privateKey: app.privateKey,
            installationId,
            timeoutMs: GITHUB_TIMEOUT_MS,
          }),
          timeoutMs: GITHUB_TIMEOUT_MS,
        }),
      ...(maxPendingLearnings === undefined ? {} : { maxPendingPerAuthor: maxPendingLearnings }),
      ...(parts.repeatThreshold === undefined ? {} : { repeatThreshold: parts.repeatThreshold }),
      log,
    }),
    ...(tickets === undefined ? {} : { tickets }),
    bootstrap: {
      store: drizzleBootstrapStore(db),
      async github(installationId) {
        const client = new GitHubClient({
          token: installationTokenProvider({
            appId: app.appId,
            privateKey: app.privateKey,
            installationId,
            timeoutMs: GITHUB_TIMEOUT_MS,
          }),
          timeoutMs: GITHUB_TIMEOUT_MS,
        });
        return githubBootstrap(client, log);
      },
      learnings: learningStore,
      maxCostUsd: parts.bootstrapMaxCostUsd ?? BOOTSTRAP_DEFAULTS.maxCostUsd,
    },
    spend: {
      store: postgresSpend(db as unknown as Parameters<typeof postgresSpend>[0]),
      budgets: parts.budgets ?? budgetsSchema.parse({}),
    },
    checksWaits: drizzleChecksWaits(db),
  };
}
