import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

/** A stack's status and outputs. */
export interface StackInfo {
  status: string;
  outputs: Record<string, string>;
}

/** The only CloudFormation call the CLI makes. Tests fake it. */
export interface StackLookup {
  /** The stack, or undefined when it doesn't exist. */
  describe(stackName: string): Promise<StackInfo | undefined>;
}

export interface CloudFormationSender {
  send(command: DescribeStacksCommand): Promise<{
    Stacks?:
      | {
          StackStatus?: string | undefined;
          Outputs?:
            { OutputKey?: string | undefined; OutputValue?: string | undefined }[] | undefined;
        }[]
      | undefined;
  }>;
}

export function cloudFormationLookup(client: CloudFormationSender, region: string): StackLookup {
  return {
    async describe(stackName) {
      try {
        const output = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = output.Stacks?.[0];
        if (stack?.StackStatus === undefined) return undefined;
        const outputs: Record<string, string> = {};
        for (const { OutputKey, OutputValue } of stack.Outputs ?? []) {
          if (OutputKey !== undefined && OutputValue !== undefined)
            outputs[OutputKey] = OutputValue;
        }
        return { status: stack.StackStatus, outputs };
      } catch (error) {
        // DescribeStacks reports a missing stack as a ValidationError.
        if (error instanceof Error && /does not exist/.test(error.message)) return undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`AWS CloudFormation (${region}) failed on ${stackName}: ${message}`, {
          cause: error,
        });
      }
    },
  };
}

export function createStackLookup(region: string): StackLookup {
  return cloudFormationLookup(new CloudFormationClient({ region }), region);
}

/**
 * Whether CloudFormation can update the stack: it finished its last operation and still has
 * resources. Failed, in-progress, rolled-back-on-create and deleted stacks can't be updated.
 */
export function isUpdatable(status: string | undefined): boolean {
  return (
    status !== undefined &&
    status.endsWith("_COMPLETE") &&
    status !== "DELETE_COMPLETE" &&
    status !== "ROLLBACK_COMPLETE"
  );
}
