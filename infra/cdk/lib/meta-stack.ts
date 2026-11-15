import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { Topic, type ITopic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DeployConfig } from "@lgtmoose/config";

export interface MetaStackProps extends StackProps {
  version: string;
  /** Where alarms notify (`alarms` in the deploy config). */
  alarms: DeployConfig["alarms"];
}

/**
 * Records which LGTMoose version is deployed, so `lgtmoose deploy` can warn when a checkout is
 * behind the latest release (NIC-847). Also holds the alarm topic, when one is configured: every
 * stack's alarms notify it (`buildApp`).
 */
export class MetaStack extends Stack {
  /** The topic alarms notify, or undefined when `alarms` sets neither an email nor a topic. */
  readonly alarmTopic: ITopic | undefined;

  constructor(scope: Construct, id: string, props: MetaStackProps) {
    super(scope, id, props);

    new StringParameter(this, "Version", {
      parameterName: "/lgtmoose/version",
      stringValue: props.version,
      description: "Deployed LGTMoose version",
    });

    if (props.alarms.topicArn !== undefined) {
      this.alarmTopic = Topic.fromTopicArn(this, "AlarmTopic", props.alarms.topicArn);
    } else if (props.alarms.email !== undefined) {
      // Not encrypted with the AWS-managed SNS key: CloudWatch can't publish to a topic using it.
      // Alarm notifications carry the alarm's name and state, nothing from a review.
      const topic = new Topic(this, "AlarmTopic", { displayName: "LGTMoose alarms" });
      topic.addSubscription(new EmailSubscription(props.alarms.email));
      this.alarmTopic = topic;
    }
    if (this.alarmTopic !== undefined) {
      new CfnOutput(this, "AlarmTopicArn", { value: this.alarmTopic.topicArn });
    }
  }
}
