import { createHash } from "node:crypto";
import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { JobQueue, WebhookSecretSource } from "../ports.js";

/** The one call each store makes; the real SDK clients satisfy these, tests pass fakes. */
export interface SecretsManagerSender {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}
export interface SqsSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

export interface SecretsManagerWebhookSecretOptions {
  client: SecretsManagerSender;
  /** Name or ARN of a secret whose value is the webhook secret as plain text. */
  secretId: string;
  /** How long a fetched value is reused. */
  ttlMs?: number;
  /**
   * The least time between forced refreshes. A refresh happens on every signature mismatch, so
   * without this a stream of forged deliveries would turn into a Secrets Manager call each.
   */
  minRefreshMs?: number;
  now?: () => number;
}

export const SECRET_TTL_MS = 5 * 60_000;
export const SECRET_MIN_REFRESH_MS = 30_000;

/** The webhook secret from Secrets Manager, cached per Lambda instance. */
export function secretsManagerWebhookSecret(
  options: SecretsManagerWebhookSecretOptions,
): WebhookSecretSource {
  const {
    client,
    secretId,
    ttlMs = SECRET_TTL_MS,
    minRefreshMs = SECRET_MIN_REFRESH_MS,
    now = Date.now,
  } = options;
  // The promise is cached, not the value, so concurrent requests on a cold start share one fetch.
  let cached: { value: Promise<string>; fetchedAt: number } | undefined;

  function fetch(): Promise<string> {
    const value = client.send(new GetSecretValueCommand({ SecretId: secretId })).then((output) => {
      if (output.SecretString === undefined || output.SecretString === "") {
        throw new Error(`secret ${secretId} has no string value`);
      }
      return output.SecretString;
    });
    const entry = { value, fetchedAt: now() };
    cached = entry;
    // Don't cache a failure: the next request tries again.
    value.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return value;
  }

  return {
    get({ refresh = false } = {}) {
      if (cached === undefined) return fetch();
      const age = now() - cached.fetchedAt;
      if (age >= ttlMs || (refresh && age >= minRefreshMs)) return fetch();
      return cached.value;
    },
  };
}

/** SQS caps group and deduplication IDs at 128 characters from this set. */
const FIFO_ID = /^[\w!"#$%&'()*+,\-./:;<=>?@[\\\]^`{|}~]{1,128}$/;

/**
 * A FIFO-safe ID. Real values fit (`owner/repo#123`, a delivery GUID), but an owner and repo
 * name can together pass 128 characters, so anything that doesn't fit is hashed. Hashing is
 * deterministic, so ordering per PR and dedupe per delivery still hold.
 */
export function fifoId(id: string): string {
  return FIFO_ID.test(id) ? id : `sha256-${createHash("sha256").update(id).digest("hex")}`;
}

/**
 * Jobs on the SQS FIFO queue. The deduplication ID is the delivery ID, so SQS drops a
 * redelivery inside its 5-minute window. That's only a first line: GitHub redeliveries can come
 * much later, so the dispatcher dedupes again: it names each review execution after the PR's
 * head, and Step Functions refuses a second execution with the same name.
 */
export function sqsJobQueue(options: { client: SqsSender; queueUrl: string }): JobQueue {
  return {
    async send(job, { groupId, dedupeId }) {
      await options.client.send(
        new SendMessageCommand({
          QueueUrl: options.queueUrl,
          MessageBody: JSON.stringify(job),
          MessageGroupId: fifoId(groupId),
          MessageDeduplicationId: fifoId(dedupeId),
        }),
      );
    },
  };
}
