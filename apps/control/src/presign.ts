import {
  assertRunId,
  batchTranscriptKeys,
  batchUrlsSchema,
  runKeys,
  type BatchUrls,
} from "@lgtmoose/pipeline";
import { z } from "zod";

/** Presigns one S3 request on the artifact bucket. */
export type Presign = (
  method: "GET" | "PUT",
  key: string,
  expiresInSeconds: number,
) => Promise<string>;

export interface PresignDeps {
  presign: Presign;
  putText(key: string, body: string): Promise<void>;
}

/** What the map state passes for each batch. */
export const presignEventSchema = z
  .object({
    runId: z.string().refine((id) => {
      try {
        assertRunId(id);
        return true;
      } catch {
        return false;
      }
    }, "not a run ID"),
    index: z.number().int().min(0),
  })
  .strict();

export type PresignEvent = z.infer<typeof presignEventSchema>;

/** What the sandbox task gets: one URL, in `LGTMOOSE_BATCH_URLS`. */
export interface PresignResult {
  urls: string;
}

/**
 * Gives one batch's sandbox task its S3 access. The task role has none, so this writes the
 * batch's presigned URLs (read the checkout and input, write the output and transcripts) to
 * `urls.json` and returns a presigned GET for that one object: the whole set would crowd the
 * RunTask overrides' 8 KB limit. Every URL is for this run and batch only.
 */
export async function presignBatch(
  deps: PresignDeps,
  event: PresignEvent,
  expiresInSeconds: number,
): Promise<PresignResult> {
  const { runId, index } = presignEventSchema.parse(event);
  const keys = runKeys(runId);
  const transcripts: Record<string, string> = {};
  for (const key of batchTranscriptKeys(runId, index)) {
    transcripts[key] = await deps.presign(
      "PUT",
      keys.batchTranscript(index, key),
      expiresInSeconds,
    );
  }
  const urls: BatchUrls = batchUrlsSchema.parse({
    checkout: await deps.presign("GET", keys.checkout, expiresInSeconds),
    input: await deps.presign("GET", keys.batchInput(index), expiresInSeconds),
    output: await deps.presign("PUT", keys.batchOutput(index), expiresInSeconds),
    transcripts,
  });
  await deps.putText(keys.batchUrls(index), JSON.stringify(urls));
  return { urls: await deps.presign("GET", keys.batchUrls(index), expiresInSeconds) };
}
