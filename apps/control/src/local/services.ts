import type { QueuedMessage } from "@lgtmoose/db";
import type { ReviewJob } from "@lgtmoose/core";
import type { DispatchJob, QueueRecord } from "../dispatch.js";

/**
 * The docker compose runner's work besides reviews (NIC-843): what Lambdas and schedules do on
 * AWS, as plain functions over the Postgres queue so they can be tested without Docker.
 */

/** A Postgres queue, as these services use it. */
export interface ServiceQueue {
  send(message: { groupId: string; dedupeId: string; body: string }): Promise<boolean>;
  receive(max: number, visibilityMs: number): Promise<QueuedMessage[]>;
  ack(id: number): Promise<void>;
  retryLater(id: number, delayMs: number): Promise<void>;
  prune(): Promise<number>;
}

/** The PR's message group, as the gateway and `reviewJobGroupId` name it. */
function groupOf(job: Pick<ReviewJob, "repo" | "prNumber">): string {
  return `${job.repo}#${job.prNumber}`;
}

/** A job queue's `send`, as the dispatcher, the conversation handler and the reconciler call it. */
export function queueSender(queue: Pick<ServiceQueue, "send">) {
  return {
    /** The dispatcher's and conversation handler's `{ send(job) }`. */
    async send(job: DispatchJob | ReviewJob): Promise<void> {
      await queue.send({
        groupId: groupOf(job),
        dedupeId: job.deliveryId,
        body: JSON.stringify(job),
      });
    },
    /** The reconciler's `send(job, { groupId, dedupeId })`. */
    async sendWith(job: ReviewJob, options: { groupId: string; dedupeId: string }): Promise<void> {
      await queue.send({ ...options, body: JSON.stringify(job) });
    },
  };
}

/**
 * Takes conversation jobs off their queue and handles them with `handle`, the conversation
 * Lambda's own batch function (`conversationBatch`). Failed ones are retried after 30 s and hold
 * their PR's later ones, as SQS does on AWS.
 */
export async function consumeConversations(
  queue: ServiceQueue,
  handle: (records: QueueRecord[]) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>,
  options: { batchSize?: number; visibilityMs?: number } = {},
): Promise<number> {
  const messages = await queue.receive(options.batchSize ?? 10, options.visibilityMs ?? 300_000);
  if (messages.length === 0) return 0;
  const { batchItemFailures } = await handle(
    messages.map((message) => ({
      messageId: String(message.id),
      body: message.body,
      attributes: { MessageGroupId: message.groupId },
    })),
  );
  const failed = new Set(batchItemFailures.map((failure) => failure.itemIdentifier));
  for (const message of messages) {
    if (failed.has(String(message.id))) await queue.retryLater(message.id, 30_000);
    else await queue.ack(message.id);
  }
  return messages.length;
}

/** How long artifacts and ended executions are kept: the S3 bucket's lifecycle rule on AWS. */
export const RETENTION_DAYS = 30;

/** The retention sweep: what S3's lifecycle rule and SQS's own expiry do on AWS. */
export async function sweep(deps: {
  artifacts: { deleteOlder(prefix: string, before: Date): Promise<number> };
  executions: { pruneEnded(before: Date): Promise<number> };
  queues: readonly Pick<ServiceQueue, "prune">[];
  now?: () => Date;
}): Promise<{ artifacts: number; executions: number; messages: number }> {
  const now = deps.now?.() ?? new Date();
  const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const artifacts = await deps.artifacts.deleteOlder("", before);
  const executions = await deps.executions.pruneEnded(before);
  let messages = 0;
  for (const queue of deps.queues) messages += await queue.prune();
  return { artifacts, executions, messages };
}

/**
 * Runs `task` every `intervalMs`, never two at once, logging what it throws. The first run is
 * after `firstAfterMs`. Returns a stop function.
 */
export function every(
  name: string,
  intervalMs: number,
  task: () => Promise<unknown>,
  log: (message: string, fields?: Record<string, unknown>) => void,
  firstAfterMs = intervalMs,
): () => Promise<void> {
  let running: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || running !== undefined) return;
    running = task()
      .then(
        () => undefined,
        (error: unknown) => {
          log(`${name} failed`, { error: error instanceof Error ? error.message : String(error) });
        },
      )
      .finally(() => {
        running = undefined;
      });
  };
  const first = setTimeout(() => {
    run();
  }, firstAfterMs);
  const timer = setInterval(run, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
