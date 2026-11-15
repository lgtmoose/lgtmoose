import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { appJwt, GitHubClient, installationTokenProvider } from "@lgtmoose/poster";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { drizzleConversationStore, githubConversation, sqsJobQueue } from "./conversation-aws.js";
import { handleConversation, type ConversationDeps } from "./conversation.js";
import { databasePool, parseSecret, readSecret } from "./database.js";
import { parseQueuedJob, type DispatchJob, type QueueRecord } from "./dispatch.js";
import { readConversationEnv } from "./env.js";
import { log } from "./log.js";

/**
 * The conversation Lambda, fed by the conversation queue (FIFO, one message group per PR) that
 * the dispatcher forwards comment jobs to. It holds the GitHub App's credentials, to read the
 * comment and answer it, and the database. It holds no model credential and can't start or
 * stop executions: a review a command asks for goes on the job queue, as a push's would.
 */

/** Each GitHub call gives up after this long; the Lambda's own timeout bounds the whole job. */
const GITHUB_TIMEOUT_MS = 20_000;

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

let deps: Promise<ConversationDeps> | undefined;

/** Built once per container: the pool outlives invocations. */
function conversationDeps(): Promise<ConversationDeps> {
  deps ??= (async () => {
    const env = readConversationEnv(process.env);
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
    // The App's slug, read once with its own JWT: the bot is `@<slug>`.
    let slugOnce: Promise<string> | undefined;
    const slug = () => {
      slugOnce ??= new GitHubClient({
        token: async () => appJwt(app.appId, app.privateKey),
        timeoutMs: GITHUB_TIMEOUT_MS,
      })
        .request<{ slug?: unknown }>("GET", "/app")
        .then((reply) => {
          if (typeof reply.slug !== "string") throw new Error("GET /app returned no slug.");
          return reply.slug;
        });
      slugOnce.catch(() => {
        slugOnce = undefined;
      });
      return slugOnce;
    };
    return {
      async github(installationId: number) {
        const token = installationTokenProvider({
          appId: app.appId,
          privateKey: app.privateKey,
          installationId,
          timeoutMs: GITHUB_TIMEOUT_MS,
        });
        const client = new GitHubClient({ token, timeoutMs: GITHUB_TIMEOUT_MS });
        return githubConversation(client, slug, log);
      },
      store: drizzleConversationStore(db),
      learnings: drizzleLearningStore(db),
      queue: sqsJobQueue(new SQSClient({}), env.jobQueueUrl),
      shadow: env.shadow,
      log,
    };
  })().catch((error: unknown) => {
    // Try again on the next invocation rather than keep a failed setup.
    deps = undefined;
    throw error;
  });
  return deps;
}

/**
 * Handles a batch in order. A failed message is returned for redelivery with every later
 * message of its PR, which must not overtake it; other PRs go on. A message that isn't a job
 * can't succeed on a retry, so it's logged and dropped (the dispatcher validated it before
 * forwarding, so this doesn't happen in practice).
 */
export async function conversationBatch(
  deps: ConversationDeps,
  records: readonly QueueRecord[],
): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failedGroups = new Set<string>();
  const failures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    const group = record.attributes?.MessageGroupId ?? "";
    const held =
      group === "" ? failedGroups.size > 0 : failedGroups.has(group) || failedGroups.has("");
    if (held) {
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }
    let job: DispatchJob;
    try {
      job = parseQueuedJob(record.body);
    } catch (error) {
      deps.log("invalid conversation job dropped", {
        messageId: record.messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      const result = await handleConversation(deps, job);
      deps.log("conversation", {
        messageId: record.messageId,
        deliveryId: job.deliveryId,
        repo: job.repo,
        prNumber: job.prNumber,
        kind: job.kind,
        ...result,
      });
    } catch (error) {
      deps.log("conversation failed", {
        messageId: record.messageId,
        deliveryId: job.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      });
      failedGroups.add(group);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export async function handler(event: {
  Records: QueueRecord[];
}): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  return conversationBatch(await conversationDeps(), event.Records);
}
