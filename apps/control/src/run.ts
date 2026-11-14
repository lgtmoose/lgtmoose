import type { ControlCommand, ReviewSettings } from "./env.js";
import { fail } from "./fail.js";
import { parseJob } from "./job.js";
import type { ControlDeps } from "./ports.js";
import { post } from "./post.js";
import { prepare } from "./prepare.js";

/** The task-token error for a prepare step that failed, as the state machine's catch sees it. */
export const PREPARE_FAILED = "Lgtmoose.PrepareFailed";

/** What Step Functions answers a task token whose execution has ended or been stopped. */
const DEAD_TOKEN_ERRORS = new Set(["TaskTimedOut", "TaskDoesNotExist", "InvalidToken"]);

/** Message of an error, short, for the task token's cause. Never a credential: see the stages. */
function causeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

/**
 * Runs one workflow step. Prepare reports back through its task token, so a failure there is
 * sent as a task failure (the state machine retries or takes the failure path) and not thrown;
 * post and fail throw, which fails their ECS task.
 */
export async function runCommand(
  deps: ControlDeps,
  command: ControlCommand,
  settings: ReviewSettings,
): Promise<void> {
  switch (command.command) {
    case "prepare": {
      let report: () => Promise<void>;
      try {
        const job = parseJob(command.job);
        const output = await prepare(deps, job, command.executionArn, settings);
        report = () => deps.tokens.succeed(command.taskToken, output);
      } catch (error) {
        deps.log("prepare failed", { executionArn: command.executionArn, error: causeOf(error) });
        report = () => deps.tokens.fail(command.taskToken, PREPARE_FAILED, causeOf(error));
      }
      try {
        await report();
      } catch (error) {
        if (!(error instanceof Error && DEAD_TOKEN_ERRORS.has(error.name))) throw error;
        // The execution was stopped while this task ran (a newer push, or the PR closed), so
        // nothing will post or fail this run. Whoever stopped it may have looked before the
        // run existed.
        await deps.runs.supersedeExecutions([command.executionArn]);
        deps.log("execution stopped during prepare", { executionArn: command.executionArn });
      }
      return;
    }
    case "post":
      await post(deps, command.runId);
      return;
    case "fail":
      await fail(deps, command.executionArn, command.error);
      return;
  }
}
