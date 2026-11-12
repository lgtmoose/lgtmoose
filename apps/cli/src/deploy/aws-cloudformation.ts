import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

/** The CDK's bootstrap stack. One per account and region. */
export const BOOTSTRAP_STACK = "CDKToolkit";

/** The only CloudFormation call the CLI makes. Tests fake it. */
export interface StackLookup {
  /** The stack's status, or undefined when it doesn't exist. */
  status(stackName: string): Promise<string | undefined>;
}

export interface CloudFormationSender {
  send(
    command: DescribeStacksCommand,
  ): Promise<{ Stacks?: { StackStatus?: string | undefined }[] | undefined }>;
}

export function cloudFormationLookup(client: CloudFormationSender, region: string): StackLookup {
  return {
    async status(stackName) {
      try {
        const output = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        return output.Stacks?.[0]?.StackStatus;
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

/** A stack that's gone, or never finished creating, can be deployed over. */
export function isUsable(status: string | undefined): boolean {
  return (
    status !== undefined &&
    status !== "DELETE_COMPLETE" &&
    status !== "ROLLBACK_COMPLETE" &&
    status !== "REVIEW_IN_PROGRESS"
  );
}
