import {
  FINDING_LIMITS,
  bootstrapOutputSchema,
  explanationSchema,
  findingSchema,
  judgementSchema,
  ticketCoverageSchema,
} from "@lgtmoose/core";
import { MODEL_TIERS, transcriptKey } from "@lgtmoose/harness";
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
 * - `runs/<id>/batches/<n>/credential.json`: a ChatGPT sign-in's refreshed `auth.json`, briefly
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
    /** What the post step has posted so far, for a retry to carry on from. */
    posted: `${root}posted.json`,
    /** Written once, before the run's review is posted: the attempt that writes it posts. */
    reviewClaim: `${root}review-claim.json`,
    checkout: `${root}checkout.tar.gz`,
    /**
     * Other reviewers' findings on files the run reviewed that none of ours was near (paths,
     * lines, severities and sources, no comment text): what the bot missed, for the evals.
     */
    misses: `${root}misses.json`,
    /**
     * What the post step decided about the run's judged replies, written once before any of it
     * is acted on, so a retried attempt writes the same replies rather than deciding again.
     */
    replies: `${root}replies.json`,
    batchInput: (index: number) => `${batch(index)}input.json`,
    batchUrls: (index: number) => `${batch(index)}urls.json`,
    batchOutput: (index: number) => `${batch(index)}output.json`,
    /**
     * A ChatGPT sign-in's refreshed `auth.json`, written by the sandbox when Codex refreshed its
     * tokens. The credential broker stores it in the provider's secret and deletes this object.
     */
    batchCredential: (index: number) => `${batch(index)}credential.json`,
    /** Where a transcript key from the harness is stored for this batch. */
    batchTranscript: (index: number, key: string) => `${batch(index)}${key}`,
  };
}

/**
 * Keys shared by every run of a PR at one head, under `runs/heads/`. `repo` is owner/name,
 * lowercased here (GitHub's names are case-insensitive).
 */
