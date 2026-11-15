import type { ControlDeps } from "./ports.js";

/** Longest error kept on the run. */
const MAX_ERROR = 500;

/**
 * The failure path: marks the execution's run failed and posts nothing, so a broken run never
 * leaves a partial review on the PR. `error` is the Step Functions error name of the step that
 * failed (such as `States.TaskFailed`), never its cause: an ECS task's cause describes the task,
 * overrides and presigned URLs included.
 */
export async function fail(deps: ControlDeps, executionArn: string, error: string): Promise<void> {
  const text = error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error;
  await deps.runs.failRun(executionArn, text);
  // A bootstrap's execution (NIC-1080) has no review run: its bootstrap is failed instead.
  await deps.bootstrap?.store.failByExecution(executionArn, text);
  deps.log("failed", { executionArn, error: text });
}
