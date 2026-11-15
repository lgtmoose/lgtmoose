import { randomUUID } from "node:crypto";
import { z } from "zod";
import { workflowJobSchema } from "../job.js";
import type { ControlDeps } from "../ports.js";
import { fail } from "../fail.js";
import { post } from "../post.js";
import { prepare, type PrepareSettings } from "../prepare.js";
import { POST_FAILED, PREPARE_FAILED } from "../run.js";

/**
 * The review workflow without Step Functions, for docker compose (NIC-843): the state machine in
 * infra/cdk/lib/review-workflow.ts, run in the runner's process. It calls the same steps the
 * control task runs (`prepare`, `post`, `fail`): only the orchestration around them is new.
 *
 * Debounce → prepare → (superseded: done) → each batch, up to `maxConcurrency` at once → post.
 * Prepare or post failing for good fails the run (`fail`), so a broken run never leaves a partial
 * review. A batch failing leaves its output missing, which the post step reads as a failed batch
 * (the review is then incomplete and can't approve), as on AWS.
 */

/** One of the runner's executions, as the workflow reads and ends it. */
export interface LocalExecutions {
  /** RUNNING, ABORTED…: an execution stopped by the dispatcher (a newer push) reads ABORTED. */
  status(arn: string): Promise<string | undefined>;
  finish(arn: string, status: "SUCCEEDED" | "FAILED", cause?: string): Promise<void>;
}

/** One batch of a run: the sandbox reviews it and writes its output, or fails. */
export type BatchRunner = (batch: {
  runId: string;
  index: number;
  executionArn: string;
}) => Promise<void>;

export interface LocalWorkflowDeps {
  control: ControlDeps;
  executions: LocalExecutions;
  runBatch: BatchRunner;
  settings: PrepareSettings;
  /**
   * This runner, as the post step's review claim names it (an ECS task ARN on AWS). A claim held
   * by another runner counts as stopped: one host runs one runner.
   */
  owner: string;
  /** The most batches of one run reviewed at once (the map state's `maxConcurrency`). */
  maxConcurrency: number;
  /** How many times prepare and post are tried before the run fails (the states' retries). */
  attempts?: number;
  sleep(ms: number): Promise<void>;
}

/** The execution input the dispatcher started it with (`WorkflowInput`). */
const inputSchema = workflowJobSchema.extend({
  debounceSeconds: z.number().int().min(0).max(3600).optional(),
});

/** How often a debouncing execution checks whether it was stopped. */
const DEBOUNCE_STEP_MS = 1_000;
/** The wait before a retry of prepare or post: 10 s, then doubling, as on AWS. */
const RETRY_BASE_MS = 10_000;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/** Runs `items` through `work`, at most `limit` at a time. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Runs one execution to its end. Never throws: whatever happens, the execution is finished
 * (or left ABORTED by whoever stopped it).
 */
export async function runExecution(
  deps: LocalWorkflowDeps,
  execution: { arn: string; input: unknown },
): Promise<void> {
  const { arn } = execution;
  const { control } = deps;
  const attempts = deps.attempts ?? 3;
  const running = async () => (await deps.executions.status(arn)) === "RUNNING";
  const failRun = async (error: string, cause: string) => {
    try {
      await fail(control, arn, error);
    } catch (failError) {
      control.log("fail step failed", { executionArn: arn, error: message(failError) });
    }
    await deps.executions.finish(arn, "FAILED", `${error}: ${cause}`);
  };
  /** Tries `step` up to `attempts` times, waiting longer each time. */
  const retried = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await step();
      } catch (error) {
        control.log(`${name} failed`, { executionArn: arn, attempt, error: message(error) });
        if (attempt >= attempts) throw error;
        await deps.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  };

  const parsed = inputSchema.safeParse(execution.input);
  if (!parsed.success) {
    // Started by our own dispatcher, so this is a bug, not bad input: fail it and say so.
    await failRun("Lgtmoose.BadInput", "the execution's input isn't a review job");
    return;
  }
  const { debounceSeconds = 0, ...job } = parsed.data;

  // Debounce: the next push in a burst stops this execution before it clones.
  for (let waited = 0; waited < debounceSeconds * 1000; waited += DEBOUNCE_STEP_MS) {
    if (!(await running())) return;
    await deps.sleep(Math.min(DEBOUNCE_STEP_MS, debounceSeconds * 1000 - waited));
  }
  if (!(await running())) return;

  let prepared;
  try {
    prepared = await retried("prepare", () => prepare(control, job, arn, deps.settings));
  } catch (error) {
    await failRun(PREPARE_FAILED, message(error));
    return;
  }
  if (prepared.superseded) {
    await deps.executions.finish(arn, "SUCCEEDED");
    return;
  }

  await eachLimited(prepared.batches, deps.maxConcurrency, async (batch) => {
    // A stopped execution starts no more batches: its run is superseded.
    if (!(await running())) return;
    try {
      await deps.runBatch({ runId: prepared.runId, index: batch.index, executionArn: arn });
    } catch (error) {
      control.log("batch failed", {
        executionArn: arn,
        runId: prepared.runId,
        index: batch.index,
        error: message(error),
      });
    }
  });

  // A stopped execution's post still runs, as on AWS (post waits for its task token, so a stop
  // doesn't cut it short): it sees the execution isn't running and marks the run superseded.
  try {
    await retried("post", () =>
      post(control, prepared.runId, {
        running,
        attempt: { id: randomUUID(), taskArn: deps.owner },
        taskStatus: async (holder) => (holder === deps.owner ? "RUNNING" : "STOPPED"),
        executionStatus: (executionArn) => deps.executions.status(executionArn),
      }),
    );
  } catch (error) {
    await failRun(POST_FAILED, message(error));
    return;
  }
  await deps.executions.finish(arn, "SUCCEEDED");
}
