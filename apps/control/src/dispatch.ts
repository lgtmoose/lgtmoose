import { createHash } from "node:crypto";
import { REVIEW_JOB_KINDS, type ReviewJob } from "@lgtmoose/core";
import { z } from "zod";
import { workflowJobSchema } from "./job.js";

/**
 * The dispatcher: reads review jobs from the FIFO queue and turns them into review workflow
 * executions. It never calls GitHub or a model; the workflow's prepare step does that.
 *
 * GitHub doesn't deliver a PR's events in order, so each job carries its event time (the PR's
 * `updated_at`) and the dispatcher keeps the newest it has acted on per PR (`DispatchStore`):
 *
 * - A job older than that is stale and does nothing: it neither starts nor stops anything.
 * - A push, open or ready job starts an execution named after the PR and its head
 *   (`executionName`), so a second start for the same head is a no-op. A job for a head that
 *   has no succeeded run and no running execution (the PR was closed during its review and
 *   reopened, the review failed, or a force-push went back to a stopped head) starts a retry.
 * - It then stops the PR's executions started by older jobs, marking each run superseded
 *   first (StopExecution skips the workflow's fail step). Jobs with the same event time both
 *   run: whole-second times can't order them, and each prepare step checks the PR's real head.
 * - Pushes are debounced: the execution waits `PUSH_DEBOUNCE_SECONDS` before it does anything,
 *   so the next push in a burst stops it before it clones (see `debounceSeconds`).
 * - Closing a PR stops the executions of jobs up to the close. A reopen with the same time as
 *   the close is taken as older: the PR stays closed.
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
export const reviewJobSchema = workflowJobSchema.extend({
  kind: z.enum(REVIEW_JOB_KINDS),
  deliveryId: z.string().min(1),
  actor: z.string().min(1),
  commentId: z.number().int().positive().optional(),
  reviewId: z.number().int().positive().optional(),
  threadNodeId: z.string().min(1).optional(),
  receivedAt: z.iso.datetime(),
  // Required: the dispatcher orders a PR's jobs by it. A job without one is invalid.
  eventAt: z.iso.datetime(),
});

/** A queued job, as the dispatcher accepts it: with the event time it orders jobs by. */
export type DispatchJob = ReviewJob & { eventAt: string };

/** The review workflow's input: the job, and how long to wait before preparing. */
export interface WorkflowInput extends ReviewJob {
  debounceSeconds: number;
}

/**
 * The start of every execution name for one PR: `<repo>-<hash>-<pr>-`. The repository part is
 * lowercased with `/` as `_` and `.` as `-` (Step Functions advises against dots in names when
 * logging to CloudWatch), then cut to fit. GitHub names are case-insensitive, and the hash of
 * the full name keeps two repositories apart when their cut or mapped names would match.
 */
