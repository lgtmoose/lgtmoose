import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { presignBatch, type PresignEvent, type PresignResult } from "./presign.js";

/**
 * The presign Lambda: one invocation per batch, from the review state machine's map. Its role
 * may read and write `runs/*` in the artifact bucket and nothing else.
 *
 * URLs signed with the Lambda's temporary credentials stop working when those credentials
 * expire, whatever `expiresIn` says, so a batch should start soon after it's presigned.
 */
const client = new S3Client({});

export async function handler(event: PresignEvent): Promise<PresignResult> {
  const bucket = process.env.ARTIFACT_BUCKET;
  const ttl = Number(process.env.LGTMOOSE_URL_TTL_SECONDS);
  if (!bucket) throw new Error("ARTIFACT_BUCKET is not set.");
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("LGTMOOSE_URL_TTL_SECONDS must be a whole number of seconds.");
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
