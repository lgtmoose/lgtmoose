import { findingSchema } from "@lgtmoose/core";
import { transcriptKey } from "@lgtmoose/harness";
import { z } from "zod";

/**
 * What the review workflow's tasks hand each other (NIC-811). The control task's prepare step
 * writes a run's objects under `runs/<run id>/`; a presign Lambda gives each sandbox task
 * presigned URLs for its own batch, because the sandbox role has no S3 access; the post step
 * reads the outputs back.
 *
 * - `runs/<id>/prepared.json`: the run manifest (the `PreparedReview` and its installation), for
 *   the post step
 * - `runs/<id>/checkout.tar.gz`: the PR's checkout (with .git), for the model to read
 * - `runs/<id>/batches/<n>/input.json`: a `BatchInput`
 * - `runs/<id>/batches/<n>/urls.json`: the batch's presigned URLs (`BatchUrls`)
 * - `runs/<id>/batches/<n>/output.json`: a `BatchOutput`, written by the sandbox
 * - `runs/<id>/batches/<n>/transcripts/...`: the batch's run transcripts
 */
export const RUN_PREFIX = "runs/";

/** A run ID is the review run's UUID; nothing else may be used in a key. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`Not a run ID: ${JSON.stringify(runId)}`);
  return runId;
}

function assertIndex(index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Not a batch index: ${index}`);
  return index;
}

/** The S3 keys of one run's objects. */
export function runKeys(runId: string) {
  const root = `${RUN_PREFIX}${assertRunId(runId)}/`;
  const batch = (index: number) => `${root}batches/${assertIndex(index)}/`;
  return {
    prepared: `${root}prepared.json`,
    checkout: `${root}checkout.tar.gz`,
    batchInput: (index: number) => `${batch(index)}input.json`,
    batchUrls: (index: number) => `${batch(index)}urls.json`,
    batchOutput: (index: number) => `${batch(index)}output.json`,
    /** Where a transcript key from the harness is stored for this batch. */
    batchTranscript: (index: number, key: string) => `${batch(index)}${key}`,
  };
}

/** The harness run ID for a batch: its transcripts are grouped under it. */
export function batchRunId(runId: string, index: number): string {
  return `${assertRunId(runId)}-batch-${assertIndex(index)}`;
}

/**
 * How many transcript URLs a batch gets: one per attempt, with room for the harness's repair
 * retry. A run can't write more transcripts than this.
 */
export const TRANSCRIPT_ATTEMPTS = 3;

/** The transcript keys the harness writes for a batch, attempt 1 first. */
export function batchTranscriptKeys(runId: string, index: number): string[] {
  const id = batchRunId(runId, index);
  return Array.from({ length: TRANSCRIPT_ATTEMPTS }, (_, i) => transcriptKey(id, i + 1));
}

/** What a sandbox task reviews: one batch's prompt and how to run it. */
export const batchInputSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().regex(RUN_ID),
    index: z.number().int().min(0),
    prompt: z.string().min(1),
    /** Model name or alias; empty means the harness's default. */
    model: z.string(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(2 * 60 * 60_000),
  })
  .strict();

export type BatchInput = z.infer<typeof batchInputSchema>;

const httpsUrl = z.url({ protocol: /^https$/ });

/** The presigned URLs a sandbox task gets for its batch. */
export const batchUrlsSchema = z
  .object({
    checkout: httpsUrl,
    input: httpsUrl,
    output: httpsUrl,
    /** Transcript key (from the harness) to its presigned PUT URL. */
    transcripts: z.record(z.string(), httpsUrl),
  })
  .strict();

export type BatchUrls = z.infer<typeof batchUrlsSchema>;

const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheWriteTokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * What a sandbox task returns. The post step validates it again: the sandbox ran a model on PR
 * content, so its output is untrusted like any model output.
 */
export const batchOutputSchema = z
  .object({
    version: z.literal(1),
    index: z.number().int().min(0),
    findings: z.array(findingSchema).optional(),
    error: z.string().max(4000).optional(),
    transcriptKeys: z.array(z.string().max(300)).max(TRANSCRIPT_ATTEMPTS),
    usage: usageSchema.optional(),
  })
  .strict()
  .refine((output) => (output.findings === undefined) !== (output.error === undefined), {
    message: "a batch output has either findings or an error",
  });

export type BatchOutput = z.infer<typeof batchOutputSchema>;
