import {
  ListExecutionsCommand,
  StartExecutionCommand,
  StopExecutionCommand,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import type { Executions, RunningExecution } from "./dispatch.js";

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** The review state machine over Step Functions. */
export function sfnExecutions(
  client: Pick<SFNClient, "send">,
  stateMachineArn: string,
): Executions {
  return {
    async start(name, input) {
      try {
        const reply = await client.send(
          new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }),
        );
        if (!reply.executionArn) throw new Error("StartExecution returned no execution ARN.");
        return { started: true, executionArn: reply.executionArn };
      } catch (error) {
        if (errorName(error) !== "ExecutionAlreadyExists") throw error;
        // The ARN of a named execution is the state machine's with `stateMachine` swapped.
        return { started: false, executionArn: executionArnOf(stateMachineArn, name) };
      }
    },
    async running(prefix) {
      const found: RunningExecution[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListExecutionsCommand({
            stateMachineArn,
            statusFilter: "RUNNING",
            maxResults: 1000,
            nextToken,
          }),
        );
        for (const execution of page.executions ?? []) {
          if (execution.name?.startsWith(prefix) && execution.executionArn) {
            found.push({ name: execution.name, executionArn: execution.executionArn });
          }
        }
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
      return found;
    },
    async stop(executionArn, cause) {
      try {
        await client.send(new StopExecutionCommand({ executionArn, cause }));
      } catch (error) {
        if (errorName(error) !== "ExecutionDoesNotExist") throw error;
      }
    },
  };
}

/** `arn:…:states:region:account:stateMachine:Name` → `…:execution:Name:<name>`. */
export function executionArnOf(stateMachineArn: string, name: string): string {
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${name}`;
}
