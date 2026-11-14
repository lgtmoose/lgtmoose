import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient } from "@aws-sdk/client-sfn";
import { runKeys } from "@lgtmoose/pipeline";
import {
  acquireLease,
  brokerEventSchema,
  releaseLease,
  type BrokerDeps,
  type HeldLease,
} from "./credentials.js";
import {
  credentialsFromEnv,
  executionRunning,
  logLine,
  reportProblem,
  secretsManagerCredentials,
} from "./credentials-aws.js";
import { s3ArtifactStore } from "./s3-store.js";

const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});
const sfn = new SFNClient({});

function deps(): BrokerDeps {
  const bucket = process.env.ARTIFACT_BUCKET;
  if (!bucket) throw new Error("ARTIFACT_BUCKET is not set.");
  const ttl = Number(process.env.LGTMOOSE_LEASE_TTL_SECONDS);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("LGTMOOSE_LEASE_TTL_SECONDS must be a whole number of seconds.");
  }
  return {
    store: s3ArtifactStore(s3, bucket),
    secrets: secretsManagerCredentials(secrets),
    executionRunning: executionRunning(sfn),
    credentials: credentialsFromEnv(process.env),
    leaseTtlMs: ttl * 1000,
    now: Date.now,
    newToken: randomUUID,
    random: Math.random,
    audit: (event, fields) => logLine(event, { audit: true, ...fields }),
    problem: reportProblem,
  };
}

/**
 * The credential broker Lambda, called by the review state machine around each sandbox task:
 * `acquire` before it (a lease, or `Lgtmoose.CredentialBusy` to wait), `release` after it,
 * whether it worked or not. See credentials.ts.
 */
export async function handler(event: unknown): Promise<HeldLease | { released: true }> {
  const parsed = brokerEventSchema.parse(event);
  const broker = deps();
  if (parsed.action === "acquire") return acquireLease(broker, parsed);
  const output = await broker.store.getTagged(runKeys(parsed.runId).batchOutput(parsed.index));
  await releaseLease(broker, parsed, output?.text);
  return { released: true };
}
