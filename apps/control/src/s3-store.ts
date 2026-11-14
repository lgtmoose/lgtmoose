import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactStore } from "./ports.js";
import { errorName } from "./sfn.js";

/**
 * A conditional PutObject: the new ETag, or undefined when the condition failed (412). A 409
 * (another conditional write of the key in flight) throws, for the caller to retry.
 *
 * A 412 can also answer the SDK's own retry of a write S3 already applied. So on a 412 the
 * object is read back: if it holds exactly our body, the write was ours. Callers make bodies
 * unique to the writer (an attempt ID, a write count), so another writer's can't match.
 */
async function conditionalPut(
  client: Pick<S3Client, "send">,
  input: { Bucket: string; Key: string; Body: string; IfNoneMatch?: string; IfMatch?: string },
): Promise<string | undefined> {
  try {
    const reply = await client.send(
      new PutObjectCommand({ ...input, ContentType: "application/json" }),
    );
    if (reply.ETag === undefined) throw new Error(`S3 returned no ETag for ${input.Key}.`);
    return reply.ETag;
  } catch (error) {
    if (errorName(error) !== "PreconditionFailed") throw error;
    const stored = await getTagged(client, input.Bucket, input.Key);
    return stored?.text === input.Body ? stored.etag : undefined;
  }
}

async function getTagged(
  client: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<{ text: string; etag: string } | undefined> {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (object.ETag === undefined) throw new Error(`S3 returned no ETag for ${key}.`);
    return { text: (await object.Body?.transformToString("utf8")) ?? "", etag: object.ETag };
  } catch (error) {
    if (errorName(error) === "NoSuchKey") return undefined;
    throw error;
  }
}

/**
 * The artifact bucket over S3. In a module of its own so the credential broker's Lambda can use
 * it without bundling the control task's database and GitHub code.
 */
export function s3ArtifactStore(client: S3Client, bucket: string): ArtifactStore {
  return {
    async putText(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
    },
    async createText(key, body) {
      return conditionalPut(client, { Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*" });
    },
    async replaceText(key, body, etag) {
      return conditionalPut(client, { Bucket: bucket, Key: key, Body: body, IfMatch: etag });
    },
    getTagged: (key) => getTagged(client, bucket, key),
    async deleteIfMatch(key, etag) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }));
      } catch (error) {
        // Changed or gone since: someone else's now, or no one's.
        const name = errorName(error);
        if (name !== "PreconditionFailed" && name !== "NoSuchKey") throw error;
      }
    },
    async putFile(key, path, contentType) {
      const { size } = await stat(path);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
    },
    async getText(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (await object.Body?.transformToString("utf8")) ?? "";
      } catch (error) {
        if (errorName(error) === "NoSuchKey") return undefined;
        throw error;
      }
    },
  };
}
