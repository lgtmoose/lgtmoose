import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient } from "@aws-sdk/client-sfn";
import { drizzle } from "drizzle-orm/node-postgres";
import { databasePool } from "./database.js";
import { drizzleDispatchStore, sfnExecutions } from "./dispatch-aws.js";
import { dispatchBatch, type DispatchDeps, type QueueRecord } from "./dispatch.js";
import { readDispatchEnv } from "./env.js";
import { log } from "./log.js";

/**
 * The dispatcher Lambda, fed by the job queue (FIFO, batches with partial failures). It runs in
 * the VPC with the control security group, for the database; it holds no GitHub credential.
 */

let deps: Promise<DispatchDeps> | undefined;

/** Built once per container: the pool outlives invocations. */
function dispatchDeps(): Promise<DispatchDeps> {
  deps ??= (async () => {
    const env = readDispatchEnv(process.env);
    if ("missing" in env) {
      throw new Error(`Missing environment variables: ${env.missing.join(", ")}`);
    }
    const pool = await databasePool(
      new SecretsManagerClient({}),
      env.databaseSecretArn,
      env.databaseName,
      1,
    );
    // An idle connection can drop while the container is frozen. Without a listener, the
    // pool's error event would crash the process; the next query reconnects instead.
    pool.on("error", (error) => log("database connection dropped", { error: error.message }));
    return {
      executions: sfnExecutions(new SFNClient({}), env.stateMachineArn),
      store: drizzleDispatchStore(drizzle({ client: pool })),
      log,
    };
  })().catch((error: unknown) => {
    // Try again on the next invocation rather than keep a failed setup.
    deps = undefined;
    throw error;
  });
  return deps;
}

export async function handler(event: {
  Records: QueueRecord[];
}): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  return dispatchBatch(await dispatchDeps(), event.Records);
}
