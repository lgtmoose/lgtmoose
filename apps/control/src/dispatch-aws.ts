import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { reviewJobGroupId } from "@lgtmoose/core";
import { StartExecutionCommand, StopExecutionCommand, type SFNClient } from "@aws-sdk/client-sfn";
import {
  dispatchedExecutions,
  findingEvents,
  findings,
  pullRequestDispatches,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./database.js";
import { describeStatus, errorName } from "./sfn.js";
import type { DispatchDeps, DispatchStore, Executions } from "./dispatch.js";
import type { ChecksWait, ChecksWaitStore } from "./ports.js";
import { needsTrustedResolver } from "./thread-policy.js";

/** `arn:…:states:region:account:stateMachine:Name` → `…:execution:Name:<name>`. */
export function executionArnOf(stateMachineArn: string, name: string): string {
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
}

/** The review state machine over Step Functions. */
export function sfnExecutions(
  client: Pick<SFNClient, "send">,
  stateMachineArn: string,
): Executions {
  return {
    arnOf: (name) => executionArnOf(stateMachineArn, name),
    async start(name, input) {
      try {
        await client.send(
          new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }),
        );
        return { started: true };
      } catch (error) {
        if (errorName(error) !== "ExecutionAlreadyExists") throw error;
        return { started: false };
      }
    },
    status: (executionArn) => describeStatus(client, executionArn),
    async stop(executionArn, cause) {
      try {
        await client.send(new StopExecutionCommand({ executionArn, cause }));
      } catch (error) {
        // Recorded before it was started, and the start failed; or it has already ended.
        const status = await describeStatus(client, executionArn);
        if (status === "RUNNING") throw error;
      }
    },
  };
}

/**
 * Sends a message that isn't a valid job to the job queue's dead-letter queue (FIFO), with why.
 * The message ID dedupes a redelivered copy.
 */
export function sqsDeadLetter(
  client: Pick<SQSClient, "send">,
  queueUrl: string,
): DispatchDeps["deadLetter"] {
  return async (record, reason) => {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: record.body,
        MessageGroupId: record.attributes?.MessageGroupId ?? "invalid",
        MessageDeduplicationId: record.messageId,
        MessageAttributes: {
          reason: { DataType: "String", StringValue: reason.slice(0, 1000) },
        },
      }),
    );
  };
}

/**
 * Forwards comment jobs to the conversation queue (FIFO): in the PR's message group, so a PR's
 * comments are handled in order, and deduplicated on the delivery ID.
 */
export function sqsConversationQueue(
  client: Pick<SQSClient, "send">,
  queueUrl: string,
): NonNullable<DispatchDeps["conversation"]> {
  return {
    async send(job) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(job),
          MessageGroupId: reviewJobGroupId(job),
          MessageDeduplicationId: job.deliveryId,
        }),
      );
    },
  };
}

const lower = (repo: string) => repo.toLowerCase();

