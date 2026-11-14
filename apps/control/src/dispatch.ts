import { createHash } from "node:crypto";
import { REVIEW_JOB_KINDS, type ReviewJob } from "@lgtmoose/core";
import { z } from "zod";
import type { RunStore } from "./ports.js";

/**
 * The dispatcher: reads review jobs from the FIFO queue and turns them into review workflow
 * executions. It never calls GitHub or a model; the workflow's prepare step does that.
 *
 * - A push, open or ready job starts an execution named after the PR and its head
 *   (`executionName`), so a second start for the same head is a no-op. An open or ready job
 *   whose head's execution ended without succeeding (stopped when the PR closed, or failed)
 *   starts a retry instead: a PR reopened at the same head is reviewed again.
 * - Once that execution exists, running executions for an older head of the same PR are
 *   stopped, and their runs marked superseded: StopExecution skips the workflow's fail step.
 * - Pushes are debounced: the execution waits `PUSH_DEBOUNCE_SECONDS` before it does anything,
 *   so a burst of pushes stops each waiting execution before it clones (see `debounceSeconds`).
 * - Closing a PR stops its running executions.
 * - Comment, review and thread jobs go to `conversation`, which does nothing until M5.
 */

/** How long a push waits for the next one before its review starts. */
export const PUSH_DEBOUNCE_SECONDS = 60;

/** Step Functions limits execution names to 80 characters. */
const MAX_NAME = 80;
/** Head SHAs are cut to SHA-1 length in names; the full SHA is in the execution input. */
const NAME_SHA_LENGTH = 40;
/** Hex digits of the repository hash that keeps names of different repositories apart. */
const REPO_HASH_LENGTH = 12;
/** Hex digits of the delivery hash that names a retry: `-` and these follow the SHA. */
const RETRY_HASH_LENGTH = 8;

