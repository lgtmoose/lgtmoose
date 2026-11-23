import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SQSClient } from "@aws-sdk/client-sqs";
import { BOOTSTRAP_REQUEST_PREFIX } from "@lgtmoose/config";
import { BOOTSTRAP_DEFAULTS } from "./bootstrap.js";
import {
  bootstrapRequestFileSchema,
  type BootstrapRequestFile,
  type BootstrapStarter,
} from "./bootstrap-start.js";
import { drizzleBootstrapStore } from "./bootstrap-store.js";
import {
  drizzleLearningStore,
  retireUnusedLearnings,
  type LearningStore,
} from "@lgtmoose/learnings";
import { STALE_RESERVATION_MS, postgresSpend } from "@lgtmoose/db";
import type { Budgets } from "@lgtmoose/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { databasePool, parseSecret, readSecret } from "./database.js";
import { GitHubClient, installationTokenProvider } from "@lgtmoose/poster";
import {
  readBootstrapMaxCost,
  readMaxPendingLearnings,
  readReconcileEnv,
  readRepeatThreshold,
} from "./env.js";
import { drizzleAnswerLearningStore, outcomeLearner } from "./outcome-learning-aws.js";
import { learnFromAnswers, type AnswerLearningDeps } from "./finding-answers.js";
import { collectFeedback, type FeedbackDeps } from "./feedback.js";
import { drizzleFeedbackStore, githubFeedback } from "./feedback-aws.js";
import { log } from "./log.js";
import { metricsLine, reconcile, type ReconcileCounts, type ReconcileDeps } from "./reconcile.js";
import { drizzleReconcileStore, githubReconcile, sqsReconcileQueue } from "./reconcile-aws.js";
import { s3ArtifactStore } from "./s3-store.js";
import { readBudgets, settleStaleSpend, type SpendStore } from "./spend.js";

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

type LambdaDeps = ReconcileDeps & {
  learnings: LearningStore;
  /** Undefined without an artifact bucket to write the report to. */
  feedback: FeedbackDeps | undefined;
  /**
   * The spend ledger and the batch outputs (read-only), to settle runs post never reached
   * (NIC-1079). Without a bucket, such runs settle at their estimate.
   */
  spend: { store: SpendStore; budgets: Budgets };
  runOutputs: { getText(key: string): Promise<string | undefined> };
  /** Findings declined from the CLI or the dashboard, for outcome learning (NIC-1140). */
  answers: AnswerLearningDeps;
};

let deps: Promise<LambdaDeps> | undefined;

/** Requests taken in per run, at most. */
const REQUESTS_PER_RUN = 20;

/**
 * Takes the CLI's bootstrap requests out of the artifact bucket: each valid one is returned, and
 * every one read is deleted, so a bad request isn't read again.
 */
export async function takeBootstrapRequests(
  s3: Pick<S3Client, "send">,
  bucket: string,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<BootstrapRequestFile[]> {
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: BOOTSTRAP_REQUEST_PREFIX,
      MaxKeys: REQUESTS_PER_RUN,
    }),
  );
  const requests: BootstrapRequestFile[] = [];
  for (const object of listed.Contents ?? []) {
    if (object.Key === undefined) continue;
    try {
      const reply = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      const text = (await reply.Body?.transformToString("utf8")) ?? "";
      const parsed = bootstrapRequestFileSchema.safeParse(JSON.parse(text));
      if (parsed.success) requests.push(parsed.data);
      else log("bootstrap request ignored: not valid", { key: object.Key });
    } catch {
      log("bootstrap request ignored: unreadable", { key: object.Key });
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
  }
  return requests;
}

