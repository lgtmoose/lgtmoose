import { randomUUID } from "node:crypto";
import { isBootstrapInput, postBootstrap, prepareBootstrap } from "./bootstrap.js";
import type { ControlCommand, ReviewSettings } from "./env.js";
import { fail } from "./fail.js";
import { parseJob } from "./job.js";
import type { ControlDeps } from "./ports.js";
import { post } from "./post.js";
import { prepare } from "./prepare.js";
import { isDeadToken } from "./sfn.js";

/** The task-token error for a prepare step that failed, as the state machine's catch sees it. */
export const PREPARE_FAILED = "Lgtmoose.PrepareFailed";
/** The task-token error for a post step that failed. */
export const POST_FAILED = "Lgtmoose.PostFailed";

/**
 * How often a step tells Step Functions it's alive. Prepare and post wait for a task token
 * with a heartbeat timeout (`TASK_HEARTBEAT` in the CDK app), so a control task that dies
 * before it reports fails the step within that timeout, not the step's full one.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** What a step needs besides the control task's dependencies. */
export interface StepDeps extends ControlDeps {
  /** The execution's status (RUNNING, ABORTED…), or undefined when there's no such execution. */
  executionStatus(executionArn: string): Promise<string | undefined>;
  /** Sends a heartbeat on a task token. */
  heartbeat(taskToken: string): Promise<void>;
  /** For tests: the heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** For tests: the wait between execution status checks after a dead token. */
  statusRetryMs?: number;
  /**
   * This task's ECS task ARN, which post's review claim names; undefined off ECS. Read when
   * the post step starts, so a failure to read it fails the step like any other.
   */
  taskArn(): Promise<string | undefined>;
  /** An ECS task's last status, or MISSING: whether a review claim's holder still runs. */
  taskStatus(taskArn: string): Promise<string>;
}

/** What `confirmedStatus` says when every check failed. */
const STATUS_UNKNOWN = "UNKNOWN";

/**
 * Tries to read the execution's status a few times: its status, MISSING when there's no such
 * execution, or STATUS_UNKNOWN when every try failed.
 */
async function confirmedStatus(deps: StepDeps, executionArn: string): Promise<string> {
  for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
    try {
      return (await deps.executionStatus(executionArn)) ?? "MISSING";
    } catch (error) {
      deps.log("execution status check failed", { attempt, error: causeOf(error) });
      if (attempt < STATUS_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, deps.statusRetryMs ?? 1_000));
      }
    }
  }
  return STATUS_UNKNOWN;
}

const STATUS_ATTEMPTS = 3;

/** This attempt of the step was given up: a retry has taken over. */
export class StepAbandoned extends Error {
  override readonly name = "StepAbandoned";
}

/**
 * Runs `work` while sending heartbeats on its task token: one at once, then every interval. A
 * failed heartbeat (throttling, a network blip) is logged and the beats go on. A dead token
 * stops them, and then:
 * - on an execution confirmed RUNNING, this attempt timed out and a retry has the step: `work`
 *   is given up (StepAbandoned), so the two don't race;
 * - otherwise (stopped, or unknown because every status check failed), `work` finishes and its
 *   outcome is found dead on the token afterwards. A stop mustn't cut a post short, and if a
 *   retry does overlap, post's review claim keeps it to one review.
 */
async function withHeartbeat<T>(
  deps: StepDeps,
  executionArn: string,
  taskToken: string,
  work: () => Promise<T>,
): Promise<T> {
  let beating = true;
  let abandon: (reason: StepAbandoned) => void = () => undefined;
  const abandoned = new Promise<never>((_, reject) => {
    abandon = reject;
  });
  // Rejected only to end the race below; never left unhandled.
  abandoned.catch(() => undefined);
  const onDead = async () => {
    beating = false;
    if ((await confirmedStatus(deps, executionArn)) === "RUNNING") {
      abandon(new StepAbandoned("a retry has taken over this step"));
    }
  };
  const beat = () => {
    if (!beating) return;
    deps.heartbeat(taskToken).catch(async (error: unknown) => {
      const dead = isDeadToken(error);
      deps.log("heartbeat failed", { error: causeOf(error), stopping: dead });
      if (dead) await onDead();
    });
  };
  beat();
  const timer = setInterval(beat, deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  try {
    return await Promise.race([work(), abandoned]);
  } finally {
    clearInterval(timer);
  }
}

/** Message of an error, short, for the task token's cause. Never a credential: see the stages. */
function causeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/**
 * Sends a step's outcome on its task token. A dead token on an aborted execution means it was
 * stopped while the step ran (a newer push, or the PR closed), so no later step will record
 * the run's outcome: `abandoned` does. On a running execution it's this attempt's own timeout,
 * and the retry reports instead.
 */
async function report(
  deps: StepDeps,
  executionArn: string,
  send: () => Promise<void>,
  abandoned: () => Promise<void>,
): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (!isDeadToken(error)) throw error;
    const status = await confirmedStatus(deps, executionArn);
    if (status === STATUS_UNKNOWN) {
      // Can't tell whether to mark the run: fail the task, and leave the run to MarkFailed or
      // the dispatcher.
      deps.log("task token dead, and the execution's status unknown", { executionArn });
      throw error;
    }
    if (status !== "ABORTED") {
      // Running: this attempt timed out and a retry reports. Ended any other way: the
      // execution's own steps recorded how.
      deps.log("task token no longer counts", { executionArn, status });
      return;
    }
    await abandoned();
    deps.log("execution stopped during the step", { executionArn });
  }
}