function hex(text: string, length: number): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** The queue message, validated: the gateway wrote it, but it's still read from the network. */
export const reviewJobSchema = z.object({
  kind: z.enum(REVIEW_JOB_KINDS),
  deliveryId: z.string().min(1),
  installationId: z.number().int().positive(),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name"),
  prNumber: z.number().int().positive(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .optional(),
  actor: z.string().min(1),
  commentId: z.number().int().positive().optional(),
  reviewId: z.number().int().positive().optional(),
  threadNodeId: z.string().min(1).optional(),
  receivedAt: z.string().min(1),
});

/** The review workflow's input: the job, and how long to wait before preparing. */
export interface WorkflowInput extends ReviewJob {
  debounceSeconds: number;
}

/**
 * The start of every execution name for one PR: `<repo>-<hash>-<pr>-`. The repository part is
 * lowercased with `/` as `_` (GitHub names are case-insensitive and use only characters Step
 * Functions allows) and cut to fit; the hash of the full name keeps two repositories apart
 * when their cut names, or their owner/name split, would match.
 */
export function executionPrefix(repo: string, prNumber: number): string {
  const name = repo.toLowerCase();
  const tail = `-${hex(name, REPO_HASH_LENGTH)}-${prNumber}-`;
  const room = MAX_NAME - NAME_SHA_LENGTH - (1 + RETRY_HASH_LENGTH) - tail.length;
  return `${name.replace("/", "_").slice(0, Math.max(room, 0))}${tail}`;
}

/**
 * The execution for a PR at a head: the same name for the same head, so starts dedupe. A retry
 * adds a hash of the delivery that asked for it, so a redelivery of that job dedupes too.
 */
export function executionName(
  repo: string,
  prNumber: number,
  headSha: string,
  retryFor?: string,
): string {
  const name = `${executionPrefix(repo, prNumber)}${headSha.slice(0, NAME_SHA_LENGTH)}`;
  return retryFor === undefined ? name : `${name}-${hex(retryFor, RETRY_HASH_LENGTH)}`;
}

/**
 * Pushes wait, so the next push in a burst stops the execution before it clones. Opening a PR
 * or marking it ready starts at once: those come one at a time.
 */
export function debounceSeconds(job: Pick<ReviewJob, "kind">): number {
  return job.kind === "pr_updated" ? PUSH_DEBOUNCE_SECONDS : 0;
}

/** A running execution of the review workflow. */
export interface RunningExecution {
  name: string;
  executionArn: string;
}

/** The review state machine, as the dispatcher uses it. */
export interface Executions {
  /**
   * Starts an execution. `started` is false when one with this name already exists with a
   * different input or has finished (Step Functions keeps names for 90 days): the job is a
   * duplicate. Starting a running execution again with the same input returns it.
   */
  start(name: string, input: WorkflowInput): Promise<{ started: boolean; executionArn: string }>;
  /** The status of the named execution (RUNNING, SUCCEEDED, ABORTED…), if there is one. */
  status(name: string): Promise<string | undefined>;
  /** Running executions whose name starts with `prefix`. */
  running(prefix: string): Promise<RunningExecution[]>;
  /** Stops an execution; one that already ended is left as it is. */
  stop(executionArn: string, cause: string): Promise<void>;
}

/**
 * `review_runs`, as the dispatcher uses it. An execution stopped before its prepare step
 * recorded a run has none yet; prepare marks it when its task token turns out to be dead.
 */
export type DispatchRuns = Pick<RunStore, "supersedeExecutions">;

export interface DispatchDeps {
  executions: Executions;
  runs: DispatchRuns;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** What the dispatcher did with a job; for logs and tests. */
export type DispatchResult =
  | { action: "started"; executionArn: string; stopped: string[] }
  | { action: "retried"; executionArn: string }
  | { action: "duplicate"; name: string }
  | { action: "stopped"; stopped: string[] }
  | { action: "deferred"; reason: string }
  | { action: "ignored"; reason: string };

/** Stops the PR's running executions other than `keep`, and marks their runs superseded. */
async function stopOthers(
  deps: DispatchDeps,
  job: ReviewJob,
  cause: string,
  keep?: string,
): Promise<string[]> {
  const running = await deps.executions.running(executionPrefix(job.repo, job.prNumber));
  const stale = running.filter((execution) => execution.name !== keep);
  for (const execution of stale) await deps.executions.stop(execution.executionArn, cause);
  const arns = stale.map((execution) => execution.executionArn);
  if (arns.length > 0) await deps.runs.supersedeExecutions(arns);
  return arns;
}

async function review(deps: DispatchDeps, job: ReviewJob): Promise<DispatchResult> {
  if (job.headSha === undefined) return { action: "ignored", reason: "no head SHA" };
  const input: WorkflowInput = { ...job, debounceSeconds: debounceSeconds(job) };
  const name = executionName(job.repo, job.prNumber, job.headSha);
  const { started, executionArn } = await deps.executions.start(name, input);
  if (started) {
    const stopped = await stopOthers(deps, job, `Superseded by ${job.headSha}.`, name);
    return { action: "started", executionArn, stopped };
  }
  // A push for a head that already has an execution is a duplicate. So is a late redelivery
  // of an old push, and superseding then would stop the review of the PR's real head.
  if (job.kind === "pr_updated") return { action: "duplicate", name };
  return retry(deps, job.headSha, job, input, name);
}

/**
 * An open or ready job for a head whose execution ended without succeeding: the PR was closed
 * mid-review and then reopened, or the review failed. It runs again, superseding nothing: if
 * the job is old, the PR's real head has its own execution, and this one's prepare step finds
 * the head moved on and stops.
 */
async function retry(
  deps: DispatchDeps,
  headSha: string,
  job: ReviewJob,
  input: WorkflowInput,
  name: string,
): Promise<DispatchResult> {
  const status = await deps.executions.status(name);
  if (status === undefined || status === "RUNNING" || status === "SUCCEEDED") {
    return { action: "duplicate", name };
  }
  const retryName = executionName(job.repo, job.prNumber, headSha, job.deliveryId);
  const { started, executionArn } = await deps.executions.start(retryName, input);
  return started ? { action: "retried", executionArn } : { action: "duplicate", name: retryName };
}

/**
 * Comment, review and thread jobs: replies and dispute handling, on a path that doesn't clone.
 * The seam for M5; until then they're acknowledged and dropped.
 */
async function conversation(_deps: DispatchDeps, job: ReviewJob): Promise<DispatchResult> {
  return { action: "deferred", reason: `${job.kind} jobs arrive with M5` };
}

/** Handles one job. Throws when it should be retried (and, in the end, dead-lettered). */
export async function dispatch(deps: DispatchDeps, job: ReviewJob): Promise<DispatchResult> {
  switch (job.kind) {
    case "pr_opened":
    case "pr_ready":
    case "pr_updated":
      return review(deps, job);
    case "pr_closed":
      return { action: "stopped", stopped: await stopOthers(deps, job, "Pull request closed.") };
    case "comment":
    case "review":
    case "review_comment":
    case "thread_resolved":
    case "thread_unresolved":
      return conversation(deps, job);
  }
}

/** A queue message's job. Errors name the bad fields, never their values. */
export function parseQueuedJob(body: string): ReviewJob {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("The message isn't JSON.");
  }
  const parsed = reviewJobSchema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new Error(`The message isn't a review job: ${fields.join(", ")}.`);
  }
  // JSON has no undefined, so an optional field is absent rather than set to undefined, as
  // ReviewJob's exact optional properties want.
  return parsed.data as ReviewJob;
}

/** One SQS record, as Lambda delivers it. */
export interface QueueRecord {
  messageId: string;
  body: string;
}

/**
 * Handles a batch from the FIFO queue in order. The first failure and every message after it
 * are returned for redelivery: later messages may be for the same PR, and must not overtake
 * it. A message that isn't a valid job fails too, so it ends up in the dead-letter queue where
 * someone can look at it.
 */
export async function dispatchBatch(
  deps: DispatchDeps,
  records: readonly QueueRecord[],
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  for (const [index, record] of records.entries()) {
    let job: ReviewJob | undefined;
    try {
      job = parseQueuedJob(record.body);
      const result = await dispatch(deps, job);
      deps.log("dispatched", {
        messageId: record.messageId,
        deliveryId: job.deliveryId,
        repo: job.repo,
        prNumber: job.prNumber,
        kind: job.kind,
        ...result,
      });
    } catch (error) {
      deps.log("dispatch failed", {
        messageId: record.messageId,
        deliveryId: job?.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        batchItemFailures: records.slice(index).map((r) => ({ itemIdentifier: r.messageId })),
      };
    }
  }
  return { batchItemFailures: [] };
}
