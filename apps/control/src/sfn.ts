import {
  DescribeExecutionCommand,
  SendTaskHeartbeatCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";

/** The status of an execution by ARN, or undefined when there's no such execution. */
export async function describeStatus(
  client: Pick<SFNClient, "send">,
  executionArn: string,
): Promise<string | undefined> {
  try {
    const reply = await client.send(new DescribeExecutionCommand({ executionArn }));
    return reply.status;
  } catch (error) {
    if (error instanceof Error && error.name === "ExecutionDoesNotExist") return undefined;
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
