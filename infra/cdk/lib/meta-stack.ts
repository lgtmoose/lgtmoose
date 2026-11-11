import { Stack, type StackProps } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";

export interface MetaStackProps extends StackProps {
  version: string;
}

/**
 * Records which LGTMoose version is deployed, so `lgtmoose deploy` can warn when a
 * checkout is behind the latest release (NIC-847).
 */
export class MetaStack extends Stack {
  constructor(scope: Construct, id: string, props: MetaStackProps) {
    super(scope, id, props);

    new StringParameter(this, "Version", {
      parameterName: "/lgtmoose/version",
      stringValue: props.version,
      description: "Deployed LGTMoose version",
    });
  }
}
