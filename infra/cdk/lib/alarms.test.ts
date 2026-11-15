import { Template } from "aws-cdk-lib/assertions";
import { parseDeployConfig, type DeployConfigInput } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Profile } from "./network-stack.js";
import { appWithoutBundling } from "./test-utils.js";

const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:team-pager";

function synth(profile: Profile, alarms?: DeployConfigInput["alarms"]) {
  const config = parseDeployConfig({
    profile,
    allowedOrgs: ["lgtmoose"],
    providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
    ...(alarms === undefined ? {} : { alarms }),
  });
  const stacks = buildApp(config, appWithoutBundling());
  const templates = {
    meta: Template.fromStack(stacks.meta),
    data: Template.fromStack(stacks.data),
    api: Template.fromStack(stacks.api),
    workflow: Template.fromStack(stacks.workflow),
  };
  const alarmsIn = Object.values(templates).flatMap((template) =>
    Object.entries(template.findResources("AWS::CloudWatch::Alarm")),
  );
  return { templates, alarms: alarmsIn };
}

describe("alarm notifications", () => {
  it("without `alarms`, no topic is created and alarms notify nothing", () => {
    const { templates, alarms } = synth("standard");
    templates.meta.resourceCountIs("AWS::SNS::Topic", 0);
    expect(alarms.length).toBeGreaterThan(0);
    for (const [id, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions, id).toBeUndefined();
    }
  });

  it.each<Profile>(["lean", "standard"])(
    "%s: with an email, every alarm in every stack notifies one new topic",
    (profile) => {
      const { templates, alarms } = synth(profile, { email: "oncall@example.com" });
      templates.meta.resourceCountIs("AWS::SNS::Topic", 1);
      templates.meta.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "oncall@example.com",
      });
      expect(alarms.length).toBeGreaterThan(0);
      for (const [id, alarm] of alarms) {
        expect(alarm.Properties?.AlarmActions, id).toHaveLength(1);
        // A cross-stack reference to the Meta stack's topic.
        expect(JSON.stringify(alarm.Properties?.AlarmActions), id).toContain("AlarmTopic");
      }
    },
  );

  it("with a topic ARN, alarms notify it and no topic is created", () => {
    const { templates, alarms } = synth("lean", { topicArn: TOPIC_ARN });
    templates.meta.resourceCountIs("AWS::SNS::Topic", 0);
    for (const [id, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions, id).toEqual([TOPIC_ARN]);
    }
  });

  it("refuses an email and a topic ARN together, and a malformed ARN", () => {
    const base = {
      allowedOrgs: ["lgtmoose"],
      providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
    } as const;
    expect(() =>
      parseDeployConfig({ ...base, alarms: { email: "a@example.com", topicArn: TOPIC_ARN } }),
    ).toThrow(/not both/);
    expect(() => parseDeployConfig({ ...base, alarms: { topicArn: "team-pager" } })).toThrow(
      /SNS topic ARN/,
    );
    expect(() => parseDeployConfig({ ...base, alarms: { email: "not an email" } })).toThrow();
  });

  it("standard alarms on failed review executions; lean doesn't", () => {
    const failures = (profile: Profile) =>
      Object.keys(synth(profile).templates.workflow.findResources("AWS::CloudWatch::Alarm")).filter(
        (id) => id.startsWith("ReviewFailuresAlarm"),
      );
    expect(failures("standard")).toHaveLength(1);
    expect(failures("lean")).toHaveLength(0);
    synth("standard").templates.workflow.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ExecutionsFailed",
      Namespace: "AWS/States",
      Threshold: 3,
    });
  });
});