/** The dispatcher's tables, and `review_runs` for the runs of the executions it stops. */
export function drizzleDispatchStore(db: Db, now: () => Date = () => new Date()): DispatchStore {
  return {
    async latest(repo, number) {
      const [row] = await db
        .select()
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, lower(repo)),
            eq(pullRequestDispatches.number, number),
          ),
        );
      return row === undefined
        ? undefined
        : { eventAt: row.lastEventAt, closed: row.closedAt !== null };
    },
    async advance(repo, number, eventAt, closed) {
      const values = { lastEventAt: eventAt, closedAt: closed ? eventAt : null };
      await db
        .insert(pullRequestDispatches)
        .values({ repo: lower(repo), number, ...values })
        .onConflictDoUpdate({
          target: [pullRequestDispatches.repo, pullRequestDispatches.number],
          set: { ...values, updatedAt: now() },
        });
    },
    async record(repo, number, execution) {
      await db
        .insert(dispatchedExecutions)
        .values({ repo: lower(repo), number, ...execution })
        .onConflictDoNothing();
    },
    async unstopped(repo, number) {
      return db
        .select({
          executionArn: dispatchedExecutions.executionArn,
          headSha: dispatchedExecutions.headSha,
          eventAt: dispatchedExecutions.eventAt,
        })
        .from(dispatchedExecutions)
        .where(
          and(
            eq(dispatchedExecutions.repo, lower(repo)),
            eq(dispatchedExecutions.number, number),
            isNull(dispatchedExecutions.stoppedAt),
          ),
        );
    },
    async supersedeRun(executionArn) {
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(
          and(
            eq(reviewRuns.executionArn, executionArn),
            inArray(reviewRuns.status, ["queued", "running"]),
          ),
        );
    },
    async markStopped(executionArn) {
      await db
        .update(dispatchedExecutions)
        .set({ stoppedAt: now() })
        .where(eq(dispatchedExecutions.executionArn, executionArn));
    },
    async paused(repo, number) {
      const [row] = await db
        .select({ pausedAt: pullRequestDispatches.pausedAt })
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, lower(repo)),
            eq(pullRequestDispatches.number, number),
          ),
        );
      return row?.pausedAt !== undefined && row.pausedAt !== null;
    },
    async reviewed(repo, number, headSha) {
      const [row] = await db
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
        .where(
          and(
            // As the job spells it, like the prepare step records it.
            eq(pullRequests.repo, repo),
            eq(pullRequests.number, number),
            eq(reviewRuns.headSha, headSha),
            // Covered: another run's review is on the head.
            inArray(reviewRuns.status, ["succeeded", "covered"]),
            // A run a spend cap kept batches from didn't review all of its head (NIC-1079).
            isNull(reviewRuns.spendCap),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
    async followThread(repo, number, firstCommentId, resolved, actor) {
      // Unresolving also reopens a finding we closed after a reply and resolved the thread of
      // (fixed, disputed, declined): the person disagrees, and their latest action wins.
      const from = resolved
        ? (["open", "outdated"] as const)
        : (["resolved_by_human", "fixed", "disputed", "declined"] as const);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: findings.id,
            sha: findings.raisedAtSha,
            severity: findings.severity,
            ruleCategory: findings.ruleCategory,
          })
          .from(findings)
          .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
          .where(
            and(
              sql`lower(${pullRequests.repo}) = ${lower(repo)}`,
              eq(pullRequests.number, number),
              eq(findings.source, "self"),
              inArray(findings.status, [...from]),
              eq(findings.githubCommentId, firstCommentId),
            ),
          );
        // A blocking or protected finding isn't cleared here: write access can't be checked
        // without GitHub. Its resolution is recorded as not counted, for the next run's sync.
        const held = resolved ? rows.filter((row) => needsTrustedResolver(row)) : [];
        const moved = rows.filter((row) => !held.includes(row));
        if (moved.length > 0) {
          await tx
            .update(findings)
            .set({ status: resolved ? "resolved_by_human" : "open", updatedAt: now() })
            .where(
              inArray(
                findings.id,
                moved.map((row) => row.id),
              ),
            );
        }
        if (rows.length > 0) {
          await tx.insert(findingEvents).values(
            rows.map((row) => ({
              findingId: row.id,
              type: resolved ? ("resolved" as const) : ("unresolved" as const),
              actor: "human" as const,
              actorLogin: actor,
              ...(resolved ? { counted: !held.includes(row) } : {}),
              // No review ran: the commit the finding was last raised at.
              sha: row.sha,
              githubCommentId: firstCommentId,
            })),
          );
        }
        return { changed: moved.length, held: held.length };
      });
    },
  };
}

/**
 * The wait for CI (NIC-1078) on the PR's dispatcher record. The dispatcher creates that record
 * before it starts any execution, so a run that waits always finds it; without one there's
 * nothing to record and the wait starts afresh each time.
 */
export function drizzleChecksWaits(db: Db): ChecksWaitStore {
  const where = (repo: string, number: number) =>
    and(eq(pullRequestDispatches.repo, lower(repo)), eq(pullRequestDispatches.number, number));
  const get = async (repo: string, number: number): Promise<ChecksWait | undefined> => {
    const [row] = await db
      .select({
        headSha: pullRequestDispatches.checksWaitSha,
        since: pullRequestDispatches.checksWaitSince,
        state: pullRequestDispatches.checksWaitState,
      })
      .from(pullRequestDispatches)
      .where(where(repo, number));
    if (row?.headSha === undefined || row.headSha === null || row.since === null) return undefined;
    return { headSha: row.headSha, since: row.since, state: row.state ?? undefined };
  };
  return {
    get,
    async wait(repo, number, headSha, state, now) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            headSha: pullRequestDispatches.checksWaitSha,
            since: pullRequestDispatches.checksWaitSince,
            state: pullRequestDispatches.checksWaitState,
          })
          .from(pullRequestDispatches)
          .where(where(repo, number))
          .for("update");
        const before =
          row?.headSha === headSha && row.since !== null
            ? { headSha, since: row.since, state: row.state ?? undefined }
            : undefined;
        await tx
          .update(pullRequestDispatches)
          .set({
            checksWaitSha: headSha,
            checksWaitSince: before?.since ?? now,
            checksWaitState: state,
            updatedAt: now,
          })
          .where(where(repo, number));
        return before;
      });
    },
    async clear(repo, number) {
      await db
        .update(pullRequestDispatches)
        .set({ checksWaitSha: null, checksWaitSince: null, checksWaitState: null })
        .where(and(where(repo, number), sql`${pullRequestDispatches.checksWaitSha} is not null`));
    },
    async byHead(repo, sha) {
      const rows = await db
        .select({ number: pullRequestDispatches.number })
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, lower(repo)),
            eq(pullRequestDispatches.checksWaitSha, sha),
          ),
        )
        .orderBy(pullRequestDispatches.number);
      return rows.map((row) => row.number);
    },
  };
}
