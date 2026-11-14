import type { ControlCommand, ReviewSettings } from "./env.js";
import { fail } from "./fail.js";
import { parseJob } from "./job.js";
import type { ControlDeps } from "./ports.js";
import { post } from "./post.js";
import { prepare } from "./prepare.js";

/** The task-token error for a prepare step that failed, as the state machine's catch sees it. */
export const PREPARE_FAILED = "Lgtmoose.PrepareFailed";
/** The task-token error for a post step that failed. */
export const POST_FAILED = "Lgtmoose.PostFailed";

/**
 * What Step Functions answers a task token that no longer counts: its task timed out (and may
 * be running again as a retry), or its execution ended or was stopped.
 */
const DEAD_TOKEN_ERRORS = new Set(["TaskTimedOut", "TaskDoesNotExist", "InvalidToken"]);

/** What a step needs besides the control task's dependencies. */
export interface StepDeps extends ControlDeps {
  /** The execution's status (RUNNING, ABORTED…), or undefined when there's no such execution. */
  executionStatus(executionArn: string): Promise<string | undefined>;
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
    if (!(error instanceof Error && DEAD_TOKEN_ERRORS.has(error.name))) throw error;
    const status = await deps.executionStatus(executionArn);
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
        output = await prepare(deps, parseJob(command.job), executionArn, settings);
      } catch (error) {
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
        await post(deps, command.runId);
      } catch (error) {
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
