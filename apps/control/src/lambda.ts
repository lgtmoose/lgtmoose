import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import {
  checkOutcome,
  presignBatch,
  type OutcomeEvent,
  type PresignEvent,
  type PresignResult,
} from "./presign.js";

/**
 * The presign Lambda: one invocation per batch attempt, from the review state machine's map.
 * It signs with the presigner role, assumed for a fixed session, never its own credentials:
 * a URL signed with temporary credentials stops working when they expire, and a warm
 * function's own may be minutes from that. The presigner role may read and write `runs/*` in
 * the artifact bucket and nothing else.
 */
const sts = new STSClient({});

/** Time a URL needs beyond its TTL on the credentials it's signed with. */
const MARGIN_MS = 60_000;

interface SessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

let cached: SessionCredentials | undefined;

/** Credentials that outlive a URL signed now with `ttlSeconds`, assuming the role when needed. */
export async function presignerCredentials(
  roleArn: string,
  sessionSeconds: number,
  ttlSeconds: number,
  assume: (input: { roleArn: string; sessionSeconds: number }) => Promise<SessionCredentials> = (
    input,
  ) => assumeRole(input),
  now: () => number = Date.now,
): Promise<SessionCredentials> {
  if (ttlSeconds * 1000 + MARGIN_MS > sessionSeconds * 1000) {
    throw new Error(
      `A ${ttlSeconds} s URL can't be signed with a ${sessionSeconds} s session; lower the TTL.`,
    );
  }
  const needed = now() + ttlSeconds * 1000 + MARGIN_MS;
  if (cached === undefined || cached.expiration.getTime() < needed) {
    cached = await assume({ roleArn, sessionSeconds });
  }
  return cached;
}

/** Forgets cached credentials; for tests. */
export function resetPresignerCredentials(): void {
  cached = undefined;
}

async function assumeRole(input: {
  roleArn: string;
  sessionSeconds: number;
}): Promise<SessionCredentials> {
  const reply = await sts.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn,
      RoleSessionName: "lgtmoose-presign",
      DurationSeconds: input.sessionSeconds,
    }),
  );
  const c = reply.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
    throw new Error("AssumeRole returned no credentials for the presigner role.");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
}

function wholeSeconds(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a whole number of seconds.`);
  }
  return value;
}

/** S3's "no such key", which a missing batch output is. */
function isMissing(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

/**
 * Two calls per batch attempt from the map: presign its URLs (`presignBatch`), and after the
 * attempt, check its output for whether to try the next provider (`checkOutcome`). Both use the
 * presigner role, which may read `runs/*`.
 */
export async function handler(
  event: PresignEvent | OutcomeEvent,
): Promise<PresignResult | { fallback: boolean }> {
  const bucket = process.env.ARTIFACT_BUCKET;
  const roleArn = process.env.LGTMOOSE_PRESIGNER_ROLE_ARN;
  if (!bucket) throw new Error("ARTIFACT_BUCKET is not set.");
  if (!roleArn) throw new Error("LGTMOOSE_PRESIGNER_ROLE_ARN is not set.");
  const ttl = wholeSeconds("LGTMOOSE_URL_TTL_SECONDS");
  const session = wholeSeconds("LGTMOOSE_PRESIGNER_SESSION_SECONDS");
  const credentials = await presignerCredentials(roleArn, session, ttl);
  const client = new S3Client({ credentials });
  if ("action" in event) {
    return checkOutcome(
      {
        getText: async (key) => {
          try {
            const reply = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            return await reply.Body?.transformToString("utf8");
          } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
          }
        },
        log: (message, fields) => {
          process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
        },
      },
      event,
    );
  }
  return presignBatch(
    {
      presign: (method, key, expiresIn) =>
        getSignedUrl(
          client,
          method === "GET"
            ? new GetObjectCommand({ Bucket: bucket, Key: key })
            : new PutObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn },
        ),
      putText: async (key, body) => {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: "application/json",
          }),
        );
      },
    },
    event,
    ttl,
  );
}