/** Built once per container: the pool outlives invocations. */
function reconcileDeps(): Promise<LambdaDeps> {
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
    const bucket = env.artifactBucket;
    const s3 = new S3Client({});
    const maxPending = readMaxPendingLearnings(process.env);
    const repeatThreshold = readRepeatThreshold(process.env);
    const outcomes = outcomeLearner({
      db,
      learnings: drizzleLearningStore(db),
      client: (installationId) =>
        new GitHubClient({
          token: installationTokenProvider({
            ...app,
            installationId,
            timeoutMs: GITHUB_TIMEOUT_MS,
          }),
          timeoutMs: GITHUB_TIMEOUT_MS,
        }),
      ...(maxPending === undefined ? {} : { maxPendingPerAuthor: maxPending }),
      ...(repeatThreshold === undefined ? {} : { repeatThreshold }),
      log,
    });
    const feedback: FeedbackDeps | undefined =
      bucket === undefined
        ? undefined
        : {
            store: drizzleFeedbackStore(db),
            github: githubFeedback(app, { timeoutMs: GITHUB_TIMEOUT_MS }),
            async putReport(key, body) {
              await s3.send(
                new PutObjectCommand({
                  Bucket: bucket,
                  Key: key,
                  Body: body,
                  ContentType: "application/json",
                }),
              );
            },
            log,
            maxComments: env.feedback.maxComments,
            threshold: env.feedback.threshold,
            minSamples: env.feedback.minSamples,
            // A comment newly 👎'd may complete a repeated rejection (NIC-1081).
            onRejected: (comment) =>
              outcomes.rejected(comment.installationId, comment.repo, [
                { findingId: comment.findingId },
              ]),
          };
    // Bootstraps from review history (NIC-1080): started on the review workflow, with the CLI's
    // requests taken from the artifact bucket.
    const stateMachineArn = env.stateMachineArn;
    const sfn = new SFNClient({});
    const bootstraps: BootstrapStarter | undefined =
      stateMachineArn === undefined
        ? undefined
        : {
            store: drizzleBootstrapStore(db),
            async startExecution(name, input) {
              const started = await sfn.send(
                new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }),
              );
              if (started.executionArn === undefined) {
                throw new Error("StartExecution returned no execution ARN.");
              }
              return started.executionArn;
            },
            ...(bucket === undefined
              ? {}
              : { incoming: () => takeBootstrapRequests(s3, bucket, log) }),
            maxCostUsd: readBootstrapMaxCost(process.env) ?? BOOTSTRAP_DEFAULTS.maxCostUsd,
          };
    return {
      feedback,
      answers: {
        store: drizzleAnswerLearningStore(db),
        rejected: (installationId: number, repo: string, rejected) =>
          outcomes.rejected(installationId, repo, rejected),
        log,
      } satisfies AnswerLearningDeps,
      ...(bootstraps === undefined ? {} : { bootstraps }),
      spend: { store: postgresSpend(db), budgets: readBudgets(process.env) },
      runOutputs:
        bucket === undefined ? { getText: async () => undefined } : s3ArtifactStore(s3, bucket),
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
  // Feedback signals (NIC-841): reactions on our comments, and the acceptance report. Signals
  // only; a failure is logged and counted, never thrown.
  if (ready.feedback !== undefined) {
    const feedback = await collectFeedback(ready.feedback);
    counts.feedbackCommentsRead = feedback.feedbackCommentsRead;
    counts.categoriesFlagged = feedback.categoriesFlagged;
    counts.errors += feedback.errors;
  }
  // Findings declined from the CLI or the dashboard (NIC-1140): outcome learning, as a decline
  // on a thread gets. A failure is logged and counted, never thrown.
  try {
    await learnFromAnswers(ready.answers);
  } catch (error) {
    counts.errors += 1;
    log("reconcile: answers not learned from", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Spend caps (NIC-1079): runs a newer push stopped, or that failed after their batches ran,
  // are settled at what their batches reported. Logged, never thrown.
  await settleStaleSpend(ready.spend, ready.runOutputs, new Date(), log, STALE_RESERVATION_MS);
  process.stdout.write(`${metricsLine(counts, new Date())}\n`);
  return counts;
}