/** A retry has the step: this attempt reports nothing. The process exits with its work. */
function gaveUp(deps: StepDeps, executionArn: string): void {
  deps.log("gave up the step: a retry has taken over", { executionArn });
}

/**
 * Runs one workflow step. Prepare and post report back through their task tokens, so a failure
 * there is sent as a task failure (the state machine retries or takes the failure path) and
 * not thrown; fail throws, which fails its ECS task.
 *
 * Post waits for its task token rather than running as `.sync`, so stopping the execution
 * doesn't kill a post halfway through: it finishes, and the review it posts is for an older
 * head, which the next run's review follows.
 */
export async function runCommand(
  deps: StepDeps,
  command: ControlCommand,
  settings: ReviewSettings,
): Promise<void> {
  const { executionArn } = command;
  switch (command.command) {
    case "prepare": {
      let output;
      let failure: unknown;
      try {
        // A bootstrap (NIC-1080) runs on the review workflow with its own job.
        const input: unknown = JSON.parse(command.job);
        output = isBootstrapInput(input)
          ? await withHeartbeat(deps, executionArn, command.taskToken, () =>
              prepareBootstrap(deps, input, settings),
            )
          : await (async () => {
              const job = parseJob(command.job);
              return withHeartbeat(deps, executionArn, command.taskToken, () =>
                prepare(deps, job, executionArn, settings),
              );
            })();
      } catch (error) {
        if (error instanceof StepAbandoned) return gaveUp(deps, executionArn);
        failure = error;
        deps.log("prepare failed", { executionArn, error: causeOf(error) });
      }
      const prepared = output;
      await report(
        deps,
        executionArn,
        () =>
          prepared === undefined
            ? deps.tokens.fail(command.taskToken, PREPARE_FAILED, causeOf(failure))
            : deps.tokens.succeed(command.taskToken, prepared),
        () =>
          prepared === undefined
            ? deps.runs.failRun(executionArn, PREPARE_FAILED)
            : deps.runs.supersedeRun(prepared.runId),
      );
      return;
    }
    case "post": {
      let failure: unknown;
      try {
        const running = async () => (await deps.executionStatus(executionArn)) === "RUNNING";
        const bootstrap = (await deps.bootstrap?.store.get(command.runId)) !== undefined;
        await withHeartbeat(deps, executionArn, command.taskToken, async () =>
          bootstrap
            ? postBootstrap(deps, command.runId)
            : post(deps, command.runId, {
                running,
                attempt: { id: randomUUID(), taskArn: await deps.taskArn() },
                taskStatus: (taskArn) => deps.taskStatus(taskArn),
                executionStatus: (arn) => deps.executionStatus(arn),
              }),
        );
      } catch (error) {
        if (error instanceof StepAbandoned) return gaveUp(deps, executionArn);
        failure = error;
        deps.log("post failed", { executionArn, error: causeOf(error) });
      }
      await report(
        deps,
        executionArn,
        () =>
          failure === undefined
            ? deps.tokens.succeed(command.taskToken, {})
            : deps.tokens.fail(command.taskToken, POST_FAILED, causeOf(failure)),
        // A finished post recorded its run; a failed one leaves it for this to fail.
        () =>
          failure === undefined ? Promise.resolve() : deps.runs.failRun(executionArn, POST_FAILED),
      );
      return;
    }
    case "fail":
      await fail(deps, executionArn, command.error);
      return;
  }
}
