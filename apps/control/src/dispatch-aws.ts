import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { StartExecutionCommand, StopExecutionCommand, type SFNClient } from "@aws-sdk/client-sfn";
import {
  dispatchedExecutions,
  pullRequestDispatches,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "./database.js";
import { describeStatus, errorName } from "./sfn.js";
import type { DispatchDeps, DispatchStore, Executions } from "./dispatch.js";

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
            // Posted, or being posted by a run that may yet be stopped or fail as it finishes.
            or(eq(reviewRuns.status, "succeeded"), isNotNull(reviewRuns.reviewSubmittedAt)),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
