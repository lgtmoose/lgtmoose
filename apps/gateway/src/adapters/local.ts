import type { JobQueue, WebhookSecretSource } from "../ports.js";

/** What the gateway needs of `PostgresQueue` in @lgtmoose/db: sending, nothing else. */
export interface QueueSender {
  send(message: { groupId: string; dedupeId: string; body: string }): Promise<boolean>;
}

/**
 * Jobs on the Postgres job queue (docker compose). It keeps SQS FIFO's guarantees: in order per
 * PR (the group), and a redelivery with the same delivery ID (the dedupe ID) dropped. The body
 * is the job as JSON, as on SQS, so the dispatcher reads both the same way.
 */
export function postgresJobQueue(queue: QueueSender): JobQueue {
  return {
    async send(job, { groupId, dedupeId }) {
      await queue.send({ groupId, dedupeId, body: JSON.stringify(job) });
    },
  };
}

/** The webhook secret from an environment variable, for server.ts and docker compose. */
export function envWebhookSecret(
  name = "GITHUB_WEBHOOK_SECRET",
  env: NodeJS.ProcessEnv = process.env,
): WebhookSecretSource {
  return {
    // Read on every call: there's no network round trip to save, and tests can change it.
    async get() {
      const value = env[name];
      if (value === undefined || value === "") throw new Error(`${name} is not set`);
      return value;
    },
  };
}

/**
 * Logs jobs instead of queueing them. Stands in for the pg-boss queue (NIC-843) so the local
 * server can be pointed at real GitHub deliveries before a worker exists.
 */
export function logJobQueue(log: (line: string) => void = console.log): JobQueue {
  return {
    async send(job, { groupId, dedupeId }) {
      log(JSON.stringify({ msg: "job not queued (log-only queue)", groupId, dedupeId, job }));
    },
  };
}
