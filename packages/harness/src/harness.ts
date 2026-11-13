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
}

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
 */
export type HarnessErrorKind = "timeout" | "invalid_output" | "process" | "auth" | "transcript";

/** A failed run. Callers fail the batch. The message never contains a credential. */
export class HarnessError extends Error {
  readonly kind: HarnessErrorKind;
  /** Transcripts saved before the failure, if any. */
  readonly transcriptKeys: readonly string[];

  constructor(
    kind: HarnessErrorKind,
    message: string,
    options: { transcriptKeys?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.kind = kind;
    this.transcriptKeys = options.transcriptKeys ?? [];
  }
}
