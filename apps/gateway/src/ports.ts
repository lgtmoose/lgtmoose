import type { ReviewJob } from "@lgtmoose/core";

/**
 * What the gateway needs from its host, kept free of any cloud SDK so the same webhook code runs
 * on Lambda (adapters/aws.ts) and as a plain Node server (adapters/local.ts).
 */

/**
 * Where the GitHub webhook secret comes from. Read-only on purpose, and named for its one job so
 * it isn't confused with the CLI's secret writer (apps/cli/src/setup/secret-store.ts).
 */
export interface WebhookSecretSource {
  /**
   * The current secret. `refresh` asks for a fresh copy instead of a cached one; the gateway
   * asks once after a signature mismatch, so a rotated secret works without a redeploy.
   */
  get(options?: { refresh?: boolean }): Promise<string>;
}

export interface SendOptions {
  /** Jobs with the same group are delivered in order: one group per PR. */
  groupId: string;
  /** A repeat with the same ID is dropped. The gateway uses GitHub's delivery ID. */
  dedupeId: string;
}

/** Where verified, normalised jobs go for the dispatcher. */
export interface JobQueue {
  send(job: ReviewJob, options: SendOptions): Promise<void>;
}
