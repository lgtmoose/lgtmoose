import { HarnessError, type HarnessResult, type HarnessUsage } from "./harness.js";
import type { ProcessResult } from "./process.js";
import { redact, withheldLines } from "./redact.js";
import type { TranscriptStore } from "./transcript.js";

/**
 * Saves one attempt's stdout with a closing `lgtmoose_harness` line (exit code, signal, why it
 * was stopped, stderr), with every secret redacted, and adds its key to `keys`.
 */
export async function saveAttemptTranscript(
  store: TranscriptStore,
  key: string,
  proc: ProcessResult,
  attempt: number,
  secrets: readonly string[],
  keys: string[],
): Promise<void> {
  const meta = {
    type: "lgtmoose_harness",
    attempt,
    exit_code: proc.exitCode,
    signal: proc.signal,
    stopped: proc.stopped ?? null,
    stderr: proc.stderr,
  };
  const body = withheldLines(
    redact(`${proc.stdout.replace(/\n?$/, "\n")}${JSON.stringify(meta)}\n`, secrets),
    secrets,
  );
  try {
    await store.put(key, body);
  } catch (error) {
    throw new HarnessError("transcript", `Could not save transcript ${key}.`, {
      transcriptKeys: keys,
      cause: error,
    });
  }
  keys.push(key);
}

/** The result of a run whose attempt produced valid output. */
export function success<T>(
  attempt: { output: T; key: string },
  usage: HarnessUsage,
  keys: readonly string[],
): HarnessResult<T> {
  const out: HarnessResult<T> = {
    output: attempt.output,
    transcriptKey: attempt.key,
    transcriptKeys: [...keys],
  };
  if (Object.keys(usage).length > 0) out.usage = usage;
  return out;
}

/** How a process ended, for error messages. */
export function exitText(proc: ProcessResult): string {
  if (proc.signal) return `signal ${proc.signal}`;
  return `code ${proc.exitCode ?? "unknown"}`;
}
