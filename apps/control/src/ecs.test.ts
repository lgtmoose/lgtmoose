import type { DescribeTasksCommand } from "@aws-sdk/client-ecs";
import { describe, expect, it, vi } from "vitest";
import { TASK_MISSING, currentTaskArn, taskStatus } from "./ecs.js";

const ARN = "arn:aws:ecs:eu-west-1:123456789012:task/lgtmoose-cluster/abc123";

describe("taskStatus", () => {
  it("asks the task's own cluster and gives its last status", async () => {
    const send = vi.fn(async (_command: DescribeTasksCommand) => ({
      tasks: [{ taskArn: ARN, lastStatus: "STOPPED" }],
    }));
    expect(await taskStatus({ send }, ARN)).toBe("STOPPED");
    expect(send.mock.calls[0]?.[0].input).toEqual({ cluster: "lgtmoose-cluster", tasks: [ARN] });
  });

  it("says MISSING for a task ECS doesn't know, and throws when it says nothing", async () => {
    const missing = vi.fn(async () => ({ tasks: [], failures: [{ arn: ARN, reason: "MISSING" }] }));
    expect(await taskStatus({ send: missing }, ARN)).toBe(TASK_MISSING);
    const silent = vi.fn(async () => ({ tasks: [] }));
    await expect(taskStatus({ send: silent }, ARN)).rejects.toThrow();
    await expect(taskStatus({ send: silent }, "not-an-arn")).rejects.toThrow("task ARN");
  });
});

describe("currentTaskArn", () => {
  it("reads the task ARN from the metadata endpoint, or undefined off ECS", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ TaskARN: ARN })));
    expect(await currentTaskArn({ ECS_CONTAINER_METADATA_URI_V4: "http://meta" }, fetchFn)).toBe(
      ARN,
    );
    expect(fetchFn).toHaveBeenCalledWith("http://meta/task", expect.anything());
    expect(await currentTaskArn({}, fetchFn)).toBeUndefined();
  });
});