export function headKeys(repo: string, prNumber: number, headSha: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Not owner/name: ${repo}`);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("Not a PR number.");
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha)) throw new Error("Not a commit SHA.");
  const root = `${RUN_PREFIX}heads/${repo.toLowerCase()}/${prNumber}/${headSha}/`;
  return {
    /** Held while a run checks the head for our review and submits one, so runs take turns. */
    reviewClaim: `${root}review-claim.json`,
    /**
     * The ticket checker's checklist for one linked ticket at this head, with the ticket's
     * `updatedAt` it was made from: reused by later runs at this head until the ticket changes.
     */
    ticketCoverage: (key: string) => {
      if (!/^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(key)) throw new Error("Not a ticket key.");
      return `${root}tickets/${key}.json`;
    },
    /**
     * The explainer's answer for one finding at this head (or that it was flagged): later
     * `explain`s of the finding at this head reuse it, so the model runs at most once.
     */
    explanation: (findingId: string) => {
      // A row's UUID in the database; any one path segment of plain characters is safe.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(findingId)) {
        throw new Error("Not a finding ID.");
      }
      return `${root}explanations/${findingId}.json`;
    },
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
    /**
     * The part of the prompt every batch of the run shares (`PreparedReview.reviewerSystem`),
     * sent as the harness's `system` so it's prompt-cached. Absent in inputs written before it
     * was split out, whose `prompt` is whole.
     */
    system: z.string().min(1).optional(),
    /**
     * The reviewer provider's model name or alias; empty means the harness's default. A sandbox
     * task runs its own provider's model (`LGTMOOSE_MODEL` on its task definition), which for the
     * reviewer provider is this one, so a batch that falls back to another provider runs that
     * provider's model.
     */
    model: z.string(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(2 * 60 * 60_000),
    /**
     * What the batch runs: the reviewer on a batch of files (the default), the reply judge on
     * one person's reply to a finding (`buildReplyJudgePrompt`), whose output is a `judgement`,
     * the ticket checker on one ticket (`buildTicketCoveragePrompt`), whose output is a
     * `coverage`, the explainer on one finding (`buildExplainPrompt`), whose output is an
     * `explanation`, or the bootstrapper on a batch of a repository's past review comments
     * (`buildBootstrapPrompt`, NIC-1080), whose output is `candidates`.
     */
    role: z.enum(["reviewer", "judge", "ticket", "explain", "bootstrap"]).optional(),
    /**
     * The model tier: the judge runs on `fast`. The sandbox then runs its provider's fast model
     * (`LGTMOOSE_FAST_MODEL`) instead of `model`.
     */
    tier: z.enum(MODEL_TIERS).optional(),
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
    /**
     * For a ChatGPT sign-in: a PUT for the refreshed `auth.json` (`batchCredential`), which the
     * credential broker stores once the task is done.
     */
    credential: httpsUrl.optional(),
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
    /**
     * The reviewer's notes for the cross-file pass, within the soft limits the sandbox cuts them
     * to (`clipBatchNotes` in @lgtmoose/roles). Model output: leads to check, never facts.
     */
    notes: z
      .array(z.string().min(1).max(FINDING_LIMITS.note))
      .max(FINDING_LIMITS.notesPerRun)
      .optional(),
    /** The reply judge's answer, for a judge batch (`BatchInput.role`). Model output. */
    judgement: judgementSchema.optional(),
    /** The ticket checker's checklist, for a ticket batch (`BatchInput.role`). Model output. */
    coverage: ticketCoverageSchema.optional(),
    /** The explainer's answer, for an explain batch (`BatchInput.role`). Model output. */
    explanation: explanationSchema.optional(),
    /**
     * The bootstrapper's candidate learnings, for a bootstrap batch (`BatchInput.role`). Model
     * output: proposals only, which the post step checks and stores as pending.
     */
    candidates: bootstrapOutputSchema.shape.candidates.optional(),
    error: z.string().max(4000).optional(),
    transcriptKeys: z.array(z.string().max(300)).max(TRANSCRIPT_ATTEMPTS),
    usage: usageSchema.optional(),
  })
  .strict()
  .refine(
    (output) =>
      [
        output.findings,
        output.judgement,
        output.coverage,
        output.explanation,
        output.candidates,
        output.error,
      ].filter((part) => part !== undefined).length === 1,
    {
      message:
        "a batch output has exactly one of findings, a judgement, a coverage, an explanation, candidates or an error",
    },
  )
  .refine((output) => output.notes === undefined || output.findings !== undefined, {
    message: "only a batch with findings has notes",
  });

export type BatchOutput = z.infer<typeof batchOutputSchema>;

/**
 * Harness failures that move a batch on to the next provider, as `FallbackHarness` does: limits
 * and auth (the provider can't be used now) and a prompt too large for it (another may take it).
 * Other failures (a timeout, invalid output) would fail the same way elsewhere.
 */
export const FALLBACK_ERROR_KINDS = [
  "rate_limit",
  "plan_limit",
  "auth",
  "input_too_large",
] as const;

/**
 * Whether a batch should be tried on the next provider, from its output as the sandbox wrote it
 * (untrusted: it only picks between trying another provider and stopping). An output that's
 * missing or doesn't validate counts as a failed attempt, so the next provider is tried; one
 * with findings is done; one with an error falls back only for `FALLBACK_ERROR_KINDS`.
 */
export function wantsFallback(outputText: string | undefined): {
  fallback: boolean;
  reason: string;
} {
  if (outputText === undefined) return { fallback: true, reason: "no output" };
  let parsed: ReturnType<typeof batchOutputSchema.safeParse>;
  try {
    parsed = batchOutputSchema.safeParse(JSON.parse(outputText));
  } catch {
    return { fallback: true, reason: "output isn't JSON" };
  }
  if (!parsed.success) return { fallback: true, reason: "output doesn't validate" };
  const { error } = parsed.data;
  if (error === undefined) return { fallback: false, reason: "reviewed" };
  const kind = FALLBACK_ERROR_KINDS.find((name) => error.startsWith(`${name}:`));
  return kind === undefined
    ? { fallback: false, reason: "failed (no fallback for this failure)" }
    : { fallback: true, reason: kind };
}
