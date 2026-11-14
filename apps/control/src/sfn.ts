import {
  DescribeExecutionCommand,
  SendTaskHeartbeatCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";

/** An AWS SDK error's name (`ExecutionDoesNotExist`, `TaskTimedOut`…), if it is an error. */
export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * What Step Functions answers a task token that no longer counts: its task timed out (and may
 * be running again as a retry), or its execution ended or was stopped.
 */
const DEAD_TOKEN_ERRORS = new Set(["TaskTimedOut", "TaskDoesNotExist", "InvalidToken"]);

export function isDeadToken(error: unknown): boolean {
  return DEAD_TOKEN_ERRORS.has(errorName(error) ?? "");
}

/** The status of an execution by ARN, or undefined when there's no such execution. */
export async function describeStatus(
  client: Pick<SFNClient, "send">,
  executionArn: string,
): Promise<string | undefined> {
  try {
    const reply = await client.send(new DescribeExecutionCommand({ executionArn }));
    return reply.status;
  } catch (error) {
    if (errorName(error) === "ExecutionDoesNotExist") return undefined;
    throw error;
  }
}

/** Tells Step Functions the task behind `taskToken` is still working. */
export async function sendHeartbeat(
  client: Pick<SFNClient, "send">,
  taskToken: string,
): Promise<void> {
  await client.send(new SendTaskHeartbeatCommand({ taskToken }));
}
