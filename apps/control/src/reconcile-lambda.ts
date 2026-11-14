import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import {
  drizzleLearningStore,
  retireUnusedLearnings,
  type LearningStore,
} from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { databasePool, parseSecret, readSecret } from "./database.js";
import { readReconcileEnv } from "./env.js";
import { log } from "./log.js";
import { metricsLine, reconcile, type ReconcileCounts, type ReconcileDeps } from "./reconcile.js";
import { drizzleReconcileStore, githubReconcile, sqsReconcileQueue } from "./reconcile-aws.js";

/**
 * The reconciler Lambda, run on a schedule (EventBridge Scheduler). It runs in the VPC with the
 * control security group, for the database, and reaches GitHub as the App; it holds no model
 * credential and makes no model calls. Each run logs its counts as CloudWatch metrics.
 */

/** Each GitHub call gives up after this long; the Lambda's own timeout bounds the whole run. */
const GITHUB_TIMEOUT_MS = 30_000;

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

let deps: Promise<ReconcileDeps & { learnings: LearningStore }> | undefined;

/** Built once per container: the pool outlives invocations. */
function reconcileDeps(): Promise<ReconcileDeps & { learnings: LearningStore }> {
  deps ??= (async () => {
    const env = readReconcileEnv(process.env);
    if ("missing" in env) {
      throw new Error(`Missing environment variables: ${env.missing.join(", ")}`);
    }
    const secrets = new SecretsManagerClient({});
    const app = parseSecret(
      appSecretSchema,
      await readSecret(secrets, env.githubAppSecretArn),
      "GitHub App",
    );
    const pool = await databasePool(secrets, env.databaseSecretArn, env.databaseName, 1);
    // An idle connection can drop while the container is frozen; the next query reconnects.
    pool.on("error", (error) => log("database connection dropped", { error: error.message }));
    const db = drizzle({ client: pool });
    return {
      github: githubReconcile(app, { timeoutMs: GITHUB_TIMEOUT_MS }),
      store: drizzleReconcileStore(db),
      learnings: drizzleLearningStore(db),
      queue: sqsReconcileQueue(new SQSClient({}), env.jobQueueUrl),
      allowedOrgs: env.allowedOrgs,
      shadow: env.shadow,
      lookbackMs: env.lookbackHours * 3_600_000,
      log,
    };
  })().catch((error: unknown) => {
    // Try again on the next invocation rather than keep a failed setup.
    deps = undefined;
    throw error;
  });
  return deps;
}

export async function handler(): Promise<ReconcileCounts> {
  const ready = await reconcileDeps();
  const counts = await reconcile(ready);
  // Learnings unused for 90 days are retired here too: a small, model-free upkeep step that
  // needs only the database. A failure is logged and counted, never thrown.
  try {
    counts.learningsRetired = await retireUnusedLearnings(ready.learnings);
  } catch (error) {
    counts.errors += 1;
    log("reconcile: unused learnings not retired", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  process.stdout.write(`${metricsLine(counts, new Date())}\n`);
  return counts;
}
