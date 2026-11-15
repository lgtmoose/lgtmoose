import type { QueuedMessage } from "@lgtmoose/db";
import {
  dispatchBatch,
  type DispatchDeps,
  type DispatchStore,
  type Executions,
  type QueueRecord,
} from "../dispatch.js";
import { fail } from "../fail.js";
import { runExecution, type LocalWorkflowDeps } from "./workflow.js";

/** The error a run left by a stopped runner is failed with. */
export const RUNNER_RESTARTED = "Lgtmoose.RunnerRestarted";

/**
 * The docker compose runner (NIC-843): one process that does what the dispatcher Lambda and the
 * review state machine do on AWS. Each `tick` it
 * 1. takes jobs off the Postgres job queue and dispatches them (`dispatchBatch`, the dispatcher
 *    Lambda's own code), which starts, dedupes and stops executions;
 * 2. picks up executions that nobody runs yet and runs each (`runExecution`) in the background,
 *    up to `maxExecutions` at once.
 * At start, executions a previous runner process left running are failed, as a lost ECS task
 * fails its step: the next push or the reconciler reviews the PR again.
 */

/** The queue the gateway puts jobs on (`JOBS_QUEUE` in the gateway's server.ts). */
export const JOBS_QUEUE = "jobs";
/** Where messages that can't be handled go, for someone to look at. */
export const DEAD_QUEUE = "dead";

/** What the runner needs of `PostgresQueue` in @lgtmoose/db. */
export interface RunnerQueue {
  receive(max: number, visibilityMs: number): Promise<QueuedMessage[]>;
  ack(id: number): Promise<void>;
  retryLater(id: number, delayMs: number): Promise<void>;
  deadLetter(
    message: QueuedMessage,
    dead: { readonly name: string },
    reason: string,
  ): Promise<void>;
  prune(): Promise<number>;
}

export interface RunnerDeadQueue {
  readonly name: string;
  send(message: { groupId: string; dedupeId: string; body: string }): Promise<boolean>;
}

/** What the runner needs of `postgresExecutions` in @lgtmoose/db. */
export interface RunnerExecutions extends Executions {
  claim(owner: string, max: number): Promise<{ arn: string; input: unknown }[]>;
  orphaned(owner: string): Promise<{ arn: string }[]>;
  finish(arn: string, status: "SUCCEEDED" | "FAILED", cause?: string): Promise<void>;
}

export interface RunnerDeps {
  jobs: RunnerQueue;
  dead: RunnerDeadQueue;
  executions: RunnerExecutions;
  dispatchStore: DispatchStore;
  /** The workflow's dependencies, without what the runner supplies. */
  workflow: Omit<LocalWorkflowDeps, "executions" | "owner">;
  /** This process: unique per start, so a restart can tell its own executions from orphans. */
  owner: string;
  /** The most executions run at once. */
  maxExecutions: number;
  /** Where comment jobs go (`DispatchDeps.conversation`). */
  conversation?: DispatchDeps["conversation"];
  /** Jobs taken off the queue per tick. */
  batchSize?: number;
  /** How long a job is in flight before it's handed out again (SQS's visibility timeout). */
  visibilityMs?: number;
  /** How often a job is tried before it's dead-lettered (the queue's `maxReceiveCount`). */
  maxReceives?: number;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The wait before a failed job is tried again: it holds its PR's later jobs meanwhile. */
const RETRY_DELAY_MS = 30_000;

export function createRunner(deps: RunnerDeps) {
  const running = new Map<string, Promise<void>>();
  const maxReceives = deps.maxReceives ?? 5;
  const dispatchDeps: DispatchDeps = {
    executions: deps.executions,
    store: deps.dispatchStore,
    async deadLetter(record, reason) {
      await deps.dead.send({
        groupId: record.attributes?.MessageGroupId ?? "",
        dedupeId: `jobs:${record.messageId}`,
        body: JSON.stringify({ queue: JOBS_QUEUE, reason, body: record.body }),
      });
    },
    // Comment jobs go to the conversation queue, which the entrypoint consumes; without one
    // (in tests) they're acknowledged and dropped, as on AWS.
    ...(deps.conversation === undefined ? {} : { conversation: deps.conversation }),
    log: (message, fields) => deps.log(message, fields),
  };

  /** Dispatches a batch of queued jobs; failed ones wait and hold their PR's later jobs. */
  async function dispatchJobs(): Promise<number> {
    const messages = await deps.jobs.receive(deps.batchSize ?? 10, deps.visibilityMs ?? 300_000);
    if (messages.length === 0) return 0;
    const records: QueueRecord[] = messages.map((message) => ({
      messageId: String(message.id),
      body: message.body,
      attributes: { MessageGroupId: message.groupId },
    }));
    const { batchItemFailures } = await dispatchBatch(dispatchDeps, records);
    const failed = new Set(batchItemFailures.map((failure) => failure.itemIdentifier));
    for (const message of messages) {
      if (!failed.has(String(message.id))) {
        await deps.jobs.ack(message.id);
      } else if (message.receiveCount >= maxReceives) {
        await deps.jobs.deadLetter(message, deps.dead, `failed ${message.receiveCount} times`);
        deps.log("job dead-lettered", { messageId: message.id, receives: message.receiveCount });
      } else {
        await deps.jobs.retryLater(message.id, RETRY_DELAY_MS);
      }
    }
    return messages.length;
  }

  /** Starts executions that nobody runs yet, up to the limit. */
  async function startExecutions(): Promise<number> {
    const room = deps.maxExecutions - running.size;
    if (room <= 0) return 0;
    const claimed = await deps.executions.claim(deps.owner, room);
    for (const execution of claimed) {
      const work = runExecution(
        { ...deps.workflow, executions: deps.executions, owner: deps.owner },
        execution,
      )
        .catch((error: unknown) => {
          // runExecution doesn't throw; if it ever does, the execution mustn't stay RUNNING.
          deps.log("execution crashed", {
            executionArn: execution.arn,
            error: error instanceof Error ? error.message : String(error),
          });
          return deps.executions.finish(execution.arn, "FAILED", "the runner crashed");
        })
        .finally(() => running.delete(execution.arn));
      running.set(execution.arn, work);
    }
    return claimed.length;
  }

  return {
    /** Fails the executions a previous runner process left running. */
    async recover(): Promise<number> {
      const orphans = await deps.executions.orphaned(deps.owner);
      for (const orphan of orphans) {
        try {
          await fail(deps.workflow.control, orphan.arn, RUNNER_RESTARTED);
        } catch (error) {
          deps.log("orphan's run not failed", {
            executionArn: orphan.arn,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await deps.executions.finish(orphan.arn, "FAILED", "the runner restarted");
        deps.log("orphaned execution failed", { executionArn: orphan.arn });
      }
      return orphans.length;
    },
    /** One round: dispatch queued jobs, then start what can start. Returns what it did. */
    async tick(): Promise<{ jobs: number; started: number }> {
      const jobs = await dispatchJobs();
      const started = await startExecutions();
      return { jobs, started };
    },
    /** Resolves once every execution this runner started has ended. */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all(running.values());
    },
    /** Executions running in this process. */
    get running(): number {
      return running.size;
    },
    prune: () => deps.jobs.prune(),
  };
}

export type Runner = ReturnType<typeof createRunner>;
