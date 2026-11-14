import { DescribeTasksCommand, type ECSClient } from "@aws-sdk/client-ecs";

/** What `taskStatus` says of a task ECS doesn't know (any more): it isn't running. */
export const TASK_MISSING = "MISSING";

/**
 * An ECS task's last status (PROVISIONING, RUNNING, STOPPED…), or TASK_MISSING. The cluster
 * is read from the task ARN (`arn:…:task/<cluster>/<id>`).
 */
export async function taskStatus(
  client: Pick<ECSClient, "send">,
  taskArn: string,
): Promise<string> {
  const cluster = /:task\/([^/]+)\/[^/]+$/.exec(taskArn)?.[1];
  if (cluster === undefined) throw new Error(`Not a task ARN with a cluster: ${taskArn}`);
  const reply = await client.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
  const task = reply.tasks?.find((candidate) => candidate.taskArn === taskArn);
  if (task?.lastStatus !== undefined) return task.lastStatus;
  if (reply.failures?.some((failure) => failure.reason === "MISSING")) return TASK_MISSING;
  throw new Error(`DescribeTasks said nothing about ${taskArn}.`);
}

/**
 * This task's ARN, from the ECS task metadata endpoint (version 4), or undefined when not on
 * ECS. A review claim names it, so a later attempt can tell whether the claimer still runs.
 */
export async function currentTaskArn(
  env: Readonly<Record<string, string | undefined>>,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  const uri = env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!uri) return undefined;
  const response = await fetchFn(`${uri}/task`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`The task metadata endpoint answered ${response.status}.`);
  const body = (await response.json()) as { TaskARN?: unknown };
  if (typeof body.TaskARN !== "string") throw new Error("The task metadata has no TaskARN.");
  return body.TaskARN;
}
