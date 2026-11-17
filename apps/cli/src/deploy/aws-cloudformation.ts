import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { awsError } from "../aws-errors.js";

/** A stack's status and outputs. */
export interface StackInfo {
  status: string;
  outputs: Record<string, string>;
}

/** The only CloudFormation calls the CLI makes. Tests fake them. */
export interface StackLookup {
  /** The stack, or undefined when it doesn't exist. */
  describe(stackName: string): Promise<StackInfo | undefined>;
  /**
   * Physical ids of the stack's resources of one type. Works when the stack has no outputs, as
   * after a create that failed and couldn't roll back.
   */
  physicalIds(stackName: string, resourceType: string): Promise<string[]>;
}

export interface CloudFormationSender {
  send(command: DescribeStacksCommand | DescribeStackResourcesCommand): Promise<{
    Stacks?:
      | {
          StackStatus?: string | undefined;
          Outputs?:
            { OutputKey?: string | undefined; OutputValue?: string | undefined }[] | undefined;
        }[]
      | undefined;
    StackResources?:
      { ResourceType?: string | undefined; PhysicalResourceId?: string | undefined }[] | undefined;
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
        throw awsError("CloudFormation", region, stackName, error);
      }
    },
    async physicalIds(stackName, resourceType) {
      try {
        const output = await client.send(
          new DescribeStackResourcesCommand({ StackName: stackName }),
        );
        return (output.StackResources ?? [])
          .filter((resource) => resource.ResourceType === resourceType)
          .flatMap((resource) => resource.PhysicalResourceId ?? []);
      } catch (error) {
        if (error instanceof Error && /does not exist/.test(error.message)) return [];
        throw awsError("CloudFormation", region, stackName, error);
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
