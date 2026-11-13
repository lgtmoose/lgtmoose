import type { z } from "zod";

export interface HarnessRunOptions<T> {
  /** The full task for the model. Sent on stdin, never on the command line. */
  prompt: string;
  /** The checkout to review. The model can read only inside it. */
  cwd: string;
  /** What the model must return. Its output is parsed and validated with this. */
  schema: z.ZodType<T>;
  /** Model name or alias, passed to the CLI as is. */
  model: string;
  /** Deadline for the whole run, the repair retry included. */
  timeoutMs: number;
  /** Groups the transcripts of this run. A random UUID when omitted. */
  runId?: string;
  /**
   * How hard the run should think, for harnesses that map it to a model or reasoning effort
   * (see `MODEL_TIERS`). `model` still wins when the harness gets one.
   */
  tier?: ModelTier;
}

/** Model tiers from the deploy config: cheap and quick, the default, and the strongest. */
export const MODEL_TIERS = ["fast", "standard", "deep"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface HarnessResult<T> {
  output: T;
  usage?: HarnessUsage;
  /** Where the transcript of the attempt that produced `output` was saved. */
  transcriptKey: string;
  /** Every attempt's transcript, in order. More than one after a repair retry. */
  transcriptKeys?: string[];
}

/** Runs one agent CLI on one batch. */
export interface Harness {
  readonly id: string;
  run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>>;
}

/**
 * Why a run failed:
 * - `timeout`: the deadline passed and the process tree was killed.
 * - `invalid_output`: the output failed validation twice, or it contained a credential.
 * - `process`: the CLI failed to start, exited with an error or reported one.
 * - `auth`: no usable model credential, or the model API rejected it.
 * - `transcript`: the run finished but its transcript couldn't be saved.
 * - `rate_limit`: the provider is throttling requests; the same credential works again soon.
 * - `plan_limit`: the plan's usage or spend limit is used up; try another provider.
 *
 * The fallback chain moves to the next provider on `auth`, `rate_limit` and `plan_limit`.
 */
export type HarnessErrorKind =
  "timeout" | "invalid_output" | "process" | "auth" | "transcript" | "rate_limit" | "plan_limit";

/** A failed run. Callers fail the batch. The message never contains a credential. */
export class HarnessError extends Error {
  readonly kind: HarnessErrorKind;
  /** Transcripts saved before the failure, if any. */
  readonly transcriptKeys: readonly string[];
  /** For `rate_limit` and `plan_limit`: how long until the limit resets, when the CLI said. */
  readonly retryAfterSeconds: number | undefined;
  /** For `rate_limit` and `plan_limit`: when the limit resets, as the CLI wrote it. */
  readonly resetsAt: string | undefined;
  /**
   * The CLI refreshed its credential during the run, but handing it back to the credential
   * broker failed (the error). A rotated token may now be lost: alert, the credential may need
   * a new sign-in.
   */
  readonly authHandBackError: unknown;

  constructor(
    kind: HarnessErrorKind,
    message: string,
    options: {
      transcriptKeys?: readonly string[];
      cause?: unknown;
      retryAfterSeconds?: number;
      resetsAt?: string;
      authHandBackError?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.kind = kind;
    this.transcriptKeys = options.transcriptKeys ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.resetsAt = options.resetsAt;
    this.authHandBackError = options.authHandBackError;
  }
}