export function executionPrefix(repo: string, prNumber: number): string {
  const name = repo.toLowerCase();
  const tail = `-${hex(name, REPO_HASH_LENGTH)}-${prNumber}-`;
  const room = MAX_NAME - NAME_SHA_LENGTH - (1 + RETRY_HASH_LENGTH) - tail.length;
  const readable = name.replace("/", "_").replaceAll(".", "-");
  return `${readable.slice(0, Math.max(room, 0))}${tail}`;
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

/** The review state machine, as the dispatcher uses it. */
export interface Executions {
  /** The ARN the named execution has, or will have once started. */
  arnOf(name: string): string;
  /**
   * Starts an execution. `started` is false when one with this name already exists with a
   * different input or has finished (Step Functions keeps names for 90 days). Starting a
   * running execution again with the same input returns it.
   */
  start(name: string, input: WorkflowInput): Promise<{ started: boolean }>;
  /** The execution's status (RUNNING, SUCCEEDED, ABORTED…), if there is one. */
  status(executionArn: string): Promise<string | undefined>;
  /** Stops an execution; one that has ended, or never started, is left as it is. */
  stop(executionArn: string, cause: string): Promise<void>;
}

/** An execution the dispatcher started and hasn't stopped yet. */
export interface DispatchedExecution {
  executionArn: string;
  headSha: string;
  eventAt: Date;
}

/** The dispatcher's records in the database. `repo` is passed as the job has it. */
export interface DispatchStore {
  /** The newest event the dispatcher acted on for the PR, and whether it closed the PR. */
  latest(repo: string, prNumber: number): Promise<{ eventAt: Date; closed: boolean } | undefined>;
  /** Records the job's event as the PR's newest. */
  advance(repo: string, prNumber: number, eventAt: Date, closed: boolean): Promise<void>;
  /** Records an execution before it's started, so a crash in between can't lose track of it. */
  record(repo: string, prNumber: number, execution: DispatchedExecution): Promise<void>;
  /** The PR's executions that haven't been stopped. */
  unstopped(repo: string, prNumber: number): Promise<DispatchedExecution[]>;
  /** Marks the execution's run superseded, if it has one that hasn't finished. */
  supersedeRun(executionArn: string): Promise<void>;
  /** Marks the execution stopped, so later jobs leave it alone. */
  markStopped(executionArn: string): Promise<void>;
  /**
   * Whether a run for the PR at this head has posted its review, or started to: it succeeded,
   * or its post step began submitting the review (a stopped execution's post may still be at it).
   */
  reviewed(repo: string, prNumber: number, headSha: string): Promise<boolean>;
}

export interface DispatchDeps {
  executions: Executions;
  store: DispatchStore;
  /** Puts a message that isn't a valid job on the dead-letter queue, for someone to look at. */
  deadLetter(record: QueueRecord, reason: string): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** What the dispatcher did with a job; for logs and tests. */
export type DispatchResult =
  | { action: "started"; executionArn: string; stopped: string[] }
  | { action: "retried"; executionArn: string; stopped: string[] }
  | { action: "duplicate"; name: string; stopped: string[] }
  | { action: "stopped"; stopped: string[] }
  | { action: "stale"; reason: string }
  | { action: "deferred"; reason: string }
  | { action: "ignored"; reason: string };

/**
 * Stops the PR's `unstopped` executions from jobs before `before` (up to and including it with
 * `inclusive`), except those for `keepHead`: they review the head this job is for. Each run is
 * marked superseded before its execution is stopped, and the execution marked stopped after: a
 * failure in between leaves it for the retried job to stop again, never a stopped run still
 * marked running. Executions are stopped in parallel; if any fails, the others still finish,
 * then the first error is thrown.
 */
async function stopOlder(
  deps: DispatchDeps,
  unstopped: readonly DispatchedExecution[],
  cause: string,
  before: Date,
  options: { inclusive?: boolean; keepHead?: string } = {},
): Promise<string[]> {
  const cutoff = before.getTime();
  const stale = unstopped.filter((execution) => {
    if (execution.headSha === options.keepHead) return false;
    const at = execution.eventAt.getTime();
    return options.inclusive ? at <= cutoff : at < cutoff;
  });
  const results = await Promise.allSettled(
    stale.map(async ({ executionArn }) => {
      await deps.store.supersedeRun(executionArn);
      await deps.executions.stop(executionArn, cause);
      await deps.store.markStopped(executionArn);
    }),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
  return stale.map((execution) => execution.executionArn);
}

/** Records and starts the named execution. */
async function startExecution(
  deps: DispatchDeps,
  job: ReviewJob & { headSha: string },
  name: string,
  eventAt: Date,
): Promise<{ started: boolean; executionArn: string }> {
  const executionArn = deps.executions.arnOf(name);
  await deps.store.record(job.repo, job.prNumber, { executionArn, headSha: job.headSha, eventAt });
  const { started } = await deps.executions.start(name, {
    ...job,
    debounceSeconds: debounceSeconds(job),
  });
  return { started, executionArn };
}

async function review(
  deps: DispatchDeps,
  job: ReviewJob & { headSha: string },
  eventAt: Date,
): Promise<DispatchResult> {
  await deps.store.advance(job.repo, job.prNumber, eventAt, false);
  let name = executionName(job.repo, job.prNumber, job.headSha);
  let { started, executionArn } = await startExecution(deps, job, name, eventAt);
  let action: "started" | "retried" = "started";
  const unstopped = await deps.store.unstopped(job.repo, job.prNumber);
  // A job for a head that was reviewed, or is being, is a duplicate.
  if (!started && (await needsRetry(deps, job, name, unstopped))) {
    name = executionName(job.repo, job.prNumber, job.headSha, job.deliveryId);
    ({ started, executionArn } = await startExecution(deps, job, name, eventAt));
    action = "retried";
  }
  // This job is the PR's newest, so what older jobs started for other heads can go, duplicate
  // or not. Those for this head (this one, or a retry still running) are its review.
  const stopped = await stopOlder(deps, unstopped, `Superseded by ${job.headSha}.`, eventAt, {
    keepHead: job.headSha,
  });
  return started ? { action, executionArn, stopped } : { action: "duplicate", name, stopped };
}

/**
 * A job for a head that already had an execution needs another only when the head was never
 * reviewed and no execution for it is running, the base one or an earlier retry: the PR was
 * closed mid-review and reopened, the review failed, or a force-push went back to a head whose
 * review a later push stopped. Ordering keeps a stale redelivery from getting here.
 */
async function needsRetry(
  deps: DispatchDeps,
  job: ReviewJob & { headSha: string },
  name: string,
  unstopped: readonly DispatchedExecution[],
): Promise<boolean> {
  if (await deps.store.reviewed(job.repo, job.prNumber, job.headSha)) return false;
  const candidates = new Set([deps.executions.arnOf(name)]);
  for (const execution of unstopped) {
    if (execution.headSha === job.headSha) candidates.add(execution.executionArn);
  }
  const statuses = await Promise.all([...candidates].map((arn) => deps.executions.status(arn)));
  return !statuses.includes("RUNNING");
}

/**
 * Comment, review and thread jobs: replies and dispute handling, on a path that doesn't clone.
 * The seam for M5; until then they're acknowledged and dropped.
 */
async function conversation(_deps: DispatchDeps, job: ReviewJob): Promise<DispatchResult> {
  return { action: "deferred", reason: `${job.kind} jobs arrive with M5` };
}

/** Handles one job. Throws when it should be retried (and, in the end, dead-lettered). */
export async function dispatch(deps: DispatchDeps, job: DispatchJob): Promise<DispatchResult> {
  switch (job.kind) {
    case "comment":
    case "review":
    case "review_comment":
    case "thread_resolved":
    case "thread_unresolved":
      return conversation(deps, job);
    case "pr_opened":
    case "pr_ready":
    case "pr_updated":
    case "pr_closed":
      break;
  }
  const eventAt = new Date(job.eventAt);
  const latest = await deps.store.latest(job.repo, job.prNumber);
  if (latest !== undefined) {
    const last = latest.eventAt.getTime();
    const at = eventAt.getTime();
    // A close wins a tie: a reopen in the same second as the close is taken as before it.
    if (at < last || (at === last && latest.closed && job.kind !== "pr_closed")) {
      return {
        action: "stale",
        reason: `older than the PR's ${latest.eventAt.toISOString()} event`,
      };
    }
  }
  if (job.kind === "pr_closed") {
    await deps.store.advance(job.repo, job.prNumber, eventAt, true);
    const unstopped = await deps.store.unstopped(job.repo, job.prNumber);
    const stopped = await stopOlder(deps, unstopped, "Pull request closed.", eventAt, {
      inclusive: true,
    });
    return { action: "stopped", stopped };
  }
  if (job.headSha === undefined) return { action: "ignored", reason: "no head SHA" };
  return review(deps, { ...job, headSha: job.headSha }, eventAt);
}

/** A queue message's job. Errors name the bad fields, never their values. */
export function parseQueuedJob(body: string): DispatchJob {
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
  return parsed.data as DispatchJob;
}

/** One SQS record, as Lambda delivers it. */
export interface QueueRecord {
  messageId: string;
  body: string;
  attributes?: { MessageGroupId?: string };
}

/**
 * Handles a batch from the FIFO queue in order. A failed message is returned for redelivery
 * with every later message of its group (its PR), which must not overtake it; other groups go
 * on. A message that isn't a valid job can't succeed on a retry, so it isn't failed (that
 * would hold its group back until it was dead-lettered): it's put on the dead-letter queue
 * directly and acknowledged.
 */
export async function dispatchBatch(
  deps: DispatchDeps,
  records: readonly QueueRecord[],
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failedGroups = new Set<string>();
  const failures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    // A record without a group (never on a FIFO queue) could be any PR's: after a failure it's
    // held back, and its own failure holds back everything after it.
    const group = record.attributes?.MessageGroupId ?? "";
    const held =
      group === "" ? failedGroups.size > 0 : failedGroups.has(group) || failedGroups.has("");
    if (held) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    let job: DispatchJob | undefined;
    try {
      try {
        job = parseQueuedJob(record.body);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await deps.deadLetter(record, reason);
        deps.log("invalid job dead-lettered", { messageId: record.messageId, reason });
        continue;
      }
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
      failedGroups.add(group);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
